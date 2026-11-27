import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { recordMove } from "../src/lane-lifecycle.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// The lead's rule for a revived lane's cards (2026-11-27, after review 9 of #535): an answer goes on to the revived pane
// by itself only when the recorded moves prove one unbroken chain on one session from the card's pane to the lane's pane
// now; on any doubt (no session on the card, a /clear, a broken or branching record) it stays as it is and the lead is told.
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

const iso = (ms: number) => new Date(ms).toISOString();

test("at a revive only the cards of the lane's own session follow it; a card with no session stays, its answer kept, and the lead is told which", async () => {
  // Given: two answered cards asked from hc:t27, one on the lane's session, one with none (dori ask without --session)
  const store = new QuestionStore(join(state.dir, "cards"));
  const own = store.create("which pose set?", ["a", "b"], "1", { tmux: "hc:t27", session: SESSION }, iso(T0));
  const bare = store.create("keep the GPU off?", ["yes", "no"], "1", { tmux: "hc:t27" }, iso(T0));
  store.answer(own.id, "a", "button", iso(T0));
  store.answer(bare.id, "yes", "button", iso(T0));
  const { w, deps } = reviveRig(state.dir, { patch: { retargetCards: (from, to, session) => ({ moved: store.retarget({ tmux: from, session }, { tmux: to, session }, true), left: store.all().filter((q) => q.tmux === from && (q.status === "open" || q.status === "answered")) }) } });
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  // When
  const line = await reviveTarget(d, "h3-charsheet", "");
  // Then: the own card follows, the bare one stays with its answer, and the lead gets one line naming card, answer and lane
  expect(line).toBe(`REVIVE_OK h3-charsheet hc:t1 session ${SESSION} (pane hc:t27 was gone; 1 card left to the lead)`);
  expect([store.get(own.id)?.tmux, store.get(bare.id)?.tmux, store.get(bare.id)?.answer]).toEqual(["hc:t1", "hc:t27", "yes"]);
  expect(sent(w)).toEqual([`[DORI] 레인 h3-charsheet 새 창 hc:t1: 카드 ${bare.id}(keep the GPU off?) 답 "yes"는 옛 창 hc:t27에 그대로 뒀어(카드에 세션 기록 없음) — 레인에 손으로 넣어 줘`]);
});

type Doubt = "none" | "clear" | "stale-env" | "no-session" | "broken";

