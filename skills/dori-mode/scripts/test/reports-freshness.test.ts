// Upstream #30 journal-driven freshness, with this fork's lead-notification policy.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import { Reports } from "../src/reports.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "report-lane",
  title: "reports",
  thread: "chat:team/1",
  pane: "w:p7",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

let state: ReturnType<typeof withState>;
let reports: Reports;
beforeEach(() => {
  state = withState();
  reports = new Reports(state.dir);
});
afterEach(() => state.done());

test("compaction failure stalls immediately and Working resumes progress", () => {
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Working (2s)\n❯ ", T0 + 2 * MIN, 15 * MIN)?.state).toBe("running");
  expect(reports.read(lane.key)?.lastReport?.at).toBe(new Date(T0).toISOString());
});

test("a compaction error left above a later Working line does not keep the lane stalled", () => {
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ retry\nWorking (3s)\n❯ ", T0 + 2 * MIN, 15 * MIN)?.state).toBe("running");
  expect(reports.observe(lane.key, "Working (3s)\nauto-compaction failed\n❯ ", T0 + 3 * MIN, 15 * MIN)?.state).toBe("stalled");
});

test("only a stale idle prompt stalls and repeated observations do not grow the log", () => {
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "❯ ", T0 + MIN, 15 * MIN)?.state).toBe("running");
  expect(reports.observe(lane.key, "❯ ", T0 + 16 * MIN, 15 * MIN)?.state).toBe("stalled");
  reports.observe(lane.key, "❯ ", T0 + 17 * MIN, 15 * MIN);
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(2);
});

test("supervision observation resumes only on Working, not Running", () => {
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "compaction failed\n❯ ", T0 + MIN, 15 * MIN)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Running 2m\n❯ ", T0 + 2 * MIN, 15 * MIN, false)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Working 2m\n❯ ", T0 + 3 * MIN, 15 * MIN, false)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Working 4m\n❯ ", T0 + 4 * MIN, 15 * MIN)?.state).toBe("running");
});

test.each(["blocker", "halted", "done"] as const)("pane activity cannot overwrite a declared %s state", (kind) => {
  reports.report(lane.key, kind, "paused", T0);
  const expected = reports.read(lane.key)?.state;
  reports.observe(lane.key, "Working (25m)\ncompaction failed\n❯ ", T0 + 30 * MIN, 15 * MIN);
  expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
});

test("freshness tells the lead a durable report after it has scrolled off", async () => {
  // Given a report that survives only in the journal.
  const world = newWorld();
  world.screen = "Working (2m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 21 * MIN), state.dir);
  await deps.registry.write({ ...lane, lastNudgeAt: T0 + 20 * MIN });
  reports.report(lane.key, "milestone", "all checks green", T0);
  // When freshness reads it; then the lead, not the owner thread, receives it.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  expect(sent(world).join("\n")).toContain("all checks green");
  expect(world.calls.some((call) => call[0] === "notify")).toBe(false);
});

test("new report time suppresses nudges even when registry lastReplyAt is old", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write(lane);
  reports.report(lane.key, "milestone", "just completed step", T0 + 29 * MIN);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  expect(sent(world).filter((text) => text.includes("[LEAD] your work thread"))).toEqual([]);
});

test("a stalled structured lane alerts once and is not nudged or told again", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 21 * MIN), state.dir);
  await deps.registry.write({ ...lane, thread: "none" });
  reports.report(lane.key, "milestone", "started", T0);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["stalled"]);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
});

test.each(["blocker", "halted", "done", "question"] as const)("a %s report reaches the lead without nudging the lane", async (kind) => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write(lane);
  reports.report(lane.key, kind, "needs the owner", T0);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  expect(sent(world).filter((text) => text.includes("needs the owner"))).toHaveLength(1);
  expect(sent(world).filter((text) => text.includes("[LEAD] your work thread"))).toEqual([]);
});

test("frequent journal reports still reach the lead at most once per postAfterMin", async () => {
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir);
  await deps.registry.write(lane);
  world.screen = "Working (1m)\n❯ ";
  reports.report(lane.key, "milestone", "step one", T0 + 5 * MIN);
  reports.report(lane.key, "milestone", "step two", T0 + 15 * MIN);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  expect(sent(world).join("\n")).toContain("step two");
  reports.report(lane.key, "milestone", "step three", T0 + 30 * MIN);
  clock.at = T0 + 31 * MIN;
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  clock.at = T0 + 41 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  expect(sent(world).filter((text) => text.includes("[DORI] report-lane"))).toHaveLength(2);
  expect(sent(world).join("\n")).toContain("step three");
});

test("a report written in the same millisecond as the last lead note is delivered later once", async () => {
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir);
  await deps.registry.write(lane);
  reports.report(lane.key, "milestone", "step one", T0 + 15 * MIN);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  reports.report(lane.key, "blocker", "needs the owner", T0 + 21 * MIN);
  clock.at = T0 + 45 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["lead-told"]);
  clock.at = T0 + 70 * MIN;
  await freshnessTick(deps, "/home/test");
  expect(sent(world).filter((text) => text.includes("[DORI] report-lane"))).toHaveLength(2);
  expect(sent(world).join("\n")).toContain("needs the owner");
});

test("an adopted lane ignores a journal record and keeps the screen path", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  const { reportProtocol: _, ...adopted } = lane;
  await deps.registry.write(adopted);
  reports.report(lane.key, "blocker", "waiting on review", T0);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["nudged", "no-report"]);
  expect(sent(world).join("\n")).not.toContain("waiting on review");
});

test("structured lanes never fall back to unrelated pane report text", async () => {
  const world = newWorld();
  world.screen = `[REPORT] ${lane.key} | done | example, not durable`;
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write({ ...lane, lastNudgeAt: T0 + 29 * MIN });
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["no-report"]);
  expect(sent(world)).toEqual([]);
});

test("one corrupt journal is reported once and does not stop another lane", async () => {
  const world = newWorld();
  world.screen = "Working (1m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write({ ...lane, key: "bad-lane", pane: "w:p8" });
  await deps.registry.write(lane);
  reports.report("bad-lane", "milestone", "first", T0);
  appendFileSync(reports.path("bad-lane"), "{partial\n");
  reports.report(lane.key, "milestone", "started", T0);
  const first = await freshnessTick(deps, "/home/test");
  expect(first.map((act) => `${act.kind} ${act.lane}`).sort()).toEqual(["journal-error bad-lane", "lead-told report-lane", `nudged ${lane.key}`]);
  expect(first.find((act) => act.kind === "journal-error")?.detail).toContain("reports.jsonl:2:");
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual([]);
});

test("a journal directory is a lane-scoped I/O error and the second lane still reports", async () => {
  const world = newWorld();
  world.screen = "Working (1m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write({ ...lane, key: "bad-lane", pane: "w:p8" });
  await deps.registry.write(lane);
  mkdirSync(reports.path("bad-lane"), { recursive: true });
  reports.report(lane.key, "milestone", "started", T0);
  const acts = await freshnessTick(deps, "/home/test");
  expect(acts.map((act) => `${act.kind} ${act.lane}`).sort()).toEqual(["journal-error bad-lane", "lead-told report-lane", `nudged ${lane.key}`]);
  expect(acts.find((act) => act.kind === "journal-error")?.detail).toContain("EISDIR");
});
