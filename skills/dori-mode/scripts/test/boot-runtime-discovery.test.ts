import { expect, test } from "bun:test";
import { bootCheck } from "../src/boot.ts";
import { runtimesFor } from "../src/run.ts";
import { bootDeps, lane, newWorld } from "./boot-fixtures.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { withState } from "./fakes.ts";

test("a closed herdr lane does not make a retired runtime required after migration to hc", async () => {
  const state = withState();
  try {
    const world = newWorld();
    world.terminals = { t1: hcTerm() };
    const deps = bootDeps(world, state.dir);
    await deps.registry.write(lane("old-herdr", "closed", "w1:p3"));
    await deps.registry.write(lane("hc-live", "working", "hc:t1"));
    let retiredListAttempted = false;
    const run: typeof deps.run = async (argv, opts) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
        retiredListAttempted = true;
        return { code: 1, out: "", err: "server unavailable" };
      }
      return deps.run(argv, opts);
    };
    const result = await bootCheck({ ...deps, run, rts: runtimesFor({ runtime: "hc" }, {}, run, deps.clock), config: { ...deps.config, runtime: "hc", leadPane: "hc:t1", workspaces: [] } });
    expect(result.lines).toContain("PANES lead=hc:t1 leadState=live registeredLive=1 vanished=0 unregistered=0");
    expect(result.lines).toContain("DRIFT n=0");
    expect(result.lines.some((line) => line === "PANES unavailable (session list failed)")).toBe(false);
    expect(result.lines.some((line) => line.startsWith("VANISHED old-herdr"))).toBe(false);
    expect(retiredListAttempted).toBe(true);
    expect(result.exitCode).toBe(0);
  } finally { state.done(); }
});
