import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { objectDone } from "../src/done-flow.ts";
import { withLaneLifecycle } from "../src/lane-lifecycle.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { Registry } from "../src/registry.ts";
import { sent, withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// Review 11 of #535: a lane's pane moves only through a relocation (a revive, a handover), each one a new pane revision;
// a record read before a relocation keeps the pane it moved to, a write waits while a revive holds the lane, and a handover
// into a reused terminal number still moves the lane. The card notices survive any text, and a not-done objection reaches
// the pane the lane runs in now.
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

test("a record read before a relocation keeps the pane it moved to; a later relocation into a reused number still moves it", async () => {
  // Given: the lane read in hc:t27, then relocated twice (two revives)
  const registry = new Registry(state.dir);
  await registry.write(laneOf(state.dir));
  const stale = await registry.read("h3-charsheet");
  await registry.patch("h3-charsheet", { pane: "hc:t2" }, { relocate: true });
  await registry.patch("h3-charsheet", { pane: "hc:t3" }, { relocate: true });
  // When: the old read is written back
  await registry.write({ ...(stale ?? laneOf(state.dir)), status: "not-done" });
  // Then: the pane stays where the lane runs, the status change lands
  const after = await registry.read("h3-charsheet");
  expect([after?.pane, after?.status]).toEqual(["hc:t3", "not-done"]);
  // a handover moves it to a terminal hc numbered like the first pane, then writes its new session
  await registry.patch("h3-charsheet", { pane: "hc:t27" }, { relocate: true });
  await registry.patch("h3-charsheet", { session: "77777777-2222-4333-8444-555555555555" });
  expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t27");
});

test("a write waits while a revive holds the lane, and then reads the pane the revive wrote", async () => {
  // Given: a revive holds the lane's lifecycle lock and writes the new pane inside it
  const registry = new Registry(state.dir);
  await registry.write(laneOf(state.dir));
  const stale = await registry.read("h3-charsheet");
  const deps = { config: { stateDir: state.dir } as never, clock: { now: () => T0, sleep: (ms: number) => Bun.sleep(ms) } };
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let published!: () => void;
  const inside = new Promise<void>((r) => (published = r));
  const revive = withLaneLifecycle(deps, "h3-charsheet", async () => {
    await registry.patch("h3-charsheet", { pane: "hc:t1" }, { relocate: true });
    published();
    await held;
  });
  await inside;
  // When: another writer writes its old read meanwhile, then the revive lets go
  const writing = registry.write({ ...(stale ?? laneOf(state.dir)), status: "not-done" });
  release();
  await Promise.all([revive, writing]);
  // Then
  expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t1");
});

test("a left card's notice keeps its text safe for the pane (backticks, $( ) and the revive still succeeds", async () => {
  const store = new QuestionStore(join(state.dir, "cards"));
  const bare = store.create("run `make` or $(make)?", ["yes"], "1", { tmux: "hc:t27" }, new Date(T0).toISOString());
  store.answer(bare.id, "use `make`", "text", new Date(T0).toISOString());
  const { w, deps } = reviveRig(state.dir, { patch: { retargetCards: (from, to, session) => ({ moved: store.retarget({ tmux: from, session }, { tmux: to, session }, true), left: store.all().filter((q) => q.tmux === from) }) } });
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  expect(await reviveTarget(d, "h3-charsheet", "")).toBe(`REVIVE_OK h3-charsheet hc:t1 session ${SESSION} (pane hc:t27 was gone; 1 card left to the lead)`);
  expect(sent(w)).toEqual([`[DORI] 레인 h3-charsheet 새 창 hc:t1: 카드 ${bare.id}(run 'make' or $ (make)?) 답 "use 'make'"는 옛 창 hc:t27에 그대로 뒀어(카드에 세션 기록 없음) — 레인에 손으로 넣어 줘`]);
});

test("a not-done objection written from an old read reaches the pane the lane runs in now", async () => {
  // Given: the lane was revived into hc:t1 while its done check ran on a read naming hc:t27
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir, { status: "done-claimed" }));
  const stale = await d.registry.read("h3-charsheet");
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  const t1 = fake.terminals.get("t1");
  if (t1) [t1.status, t1.reported] = [{ state: "idle", app: "omo" }, true];
  // When
  await objectDone(d, stale ?? laneOf(state.dir), ["a signal is not live"]);
  // Then: the record stays in hc:t1 and the objection was typed there
  expect((await d.registry.read("h3-charsheet"))?.pane).toBe("hc:t1");
  expect(fake.sent.some((s) => s.id === "t1" && s.text.startsWith("[LEAD] not done: a signal is not live"))).toBe(true);
});
