import { afterEach, beforeEach, expect, test } from "bun:test";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { syncRegistry } from "../src/sync.ts";
import type { Runner } from "../src/run.ts";
import { FakeHc, type FakeTerminal, terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// With config.workspaces set, the sweeps watch only those groups, and an hc lane counts in its dori.group (dori-superagent
// issue #196 and PR #198 reproduced here (SUL-1.0: NOTICE): https://github.com/sisyphuslabs/dori-superagent/pull/198). hc names
// a session's group only when it is listed by that group; the fork's listPanes lists each watched group by name (review 1
// of #404), so these pin dead-panes and sync end to end on it.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const saved = process.env["DORI_RUNTIME"];

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  delete process.env["DORI_RUNTIME"];
  state = withState();
  world = newWorld();
});
afterEach(() => {
  state.done();
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
});

// an hc Dori: hc calls answered by the fake hc binary over these terminals, the rest by the shared fake world
const onHc = (terminals: Record<string, FakeTerminal>) => {
  const fake = new FakeHc(terminals);
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", workspaces: ["lanes"] });
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "hc") return deps.run(argv, opts);
    const r = await fake.exec("hc", argv.slice(1));
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return { ...deps, run };
};

test("with workspaces set, herdr panes are still filtered by their workspace", async () => {
  world.panes = [
    { pane_id: "w:p1", workspace_id: "w" },
    { pane_id: "x:p2", workspace_id: "x" },
  ];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "herdr", workspaces: ["w"] });
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE w:p1"]);
});

test("with workspaces set, hc lanes in a watched dori.group are reported and the others are not (#196)", async () => {
  const stopped = { status: null, foreground: null, screen: "omo has stopped\n$ " };
  const terminals = {
    t1: hcTerm({ ...stopped, labels: { "dori.group": "lanes" } }),
    t2: hcTerm({ ...stopped, labels: { "dori.group": "other" } }),
  };
  const deps = onHc(terminals);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE hc:t1"]);
});

test("with workspaces set, sync lists an unregistered hc agent in a watched dori.group and skips the others", async () => {
  const omo = { name: "omo", argv: ["omo"], pid: 4242 };
  const deps = onHc({
    t1: hcTerm({ foreground: omo, labels: { "dori.group": "lanes" } }),
    t2: hcTerm({ foreground: omo, labels: { "dori.group": "other" } }),
  });
  const { unregistered } = await syncRegistry(deps, false);
  expect(unregistered.map((row) => row.pane)).toEqual(["hc:t1"]);
});
