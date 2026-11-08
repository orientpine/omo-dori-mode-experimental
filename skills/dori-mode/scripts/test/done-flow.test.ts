import { afterEach, beforeEach, expect, test } from "bun:test";
import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { SUBMIT_TIMING } from "../src/submit.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { appendRollover, readRollovers } from "../src/rollover.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

const MIN = 60_000;

const SUMMARY = "The demo page works now. Nothing is left.";

const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123", SUMMARY);
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines).toEqual(["CLOSE_SUMMARY demo-lane from the lane", "COST demo-lane tokens=unknown costUsd=unknown", expect.stringMatching(/^LANE_CLOSED demo-lane /)]);
  // the lane's pane is all its tab holds, so the tab closes (aoe.ts closeAoeSession for a herdr pane)
  expect(closedVia()).toEqual([["herdr", "tab", "close", "w:t-p1"]]);
  // the owner's thread gets the lane's summary for him; the claim's evidence stays in the lane's record
  expect(world.calls).toContainEqual(["notify", "chat:team/123", SUMMARY]);
  expect(world.calls.some((c) => c[0] === "notify" && c[2]?.includes("abc123"))).toBe(false);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(after?.history?.at(-1)?.note).toBe("Done: merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

const stuckMove = (key: string, atIso: string, rung = 4) =>
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: atIso, key, from: "w:p0", to: "w:p1", approvedBy: "auto:handover.autoRolloverLanes", decidedBy: "auto", signals: { stuck: { metric: "dori review #9", n: 4, rung } }, steps: [], result: "done", reasons: [] });

test("a lane moved for being stuck claims done only with its one outcome line, which lands in the rollover log", async () => {
  // Given: the lane's session came from a stuck (rung 4) rollover
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  // When it claims without the line, nothing is recorded and it is told what to add
  const refused = await claimDone(at(T0), lane, "merged acme/app#1");
  expect(refused).toStartWith("ROLLOVER_OUTCOME_MISSING demo-lane: this lane moved to a new session at 2026-01-01T11:30:00.000Z while stuck on \"dori review #9\" (4 attempts)");
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).not.toBe("done-claimed");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome")).toEqual([]);
  // When it claims with the line
  const out = await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "split the review fix\ninto two PRs", resolved: true } });
  // Then the claim stands and the line names that rollover, on one line
  expect(out).toContain("LANE_DONE_CLAIMED demo-lane");
  expect(out).toContain("ROLLOVER_OUTCOME demo-lane resolved (rollover 2026-01-01T11:30:00.000Z): split the review fix into two PRs");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome")).toEqual([{ kind: "outcome", at: "2026-01-01T12:00:00.000Z", key: "demo-lane", rolloverAt: "2026-01-01T11:30:00.000Z", resolved: true, line: "split the review fix into two PRs", by: "claim-done" }]);
  // and a claim again (after an objection) is not asked a second time
  expect(await claimDone(at(T0 + MIN), lane, "merged acme/app#1")).toStartWith("LANE_DONE_CLAIMED demo-lane");
});

test("a lane whose move did not solve it says so; a lane never moved for being stuck is not asked", async () => {
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "same block; scoped the PR down instead", resolved: false } });
  expect(readRollovers(state.dir).find((e) => e.kind === "outcome")).toMatchObject({ resolved: false, line: "same block; scoped the PR down instead" });
  // a rung 3 move (or none) asks nothing
  const other: Lane = { ...lane, key: "other-lane", pane: "w:p2" };
  await at(T0).registry.write(other);
  stuckMove("other-lane", "2026-01-01T11:40:00.000Z", 3);
  expect(await claimDone(at(T0), other, "merged acme/app#3")).toBe("LANE_DONE_CLAIMED other-lane w:p2 merged acme/app#3");
});

test("only the move that started the current session is asked about: an earlier stuck move followed by another move is not", async () => {
  // Given two stuck moves, the newer one answered: a claim again is not asked about the older one
  stuckMove("demo-lane", "2026-01-01T11:00:00.000Z");
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "second session split the PR", resolved: true } });
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome").map((e) => e.kind === "outcome" && e.rolloverAt)).toEqual(["2026-01-01T11:30:00.000Z"]);
  expect(await claimDone(at(T0 + MIN), lane, "merged acme/app#1")).toStartWith("LANE_DONE_CLAIMED demo-lane");
  // Given a stuck move followed by a context move: the claim is not asked and the stuck move gets no credit
  const other: Lane = { ...lane, key: "other-lane", pane: "w:p2" };
  await at(T0).registry.write(other);
  stuckMove("other-lane", "2026-01-01T11:00:00.000Z");
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-01-01T11:40:00.000Z", key: "other-lane", from: "w:p1", to: "w:p2", signals: { contextPct: 90 }, steps: [], result: "done", reasons: [] });
  expect(await claimDone(at(T0), other, "merged acme/app#3")).toBe("LANE_DONE_CLAIMED other-lane w:p2 merged acme/app#3");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome" && e.key === "other-lane")).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1", SUMMARY);
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled.at(-1)).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("the close refuses a PR of a gated repo merged without dori merge, even after an earlier claim", async () => {
  const gated = depsFor(world, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] }, mergeGate: { ...at(T0).config.mergeGate, repos: { "acme/app": "2026-01-01T10:00:00Z" } } });
  const r = await closeLane(gated, lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines).toContainEqual(expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#1: merged at 2026-01-01T11:00:00Z without dori merge/));
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("text still sitting in the pane input after a poll window gets one more Enter", async () => {
  world.stuckReads = SUBMIT_TIMING.clearPolls;
  expect(await sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr", agentCommand: ["claude", "{prompt}"] }, "w:p1", "[LEAD] stuck text still here")).toBe(true);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(2);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr" }, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});
