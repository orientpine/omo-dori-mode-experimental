import { expect, test } from "bun:test";
import { join } from "node:path";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { run } from "../src/run.ts";

test("writes exactly one SAME_FIX_3 line when the CLI records three identical fixes", async () => {
  // Given
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(0), state.dir);
    await deps.registry.write({ key: "test-fix", title: "test", thread: "none", brief: "", done: "", openedAt: new Date(0).toISOString() });
    const config = join(state.dir, "config.json");
    await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: deps.config.watchLog }));
    // When
    for (let i = 0; i < 3; i++) {
      const result = await run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), "fix-attempt", "test-fix", "--metric", "latency", "--hypothesis", "cache"]);
      expect(result.code).toBe(0);
      expect(result.out.includes("SAME_FIX_3")).toBe(i === 2);
    }
    // Then
    const lines = (await Bun.file(deps.config.watchLog).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+ fix-attempt SAME_FIX_3 test-fix /);
  } finally {
    state.done();
  }
});
