import { expect, test } from "bun:test";
import { bootCheck } from "../src/boot.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hcCoreRunning, runtimesFor } from "../src/run.ts";
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
    expect(retiredListAttempted).toBe(false);
    expect(result.exitCode).toBe(0);
  } finally { state.done(); }
});

// Any hc call starts a stopped core, so boot never calls hc for a core that is not running (review 9 of #436).
const hcCalls = (deps: ReturnType<typeof bootDeps>) => {
  const calls: string[][] = [];
  const run: typeof deps.run = async (argv, opts) => {
    if (argv[0] === "hc") calls.push([...argv]);
    return deps.run(argv, opts);
  };
  return { calls, run };
};

test("a stopped hc core referenced only by closed lanes is left stopped", async () => {
  const state = withState();
  try {
    const deps = bootDeps(newWorld(), state.dir);
    await deps.registry.write(lane("old-hc", "closed", "hc:t5"));
    const { calls, run } = hcCalls(deps);
    const result = await bootCheck({ ...deps, run, hcCoreUp: () => false, rts: runtimesFor({ runtime: "herdr" }, {}, run, deps.clock) });
    expect(calls).toEqual([]);
    expect(result.lines).toContain("DRIFT n=0");
    expect(result.lines.some((line) => line.startsWith("PANES unavailable"))).toBe(false);
    expect(result.exitCode).toBe(0);
  } finally { state.done(); }
});

test("an hc core counts as running only while its socket exists", () => {
  const state = withState();
  try {
    const env = { XDG_RUNTIME_DIR: state.dir };
    expect(hcCoreRunning(undefined, env)).toBe(false);
    mkdirSync(join(state.dir, "herdr-core"));
    writeFileSync(join(state.dir, "herdr-core", "dori-b.sock"), "");
    expect(hcCoreRunning(undefined, env)).toBe(false);
    expect(hcCoreRunning("dori-b", env)).toBe(true);
  } finally { state.done(); }
});

test("a required hc runtime whose core is stopped is reported unavailable, not started", async () => {
  const state = withState();
  try {
    const deps = bootDeps(newWorld(), state.dir);
    await deps.registry.write(lane("open-hc", "working", "hc:t5"));
    const { calls, run } = hcCalls(deps);
    const result = await bootCheck({ ...deps, run, hcCoreUp: () => false, rts: runtimesFor({ runtime: "herdr" }, {}, run, deps.clock) });
    expect(calls).toEqual([]);
    expect(result.lines).toContain("PANES unavailable (hc core not running; boot does not start it)");
    expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
    expect(result.exitCode).toBe(1);
  } finally { state.done(); }
});
