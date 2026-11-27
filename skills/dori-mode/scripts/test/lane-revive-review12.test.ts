import { afterEach, beforeEach, expect, test } from "bun:test";

import { watchTick } from "../src/done-flow.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { Registry, statusOf } from "../src/registry.ts";
import { withState } from "./fakes.ts";
import { laneOf, reviveRig, T0 } from "./lane-revive-rig.ts";

// Review 12 of #535: a record read before a revive and written back after the lane was closed never opens it again, and
// the watch's own revive gives way to a pause made while its new terminal was being made.
let state: ReturnType<typeof withState>;
const saved = process.env["DORI_RUNTIME"];
beforeEach(() => {
  state = withState();
  process.env["DORI_RUNTIME"] = "hc";
});
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
  state.done();
});

test("an old read written back after a revive and a close keeps the lane closed", async () => {
  // Given: the watch read the claim in hc:t27; a revive moved it to hc:t1; a close then closed it there
  const registry = new Registry(state.dir);
  await registry.write(laneOf(state.dir, { status: "done-claimed" }));
  const stale = await registry.read("h3-charsheet");
  await registry.patch("h3-charsheet", { pane: "hc:t1" }, { relocate: true });
  const at = new Date(T0).toISOString();
  await registry.patch("h3-charsheet", { status: "closed", closedAt: at });
  // When: the watch writes its old read back
  await registry.write({ ...(stale ?? laneOf(state.dir)), claim: { at, evidence: "x", emitted: true } });
  // Then: still closed, in hc:t1
  const after = await registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.closedAt, after?.pane]).toEqual(["closed", at, "hc:t1"]);
});

test("the watch's revive gives way to a pause made while the new terminal is made; a manual revive still runs", async () => {
  // Given: the lane is paused just as the watch's revive asks hc for the new terminal
  let paused = false;
  const { fake, deps } = reviveRig(state.dir, {
    before: async (argv) => {
      if (argv[0] === "hc" && argv[2] === "run" && !paused) {
        paused = true;
        await deps(T0).registry.patch("h3-charsheet", { status: "paused" });
      }
    },
  });
  await deps(T0).registry.write(laneOf(state.dir));
  await watchTick(deps(T0));
  // When: the confirming tick revives
  const out = (await watchTick(deps(T0 + 30_000))).filter((l) => /^(LANE_|REVIVE_)/.test(l));
  // Then: nothing starts, the record stays paused in the gone pane
  expect(out.some((l) => l.startsWith("LANE_REVIVED"))).toBe(false);
  expect(fake.sent.length).toBe(0);
  const after = await deps(T0).registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.pane]).toEqual(["paused", "hc:t27"]);
  // and the lead's own dori revive of the paused lane opens it
  expect(await reviveTarget(deps(T0), "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet");
});
