import { afterEach, beforeEach, expect, test } from "bun:test";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { claimDone } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

const MIN = 60_000;

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lead note that does not reach the lead pane is reported as not told, and the next sweep tries again", async () => {
  // Given a lead pane whose input line keeps the note unsent.
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = "noise\n[REPORT] quiet-lane | milestone | tests green, PR open\n❯ ";
  world.screens["lead:p1"] = "❯ [DORI] quiet-lane: 21 min without a new report";
  expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  // When the sweep tells the lead, and again on the next sweep.
  const first = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  const again = await freshnessTick(deps(T0 + 23 * MIN), "/home/test");
  // Then each says the lead was not told, and the lane stays due.
  expect(first.map((a) => a.kind)).toEqual(["lead-tell-failed"]);
  expect(first[0]?.detail).toContain("did not reach pane lead:p1");
  expect(again.map((a) => a.kind)).toEqual(["lead-tell-failed"]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastAutoReplyAt).toBeUndefined();
});

test("a silent lane with no leadPane configured stays due, so the lead configured later still gets the note for the same silence", async () => {
  // Given a Dori whose leadPane is not set yet (review #339).
  const noLead = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { leadPane: "" });
  await noLead(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | tests green, PR open", lastNudgeAt: T0 + 16 * MIN });
  world.screens["w:p7"] = "working on it\n❯ ";
  // When a sweep finds it silent without a lead, and one after the lead is set, with no new report in between.
  const first = await freshnessTick(noLead(T0 + 21 * MIN), "/home/test");
  const later = await freshnessTick(depsFor(world, fakeClock(T0 + 26 * MIN), state.dir), "/home/test");
  // Then the first says the lead was not told, and the second tells it.
  expect(first.map((a) => [a.kind, a.detail])).toEqual([["lead-tell-failed", "21 min silent; leadPane is not configured"]]);
  expect(later.map((a) => a.kind)).toEqual(["lead-told"]);
  expect(sent(world).filter((t) => t.startsWith("[DORI] quiet-lane: 26 min"))).toHaveLength(1);
});

test("a lane silent past the nudge time is nudged once, then the lead is told once and nothing is posted in its thread", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n\n❯ ";
  expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const told = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(told.map((a) => a.kind)).toEqual(["lead-told"]);
  expect((await freshnessTick(deps(T0 + 40 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  // the owner's thread gets nothing from the sweep, even with a reply hook configured
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  // one nudge to the lane, one note to the lead carrying the report
  expect(sent(world)).toHaveLength(2);
  expect(sent(world)[1]).toBe("[DORI] quiet-lane: 21 min without a new report. Nothing was posted in its thread. If the owner needs to know where it stands, tell him in one plain line. Last report: [REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open");
});

test("a report the lane sent to the lead pane is found there, wrapped lines joined, and a new report resets the silence", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = "working on it\n❯ ";
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first step done\n\n [REPORT] other-lane | done | not ours\n [REPORT] quiet-lane | blocker | CI is red on the\n flaky e2e job, rerunning\n\n❯ ";
  expect(await freshnessTick(deps(T0 + 14 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 28 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const later = await freshnessTick(deps(T0 + 35 * MIN), "/home/test");
  expect(later.map((a) => a.kind)).toEqual(["nudged", "lead-told"]);
  // the raw report goes to the lead pane, and nothing to the owner's thread
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  const toLead = world.calls.find((c) => c[0] === "herdr" && c[2] === "send-text" && c[3] === "lead:p1")?.[4];
  expect(toLead).toContain("[DORI] quiet-lane: 21 min without a new report");
  expect(toLead).toContain("Last report: [REPORT] quiet-lane | blocker | CI is red on the flaky e2e job, rerunning");
  expect(later[1]?.detail).toBe("21 min silent; nothing posted in its thread");
});

// omo runs in tmux's alternate screen (history_size 0): capture-pane -S -3000 returns only the visible rows, and omo's tail
// under a turn (cache wait, stall backstop, TPS, the todo list, the status lines) pushes a report off them. 2026-11-01:
// NO-REPORT for pingpong-analytics every 2 min from 00:22Z to 04:19Z while its reports sat in the lead's transcript.
const omoTail = [
  " ⚡ Cache-warm wait · iteration 3",
  " Stall backstop ready 2026-11-01 04:24 UTC (4m 30s) - the goal resumes as soon",
  " as a wake source delivers, inside the 1h prompt-cache TTL.",
  " Prior turn: ~151.6K cache-read/write tokens (cumulative) · est. $0.576",
  " discount if reused · next cache hit unverified",
  "",
  " TPS 148.9 tok/s. Cache hit 98.4%, 3.7s",
  "",
  " Todo",
  " Pre-roll PR",
  " [✓] Design pre-roll of about 1 s in the recorder",
  " [•] Replay plays the pre-roll (serve backswing visible)",
  " [ ] Back-to-back rallies with overlapping pre-roll",
  " [ ] Report pre-roll results to lead",
  "─────────────────────────────────────────────",
  "❯",
  "─────────────────────────────────────────────",
  " Claude·acct ▕░░░░░░░░░░░░░░▏ 0% 7d · resets 11/03 08:59 │ pool",
  "…ngpong-tournament • master • … • 152K/1M (15.2%) (auto)  claude-opus-5-5:medium",
  "(😺 OmO Native by Q Kim) Pursuing goal (22h 12m) goal continues ...",
].join("\n");
const userLine = (at: string, text: string): string => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
const noSignals = { signals: async () => ({}) };

test("a lane that reported is not NO-REPORT once its report scrolled off both screens: the lead gets its last report", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | recorder guard holds, PR open" });
  world.screens["w:p7"] = `v6-orig2 is recording.\n${omoTail}`;
  world.screens["lead:p1"] = omoTail;
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => undefined });
  expect(acts.map((a) => a.kind)).toEqual(["nudged", "lead-told"]);
  expect(sent(world).find((t) => t.startsWith("[DORI] quiet-lane"))).toContain("Last report: [REPORT] quiet-lane | milestone | recorder guard holds, PR open");
});

test("a lane that never reported is still NO-REPORT", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = omoTail;
  world.screens["lead:p1"] = omoTail;
  const transcript = [userLine("2026-01-01T12:05:00.000Z", "[REPORT] other-lane | milestone | not ours"), userLine("2026-01-01T12:06:00.000Z", "[DORI] quiet-lane: 20 min without a new report. Last report: [REPORT] quiet-lane | milestone | quoted, not typed")].join("\n");
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => transcript });
  expect(acts.map((a) => [a.kind, a.detail])).toContainEqual(["no-report", "pane has no [REPORT] line"]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("a report typed into the lead is read from its transcript, first line only, and a new one resets the silence", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | older step" });
  world.screens["w:p7"] = omoTail;
  world.screens["lead:p1"] = omoTail;
  const transcript = [
    userLine("2026-01-01T12:01:00.000Z", "[REPORT] quiet-lane | milestone | older step"),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T12:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "[REPORT] quiet-lane | done | the lead's own words are not a report" }] } }),
    userLine("2026-01-01T12:14:00.000Z", "[REPORT] quiet-lane | working | replay re-run done, second job waits in the core gate\nevidence: run 21631b1, qa/replay.log"),
  ].join("\n");
  const acts = await freshnessTick(deps(T0 + 16 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => transcript });
  expect(acts.map((a) => a.kind)).toEqual([]);
  const lane = await deps(T0).registry.read("quiet-lane");
  expect(lane?.lastReport).toBe("[REPORT] quiet-lane | working | replay re-run done, second job waits in the core gate");
  expect(lane?.lastReplyAt).toBe(T0 + 16 * MIN);
});

