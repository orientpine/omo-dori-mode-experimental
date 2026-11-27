import { expect, test } from "bun:test";

import { objectDone } from "../src/done-flow.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { laneOf, T0 } from "./lane-revive-rig.ts";

// Review 9 of #535: a not-done objection written from an old read keeps the revived pane.

test("a not-done objection written from an old read keeps the revived pane", async () => {
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { backend: "herdr" });
    const old = laneOf(state.dir, { status: "done-claimed" });
    await deps.registry.write(old);
    await deps.registry.patch("h3-charsheet", { pane: "hc:t1" }, { relocate: true });
    expect(await objectDone({ ...deps, run: async () => ({ code: 1, out: "", err: "" }) }, old, ["a signal is not live"])).toStartWith("LANE_NOT_DONE h3-charsheet");
    const after = await deps.registry.read("h3-charsheet");
    expect([after?.status, after?.pane]).toEqual(["not-done", "hc:t1"]);
  } finally {
    state.done();
  }
});
