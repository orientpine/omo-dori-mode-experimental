import { expect, test } from "bun:test";

import { objectDone } from "../src/done-flow.ts";
import { recordMove } from "../src/lane-lifecycle.ts";
import { Registry } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { laneOf, SESSION, T0 } from "./lane-revive-rig.ts";

// Review 9 of #535: an old read written back after two revives, or as a not-done objection, keeps the revived pane; a
// handover to a reused terminal number (a new session) is not held back.
const at = (ms: number) => new Date(ms).toISOString();
const move = (dir: string, from: string, to: string) => recordMove(dir, { key: "h3-charsheet", session: SESSION, from, to, at: at(T0) });

test("an old read naming the first pane, written back after two revives, keeps the pane the lane runs in now", async () => {
  const state = withState();
  try {
    const registry = new Registry(state.dir);
    const old = laneOf(state.dir, { pane: "hc:t27" });
    await registry.write({ ...old, pane: "hc:t3" });
    move(state.dir, "hc:t27", "hc:t2");
    move(state.dir, "hc:t2", "hc:t3");
    await registry.write(old);
    expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t3");
    // a handover that lands in a terminal hc numbered like the first pane runs a new session: it moves the lane
    await registry.write({ ...old, session: "77777777-2222-4333-8444-555555555555" });
    expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t27");
  } finally {
    state.done();
  }
});

test("a not-done objection written from an old read keeps the revived pane", async () => {
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { backend: "herdr" });
    const old = laneOf(state.dir, { status: "done-claimed" });
    await deps.registry.write({ ...old, pane: "hc:t1" });
    move(state.dir, "hc:t27", "hc:t1");
    expect(await objectDone({ ...deps, run: async () => ({ code: 1, out: "", err: "" }) }, old, ["a signal is not live"])).toStartWith("LANE_NOT_DONE h3-charsheet");
    const after = await deps.registry.read("h3-charsheet");
    expect([after?.status, after?.pane]).toEqual(["not-done", "hc:t1"]);
  } finally {
    state.done();
  }
});
