import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { withStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";
import { laneOf, reviveRig, T0 } from "./lane-revive-rig.ts";

// Review 5 of #535: an interrupted handover (its journal left for repair, its owner dead) moves the lane itself, so a
// revive opens nothing; a record read before a revive and written back after it keeps the revived pane.
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

test("a lane whose interrupted handover left its journal (owner dead) is not revived: the repair moves it", async () => {
  // Given: the pending journal of a handover whose process is gone
  const dir = join(state.dir, "handover", "lanes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "h3-charsheet.pending.json"), JSON.stringify({ key: "h3-charsheet", pid: 2_147_483_000, from: "hc:t27", to: "hc:t9", at: new Date(T0).toISOString() }));
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  // When / Then
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: an interrupted handover of the lane is left in");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

test("a record read before a revive and written back after it keeps the revived pane, so the close then takes that pane down", async () => {
  // Given: the watch read the done-claimed lane in hc:t27 before a revive moved it to hc:t1
  const snapshot = laneOf(state.dir, { thread: "none", done: "merged acme/app#1", status: "done-claimed" });
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(snapshot);
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  // When: its settle writes verified-done from that old read, then closes the lane
  const verified = withStatus(snapshot, "verified-done", "Done signals read back live", new Date(T0).toISOString());
  await d.registry.write(verified);
  expect((await d.registry.read("h3-charsheet"))?.pane).toBe("hc:t1");
  expect((await closeLane(d, verified, "done")).closed).toBe(true);
  // Then: the revived terminal is closed with the lane, and the record says where it was
  expect([...fake.terminals.values()].filter((x) => x.state === "live")).toEqual([]);
  expect((await d.registry.read("h3-charsheet"))?.pane).toBe("hc:t1");
});
