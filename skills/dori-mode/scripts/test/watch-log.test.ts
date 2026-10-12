import { expect, test } from "bun:test";
import { join } from "node:path";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { run } from "../src/run.ts";
import { parseWatchLine } from "../src/watch-log.ts";

test("writes exactly one STUCK line, the old SAME_FIX_3 name at its end, when the CLI records three identical fixes; an old config key still works with a warning", async () => {
  // Given
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(0), state.dir);
    await deps.registry.write({ key: "test-fix", title: "test", thread: "none", brief: "", done: "", openedAt: new Date(0).toISOString() });
    const config = join(state.dir, "config.json");
    // explore.hypothesesFrom is the old name of stuck.hypothesesAt
    await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: deps.config.watchLog, explore: { hypothesesFrom: 99 } }));
    // When (the hypotheses gate is off here; explore.test.ts covers it)
    for (let i = 0; i < 3; i++) {
      const result = await run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), "fix-attempt", "test-fix", "--metric", "latency", "--hypothesis", "cache"]);
      expect(result.code).toBe(0);
      expect(result.err).toContain(`CONFIG_OLD_KEY explore.hypothesesFrom -> stuck.hypothesesAt; rename it in the config (${config})`);
      expect(result.out.includes("SAME_FIX_3")).toBe(i === 2);
    }
    // Then
    const lines = (await Bun.file(deps.config.watchLog).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+ stuck STUCK test-fix "latency" rung 4 \(tagged 3, inferred 0, hypotheses 1, fixated\) .*\[ROLLOVER_DUE SAME_FIX_3\]$/);
  } finally {
    state.done();
  }
});

test("a watch-log line reads back as time, source, kind, key and detail; a line without a time is no line", () => {
  expect(parseWatchLine("2026-10-11T09:00:00.000Z freshness NUDGED demo 16 min silent")).toEqual({ at: "2026-10-11T09:00:00.000Z", source: "freshness", kind: "NUDGED", key: "demo", detail: "16 min silent" });
  expect(parseWatchLine("2026-10-11T09:00:00Z dori-lanes LANE_WATCH_READY")).toEqual({ at: "2026-10-11T09:00:00Z", source: "dori-lanes", kind: "LANE_WATCH_READY", key: "", detail: "" });
  expect(parseWatchLine("WARN something broke")).toBeUndefined();
});
