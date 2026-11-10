import { expect, test } from "bun:test";
import { join } from "node:path";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { withState } from "./fakes.ts";

// #180: the actual command owns once-per-process warnings, which adapter tests cannot exercise.
// Dropping warn wiring, moving its Set inside the tick, or aborting on a bot refusal breaks this real CLI witness.
test("real Slack CLI preserves long text and context while warning once across two polls", async () => {
  const state = withState();
  const longText = `${"x".repeat(210)} complete tail`;
  const methods: string[] = [];
  let rootReads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.slice(1);
      methods.push(method);
      switch (method) {
        case "auth.test": return Response.json({ ok: true, user_id: "U_DORI" });
        case "subscriptions.thread.getView":
        case "client.counts": return Response.json({ ok: false, error: "not_allowed_token_type" });
        case "conversations.replies": {
          if (req.headers.get("content-type") !== "application/x-www-form-urlencoded; charset=utf-8") {
            return Response.json({ ok: false, error: "invalid_arguments" });
          }
          const p = new URLSearchParams(await req.text());
          if (p.get("limit") === "1") {
            rootReads++;
            return Response.json({ ok: true, messages: [{ ts: "1.1", user: "U_OWNER", text: "root question" }] });
          }
          return Response.json({ ok: true, messages: p.get("oldest") === "1.1" ? [{ ts: "2.1", user: "U_OWNER", text: longText }] : [] });
        }
        default: return Response.json({ ok: false, error: "unexpected_method" });
      }
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await Bun.write(join(state.dir, "config.json"), "{}");
    await Bun.write(join(state.dir, "dori.env"), "");
    const ledgerFile = join(state.dir, "slack-threads.json");
    await new ThreadLedger(ledgerFile).record("C1", "1.1", "1.1");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DORI_")));
    child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "slack-inbound-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "inbound", "slack", "--loop", "1"], {
      cwd: state.dir,
      env: { ...env, HOME: state.dir, DORI_CONFIG: join(state.dir, "config.json"), DORI_ENV_FILE: join(state.dir, "dori.env"), DORI_STATE_DIR: state.dir, DORI_SLACK_TOKEN: "xoxb-fake", DORI_SLACK_API: server.url.toString().replace(/\/$/, "") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 20_000, killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(out);
    expect({ code, err, signal: child.signalCode }).toEqual({ code: 0, err: "", signal: null });
    expect(out).toContain("TEST_TICKS 2");
    const lines = out.trim().split("\n");
    expect(lines.filter((line) => line.startsWith("INBOUND "))).toEqual([
      `INBOUND own-thread C1 1.1 2.1 U_OWNER ${JSON.stringify(longText)} root=${JSON.stringify({ channel: "C1", rootTs: "1.1", user: "U_OWNER", text: "root question" })} recent=[]`,
    ]);
    const warnings = lines.filter((line) => line.startsWith("WARN "));
    expect(warnings).toHaveLength(2);
    for (const method of ["subscriptions.thread.getView", "client.counts"]) {
      expect(warnings.filter((line) => line.startsWith(`WARN slack ${method}: not_allowed_token_type`))).toHaveLength(1);
      expect(methods.filter((called) => called === method)).toHaveLength(2);
    }
    expect(methods.filter((method) => method === "conversations.replies")).toHaveLength(3);
    expect(rootReads).toBe(1);
    expect(await new ThreadLedger(ledgerFile).list()).toEqual([{ channel: "C1", rootTs: "1.1", seenTs: "2.1" }]);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await server.stop(true);
    state.done();
  }
});
