// upstream dori-superagent #131 (https://github.com/sisyphuslabs/dori-superagent/pull/131), with the 1 ms floor of #134
// (https://github.com/sisyphuslabs/dori-superagent/pull/134): a --loop Bun.sleep returns at once for is refused
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("watch commands refuse a --loop that is not a number of minutes, or is under 1 ms, instead of polling back to back", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const invoke = (...args: string[]) =>
      run(["env", "-u", "DORI_LEAD_PANE", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`,
        "DORI_TELEGRAM_TOKEN=123:not-a-real-token", "DORI_TELEGRAM_OWNER_ID=1", "DORI_SLACK_TOKEN=xoxb-not-a-real-token", process.execPath, cli, ...args], { timeoutMs: 10_000 });
    const refused = [
      ["guard", "--loop", "5m"], ["dead-panes", "--loop", "abc"], ["freshness", "--loop", "-1"], ["guard", "--loop", "Infinity"],
      ["guard", "--loop"], ["guard", "--loop", ""], ["guard", "--loop", " "], ["guard", "--loop", "1e-9"], ["freshness", "--loop", "0.00001"],
      ["inbound", "telegram", "--loop", "5m"], ["inbound", "slack", "--loop", "abc"],
    ];
    for (const args of refused) {
      const r = await invoke(...args);
      expect({ args, code: r.code, err: r.err, out: r.out }).toEqual({
        args, code: 1, err: "--loop must be a number of minutes: 0 for one pass, or 1 ms (0.0000167) or more", out: "",
      });
    }
    for (const args of [["guard", "--loop", "0"], ["guard"]]) {
      const r = await invoke(...args);
      expect(r.code).toBe(0);
      expect(r.out).toStartWith("HOST_GUARD_READY");
    }
  } finally { state.done(); }
}, 120_000);