test("a report wrapped on the lane's screen with a status outside the four words and omo's tail under it still counts", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["lead:p1"] = omoTail;
  world.screens["w:p7"] = ` [REPORT] quiet-lane | working | origin 이동(end-sync 머지: 대회\n c6d071a, 비전 21631b1) 기록\n\n${omoTail}`;
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => undefined });
  expect(acts.map((a) => a.kind)).toEqual([]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastReport).toBe("[REPORT] quiet-lane | working | origin 이동(end-sync 머지: 대회 c6d071a, 비전 21631b1) 기록");
});

test("a Dori with no thread reply hook still tells the lead about a silent lane, its report defused; a lane with no thread is left out", async () => {
  // Given no hooks.threadReply (the case of every Dori but one on 2026-11-04).
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(working);
  await deps(T0).registry.write({ ...working, key: "threadless", thread: "none", pane: "w:p8" });
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | (a) 승인 조건대로 ① `bun test` green, $(x) gone\n [REPORT] threadless | milestone | step one\n\n❯ ";
  await freshnessTick(deps(T0 + MIN), "/home/test");
  // When it has been silent past postAfterMin.
  const acts = await freshnessTick(deps(T0 + 22 * MIN), "/home/test");
  // Then the lead gets one note for the lane with a thread, with a backtick or $( defused instead of failing the sweep.
  expect(acts.filter((a) => a.kind === "lead-told").map((a) => a.lane)).toEqual(["quiet-lane"]);
  const notes = sent(world).filter((t) => t.startsWith("[DORI]"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("① 'bun test' green, $ (x) gone");
});

test("a done claim written while a sweep is nudging the lane survives the sweep's own registry write", async () => {
  const base = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await base.registry.write(working);
  const run: typeof base.run = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "send-text") await claimDone({ ...base, run: async () => ({ code: 0, out: "❯ ", err: "" }) }, working, "merged acme/app#1");
    return base.run(argv, opts);
  };
  expect((await freshnessTick({ ...base, run }, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  const after = await base.registry.read("quiet-lane");
  expect(after?.status).toBe("done-claimed");
  expect(after?.lastNudgeAt).toBe(T0 + 16 * MIN);
});

test("a nudge that never reaches the lane's pane is reported as failed, not as sent", async () => {
  const deps = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await deps.registry.write(working);
  world.screens["w:p7"] = "❯ [LEAD] your work thread has had no update";
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudge-failed"]);
});

test("a stopped agent pane is reported once per hour after two reads a tick apart agree, and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const panes = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13", [], panes)).toEqual(["DEAD_PANE w:p1"]);
});
