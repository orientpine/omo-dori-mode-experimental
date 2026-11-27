import { afterEach, beforeEach, expect, test } from "bun:test";

import { pauseLane, watchTick } from "../src/done-flow.ts";
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
  // its own pane: dori watch keeps the first not-live time of each pane in memory, shared by every test file in one run
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t91" }));
  await watchTick(deps(T0));
  // When: the confirming tick revives
  const out = (await watchTick(deps(T0 + 30_000))).filter((l) => /^(LANE_|REVIVE_)/.test(l));
  // Then: nothing starts, the record stays paused in the gone pane
  expect(out.some((l) => l.startsWith("LANE_REVIVED"))).toBe(false);
  expect(fake.sent.length).toBe(0);
  const after = await deps(T0).registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.pane]).toEqual(["paused", "hc:t91"]);
  // and the lead's own dori revive of the paused lane opens it
  expect(await reviveTarget(deps(T0), "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet");
});

test("a lane closed after a revive stays closed when a read taken after the revive is written back, and no death tick opens it", async () => {
  // Given: revived into hc:t1, then the watch reads it, then a close closes it in hc:t1
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir, { pane: "hc:t92", status: "done-claimed" }));
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  const read = await d.registry.read("h3-charsheet");
  const at = new Date(T0).toISOString();
  await d.registry.patch("h3-charsheet", { status: "closed", closedAt: at });
  fake.terminals.clear();
  // When: the watch writes its read back, then two death ticks run
  await d.registry.write({ ...(read ?? laneOf(state.dir)), claim: { at, evidence: "x", emitted: true } });
  await watchTick(deps(T0 + 60_000));
  await watchTick(deps(T0 + 90_000));
  // Then
  const after = await d.registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.closedAt]).toEqual(["closed", at]);
  expect(fake.calls.filter((c) => c[0] === "run").length).toBe(1);
});

test("a pause after the new pane was written reads that pane: unless its agent's goal is paused there, the pause is refused and the lane runs on", async () => {
  // Given: the lead pauses the lane, with a read naming the gone pane, as the revive types the agent's start line
  let refused = "";
  const { deps } = reviveRig(state.dir, {
    before: async (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || refused) return;
      refused = await pauseLane(deps(T0), laneOf(state.dir, { pane: "hc:t93" }), "owner asked to wait").then(() => "paused", (e: unknown) => String(e));
    },
  });
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t93" }));
  // When
  const line = await reviveTarget(deps(T0), "h3-charsheet", "");
  // Then: the pause went to hc:t1 and was refused there (no goal read back); the lane works on in hc:t1
  expect(refused).toContain("PAUSE_UNVERIFIED h3-charsheet hc:t1");
  expect(line).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  const after = await deps(T0).registry.read("h3-charsheet");
  expect(after && statusOf(after)).toBe("working");
});

test("a pause recorded after the new pane was written (its goal step found no agent yet) closes that pane: the paused lane runs nothing", async () => {
  let paused = false;
  const { fake, deps } = reviveRig(state.dir, {
    before: async (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || paused) return;
      paused = true;
      await deps(T0).registry.patch("h3-charsheet", { status: "paused" });
    },
  });
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t94" }));
  expect(await reviveTarget(deps(T0), "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: the lane was paused while hc:t1 started");
  expect([...fake.terminals.values()].filter((x) => x.state === "live")).toEqual([]);
  expect((await deps(T0).registry.read("h3-charsheet"))?.status).toBe("paused");
});
