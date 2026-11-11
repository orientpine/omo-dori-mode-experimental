import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

test("the real boot CLI exits at its Slack deadline instead of keeping a 60-second retry alive", async () => {
  const state = withState();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== "/auth.test") return Response.json({ ok: false, error: "unexpected_method" });
      requests++;
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "Retry-After": "60", "Content-Type": "application/json" } });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const bin = join(state.dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "herdr"), "#!/bin/sh\nif [ \"$1 $2\" = \"pane list\" ]; then\n  printf '%s\\n' '{\"result\":{\"panes\":[]}}'\n  exit 0\nfi\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(state.dir, "config.json"), JSON.stringify({ stateDir: state.dir, runtime: "herdr", backend: "herdr" }));
    // Slack settings come only from dori.env (#201 review 5)
    writeFileSync(join(state.dir, "dori.env"), `DORI_SLACK_TOKEN=xoxb-fixture\nDORI_SLACK_API=${server.url.toString().replace(/\/$/, "")}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DORI_")));
    child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "boot"], {
      cwd: state.dir,
      env: {
        ...env,
        HOME: state.dir,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        DORI_CONFIG: join(state.dir, "config.json"),
        DORI_ENV_FILE: join(state.dir, "dori.env"),
        DORI_RUNTIME: "herdr",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, signal: child.signalCode, err }).toEqual({ code: 1, signal: null, err: "" });
    expect(out).toContain("SLACK auth.test timed out after 10000 ms");
    expect(out).toContain("BOOT incomplete read-only; nothing restarted, written or stopped");
    expect(requests).toBe(1);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await server.stop(true);
    state.done();
  }
}, 20_000);
