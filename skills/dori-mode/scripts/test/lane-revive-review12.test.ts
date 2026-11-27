import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { closeLane, pauseLane, resumeLane, watchTick } from "../src/done-flow.ts";
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

test("a pause made while a revive starts waits for it, then acts on the new pane: the lane is never paused with its agent left working", async () => {
  // Given: the lead's pause comes in (from outside the revive, as another process would) as the revive types the start line
  const outside = AsyncLocalStorage.snapshot();
  let pausing: Promise<string> | undefined;
  let settled = false;
  const { deps } = reviveRig(state.dir, {
    before: (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || pausing) return;
      pausing = outside(() => pauseLane(deps(T0), laneOf(state.dir, { pane: "hc:t93" }), "owner asked to wait")).then((l) => l.join(" "), (e: unknown) => String(e)).finally(() => (settled = true));
    },
  });
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t93" }));
  // When
  const line = await reviveTarget(deps(T0), "h3-charsheet", "");
  const doneFirst = !settled;
  const paused = await pausing;
  // Then: the revive finished first; the pause then went to hc:t1 (refused there, as no goal reads back in this world)
  expect(line).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  expect(doneFirst).toBe(true);
  expect(paused).toContain("PAUSE_UNVERIFIED h3-charsheet hc:t1");
  const after = await deps(T0).registry.read("h3-charsheet");
  expect(after && statusOf(after)).toBe("working");
});

test("a close made while a revive starts waits for it, then closes the new pane and records the lane closed for good", async () => {
  // Given: a close (from outside the revive, as another process) comes in as the revive types the start line
  const outside = AsyncLocalStorage.snapshot();
  let closing: Promise<boolean> | undefined;
  const { fake, deps } = reviveRig(state.dir, {
    before: (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || closing) return;
      // the close reads the lane as it is then: already in the new pane hc:t1
      closing = outside(async () => { const now = await deps(T0).registry.read("h3-charsheet"); return now ? (await closeLane(deps(T0), now, "done")).closed : false; });
    },
  });
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t95", thread: "none", done: "merged acme/app#1" }));
  // When
  expect(await reviveTarget(deps(T0), "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  expect(await closing).toBe(true);
  await watchTick(deps(T0 + 60_000));
  await watchTick(deps(T0 + 90_000));
  // Then: closed in hc:t1, nothing left running, nothing opened again
  const after = await deps(T0).registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.pane]).toEqual(["closed", "hc:t1"]);
  expect([...fake.terminals.values()].filter((x) => x.state === "live")).toEqual([]);
  expect(fake.calls.filter((c) => c[0] === "run").length).toBe(1);
});

test("a resume made while a paused lane is revived waits for it, then resumes the goal in the new pane or leaves the lane paused", async () => {
  // Given: a paused lane whose goal the pause paused; the lead revives it, and a resume comes in during the start
  const outside = AsyncLocalStorage.snapshot();
  let resuming: Promise<string> | undefined;
  const { deps } = reviveRig(state.dir, {
    before: (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || resuming) return;
      resuming = outside(() => resumeLane(deps(T0), laneOf(state.dir, { pane: "hc:t96", status: "paused", pausedGoal: true }))).then((l) => l.join(" "), (e: unknown) => String(e));
    },
  });
  await deps(T0).registry.write(laneOf(state.dir, { pane: "hc:t96", status: "paused", pausedGoal: true }));
  // When
  expect(await reviveTarget(deps(T0), "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  const resumed = await resuming;
  // Then: the resume went to hc:t1 after the revive; its goal could not be read back there, so the lane stays paused with
  // the goal still owed (never working with its goal left paused)
  expect(resumed).toContain("RESUME_UNVERIFIED h3-charsheet hc:t1");
  const after = await deps(T0).registry.read("h3-charsheet");
  expect([after && statusOf(after), after?.pausedGoal]).toEqual(["paused", true]);
});