// an answer asked from a pane the lane was revived away from, delivered (or not) in the revived pane's live session
const reconcile = async (doubt: Doubt, direct = false): Promise<string[]> => {
  const t = Date.parse("2026-01-01T12:00:00Z"), min = 60_000;
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222", leadId = "99999999-9999-9999-9999-999999999999";
  const gone = "aoe_Gone_11112222", pane = "aoe_Asking_fedcba09", lead = "aoe_Dori_0a1b2c3d", cwd = "/home/test/asking", leadCwd = "/home/test/dori", owner = "100000000000000001";
  const sessionsDir = join(state.dir, "sessions"), dir = sessionDirFor(sessionsDir, cwd), leadDir = sessionDirFor(sessionsDir, leadCwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(leadDir, { recursive: true });
  const cleared = doubt === "clear" || doubt === "stale-env", reader = cleared ? current : old;
  // stale-env: after the /clear the agent's children still name old, while the newer same-title log is current's
  const named = doubt === "stale-env" ? old : reader;
  const oldPath = join(dir, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(dir, `2026-01-01T12-02-00-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const meta = { tmux: gone, thread: "CARD", ...(doubt === "no-session" ? {} : { session: old }) };
  const first = store.create("delivered?", ["yes"], "CARD", meta, iso(t - min));
  const second = store.create("pending?", ["yes"], "CARD", meta, iso(t - min));
  store.answer(first.id, "yes", "button", iso(t));
  store.answer(second.id, "yes", "button", iso(t + min));
  store.resolve(first.id);
  // direct: a third card asked from the revived pane itself on its session now, its answer read there
  const third = direct ? store.create("third?", ["yes"], "CARD", { tmux: pane, thread: "CARD", session: current }, iso(t)) : undefined;
  if (third) store.answer(third.id, "yes", "button", iso(t + 30_000));
  const delivered = { id: "answer-delivered", ts: iso(t + 300), kind: "answer", qid: first.id, tmux: gone, thread: "CARD", scope: "thread", channel_id: "CARD", author_id: owner, answer: "yes" };
  const pending = { ...delivered, id: "answer-pending", ts: iso(t + min + 300), qid: second.id };
  const thirdRow = third ? [{ ...delivered, id: "answer-third", ts: iso(t + 30_300), qid: third.id, tmux: pane }] : [];
  const log = (id: string, ts: number, withAnswer: boolean) => [{ type: "session", id, cwd, timestamp: iso(ts) }, { type: "session_info", name: "Asking" }, ...(withAnswer ? [delivered, ...thirdRow].map((row) => ({ type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify(row) })) : [])].map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(oldPath, log(old, t - 2 * min, reader === old));
  // a newer same-title log exists only after a /clear
  if (cleared) writeFileSync(currentPath, log(current, t + 2 * min, reader === current));
  writeFileSync(join(leadDir, `2026-01-01T12-02-00-000Z_${leadId}.jsonl`), `${JSON.stringify({ type: "session", id: leadId, cwd: leadCwd, timestamp: iso(t + 2 * min) })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`);
  utimesSync(oldPath, new Date(t + 500), new Date(t + 500));
  if (cleared) utimesSync(currentPath, new Date(t + 2 * min), new Date(t + 2 * min));
  const world = newWorld();
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: leadCwd, tool: "omo", profile: "main" }, { id: "fedcba0987654321", title: "Asking", path: cwd, tool: "omo", profile: "main" }];
  world.tmux = [lead, pane];
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  world.agentStart = new Date(t - 2 * min).toUTCString();
  world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${leadId}\n20 1 /bin/bash\n21 20 /x/senpi/dist/bundle/cli.js --session-id ${old}\n22 21 /bin/sleep 100\n`;
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [delivered, pending, ...thirdRow].map((row) => JSON.stringify(row)).join("\n"));
  const base = depsFor(world, fakeClock(t + 20 * min), state.dir, { backend: "aoe", leadPane: lead, sessionsDir, leadInboxMin: 0 });
  const run: FlowDeps["run"] = async (argv, opts) =>
    argv[0] === "tmux" && argv[1] === "display-message" && argv.some((a) => a.includes(pane)) ? { code: 0, out: "20", err: "" }
    : argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "22" ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${named} PI_SESSION_FILE=${named === old ? oldPath : currentPath}`, err: "" }
    : base.run(argv, opts);
  await base.registry.write({ key: "asking", title: "Asking", thread: "none", pane, session: old, cwd, brief: "/brief", done: "merged acme/app#1", status: "paused", openedAt: iso(t - 2 * min) });
  recordMove(state.dir, { key: "asking", session: old, from: gone, to: doubt === "broken" ? "aoe_Other_33334444" : pane, at: iso(t + 500) });
  const out = await watchTick({ ...base, run, readGoal: async () => ({ status: "active" }), ownerInbox: { path: inbox, ownerId: owner, ownerChannel: "C" }, answeredCards: () => store.all(), answerHistory: () => readAnswerHistory(store.answersFile) });
  const answered = existsSync(join(state.dir, "lead-answered.json")) ? (JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) as string[]) : [];
  return [...out.map((l) => l.replace(/, oldest .*/, "")), ...answered];
};

test("a proven chain on one session counts the answer the revived pane's session read as delivered", async () => {
  expect(await reconcile("none")).toEqual(["LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 1 owner message(s)", "answer-delivered"]);
});

test.each<[string, Doubt]>([
  ["a /clear in the revived pane", "clear"],
  ["a /clear whose children still name the old session", "stale-env"],
  ["a card with no session", "no-session"],
  ["a move record that does not reach the lane's pane", "broken"],
])("on doubt (%s) the answer is not taken as delivered: it stays waiting for the lead", async (_name, doubt) => {
  expect(await reconcile(doubt)).toEqual(["LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 2 owner message(s)"]);
});

test("a doubtful forwarded answer leaves the revived pane's own transcript as it is for a card asked there", async () => {
  // Given / When: after a /clear the children still name, one card asked from the gone pane (forwarded, then doubt) and one asked from the revived pane itself
  // Then: the gone pane's two wait; the revived pane's own answer counts as read there
  expect(await reconcile("stale-env", true)).toEqual(["LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 2 owner message(s)", "answer-third"]);
});
