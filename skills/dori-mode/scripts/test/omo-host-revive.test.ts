import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fakes.ts";

// https://github.com/sisyphuslabs/dori-superagent/pull/282: a hosted lane has no terminal agent for `dori revive` to
// restart (dori watch lifts its turn-limit pause), so the command refuses its ref with a line that says so.
test("dori revive refuses a hosted lane ref by name, before any host or terminal call", async () => {
  const state = withState();
  try {
    const configPath = join(state.dir, "config.json");
    await Bun.write(configPath, JSON.stringify({ stateDir: state.dir }));
    const pane = "omo-host:00000000-0000-4000-8000-000000000071";
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, cli, "revive", pane, "--text", "hi"], {
      env: { ...process.env, DORI_CONFIG: configPath, DORI_STATE_DIR: state.dir, DORI_ENV_FILE: join(state.dir, "isolated.env"), PATH: "/nonexistent" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, first: stderr.trim().split(" ").slice(0, 2).join(" ") }).toEqual({ code: 1, stdout: "", first: `REVIVE_REFUSED ${pane}:` });
  } finally { state.done(); }
});
