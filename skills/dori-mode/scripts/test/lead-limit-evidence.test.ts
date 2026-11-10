import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick } from "../src/done-flow.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { readAnswerHistory } from "../src/missed-answers.ts";
import { QuestionStore, type Question } from "../src/messenger/discord-cards.ts";
import type { DoriConfig } from "../src/config.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const OWNER = "100000000000000001";
const SESSION_ID = "40ccbe13-33d4-4c1e-9d0e-0123456789ab";
const PANE = "aoe_Dori_0a1b2c3d";
const iso = (ms: number) => new Date(ms).toISOString();
let state: ReturnType<typeof withState>;
let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" }];
  world.tmux = [PANE];
});
afterEach(() => state.done());

const at = (ms: number): FlowDeps => ({ ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: PANE }), readGoal: async () => ({ status: "active" }) });
const watching = (s: string) => `❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching ${s}`;
const card = (id: string, answeredAt: number, thread: string): Question => ({ id, text: "도리방 말투?", options: ["a", "b"], channel: "c", thread, session: null, tmux: null, created: iso(answeredAt - MIN), status: "answered", answer: "a", answerKind: "button", answeredAt: iso(answeredAt) });

const limitWorld = () => {
  const sessionsDir = join(state.dir, "sessions");
  const leadDir = join(sessionsDir, "--home-test-dori--");
  mkdirSync(leadDir, { recursive: true });
  const leadFile = join(leadDir, `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(leadFile, "");
  const currentFile = join(leadDir, "2026-01-01T10-30-00-000Z_11111111-1111-1111-1111-111111111111.jsonl");
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${SESSION_ID}\n`;
  const deps = (ms: number, patch: Partial<DoriConfig> = {}) => ({
    ...at(ms),
    config: { ...at(ms).config, leadInboxMin: 0, ...patch, sessionsDir },
    ownerInbox: { path: inbox, ownerId: OWNER, ownerChannel: "C-OWNER" },
  });
  const row = (ms: number, id: string, content: string, extra: object = {}) => appendFileSync(inbox, `${JSON.stringify({ ts: iso(ms), id, channel_id: "T-THREAD", scope: "thread", author_id: OWNER, content, ...extra })}\n`);
  const reply = (ms: number, errorMessage?: string) => appendFileSync(leadFile, `${JSON.stringify({ timestamp: iso(ms), type: "message", message: { role: "assistant", content: [], ...(errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }) } })}\n`);
  const argv = (ms: number, entry: object) => appendFileSync(leadFile, `${JSON.stringify({ timestamp: iso(ms), ...entry })}\n`);
  const current = (ms: number, entry: object) => appendFileSync(currentFile, `${JSON.stringify({ timestamp: iso(ms), ...entry })}\n`);
  const startCurrent = () => writeFileSync(currentFile, `${JSON.stringify({ type: "session", timestamp: iso(T0 - 90 * MIN), id: "11111111-1111-1111-1111-111111111111" })}\n${JSON.stringify({ type: "session_info", timestamp: iso(T0 - 89 * MIN), name: "Dori" })}\n`);
  const rollover = () => writeFileSync(join(leadDir, "2026-01-01T11-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl"), `${JSON.stringify({ type: "session", timestamp: iso(T0 - 80 * MIN), id: "22222222-2222-2222-2222-222222222222" })}\n${JSON.stringify({ type: "session_info", timestamp: iso(T0 - 79 * MIN), name: "Dori" })}\n`);
  const sendCall = (ms: number, call: { readonly id: string; readonly to: string; readonly reply?: string; readonly qid?: string }) => {
    current(ms, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call.id, name: "eval", arguments: { code: `dori send discord --to ${call.to}${call.reply ? ` --reply ${call.reply}` : ""} --text '${call.qid ?? "answer"}'` } }] } });
    return (sentId: string) => current(ms + 1000, { type: "message", message: { role: "toolResult", toolCallId: call.id, content: [{ type: "text", text: `SENT ${sentId} len=20 sha=12345678 first="answer"` }] } });
  };
  return { deps, row, reply, argv, current, startCurrent, rollover, sendCall, leadFile, currentFile };
};

test("Q538 and other card answers leave waiting only when their session got them or their own Discord thread got a qid reply", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.startCurrent();
  l.row(T0 - 20 * MIN, "q538", "", { kind: "answer", qid: "Q538", thread: "T-CARD", answer: "continue" });
  l.row(T0 - 19 * MIN, "q539", "", { kind: "answer", qid: "Q539", thread: "T-SECOND", answer: "second" });
  l.row(T0 - 18 * MIN, "q540", "", { kind: "answer", qid: "Q540", thread: "T-PENDING", answer: "pending" });
  l.current(T0 - 15 * MIN, { type: "custom_message", customType: "senpi-monitor:notification", content: `<system-reminder>{"kind":"answer","qid":"Q538","id":"q538","ts":"${iso(T0 - 20 * MIN)}","answer":"continue"}</system-reminder>` });
  l.sendCall(T0 - 14 * MIN, { id: "send-q539", to: "T-SECOND", qid: "Q539" })("153000000000000001");
  const deps = { ...l.deps(T0), answeredCards: () => [card("Q538", T0 - 20 * MIN, "T-CARD"), card("Q539", T0 - 19 * MIN, "T-SECOND"), card("Q540", T0 - 18 * MIN, "T-PENDING")] };
  expect(await watchTick(deps)).toEqual([
    `CARD_ANSWER_REDELIVERED Q539 ${PANE}: answered ${iso(T0 - 19 * MIN)}, not in that session's transcript; typed it there (SUBMITTED)`,
    `CARD_ANSWER_REDELIVERED Q540 ${PANE}: answered ${iso(T0 - 18 * MIN)}, not in that session's transcript; typed it there (SUBMITTED)`,
    `LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 18 * MIN)} (18 min); woke the lead (SUBMITTED)`,
  ]);
  expect(sent(world).find((line) => line.includes("LEAD_OWNER_WAITING"))).toContain('The oldest: "pending"');
  l.current(T0 - 13 * MIN, { type: "message", message: { role: "user", content: [{ type: "text", text: `[DORI] ANSWER Q540 (button, ${iso(T0 - 18 * MIN)}): pending` }] } });
  expect(await watchTick(l.deps(T0 + MIN))).toEqual([]);
});

test("a visible Discord reply clears only its own owner message, never a different question or a send without a receipt", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.row(T0 - 19 * MIN, "m-2", "second");
  l.sendCall(T0 - 18 * MIN, { id: "send-m1", to: "T-THREAD", reply: "m-1" })("153000000000000002");
  l.sendCall(T0 - 17 * MIN, { id: "send-m2", to: "T-THREAD", reply: "m-2" });
  expect(await watchTick(l.deps(T0))).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 19 * MIN)} (19 min); woke the lead (SUBMITTED)`]);
  expect(sent(world)[0]).toContain('The oldest: "second"');
  l.current(T0 - 16 * MIN, { type: "custom_message", customType: "senpi-codemode:notification", content: "Detached eval cell send-m2 (js) completed. SENT 153000000000000003 len=20 sha=12345678" });
  expect(await watchTick(l.deps(T0 + MIN))).toEqual([]);
});

test("later narration and a failed send do not erase eligible owner rows", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.row(T0 - 19 * MIN, "m-2", "second");
  const narration = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I replied" }] } };
  l.argv(T0 - 10 * MIN, narration);
  l.current(T0 - 10 * MIN, narration);
  l.current(T0 - 9 * MIN, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "eval", arguments: { code: "dori send discord --to T-THREAD --reply m-1 --text answer" } }] } });
  l.current(T0 - 8 * MIN, { type: "message", message: { role: "toolResult", toolCallId: "failed", isError: true, content: [{ type: "text", text: "FAILED" }] } });
  expect(await watchTick(l.deps(T0))).toEqual([`LEAD_OWNER_WAITING ${PANE} 2 owner message(s), oldest ${iso(T0 - 20 * MIN)} (20 min); woke the lead (SUBMITTED)`]);
});

test("a stale argv limit error does not suppress the current session's owner wake", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.reply(T0 - 30 * MIN, "All Claude accounts are blocked. Soonest automatic retry: 2026-01-01T13:00:00Z");
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.current(T0 - 10 * MIN, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "working now" }] } });
  expect(await watchTick(l.deps(T0))).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 20 * MIN)} (20 min); woke the lead (SUBMITTED)`]);
});

test("a current transcript limit error emits its notice instead of a stale healthy argv wake", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.current(T0 - 10 * MIN, { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "All Claude accounts are blocked. Soonest automatic retry: 2026-01-01T13:00:00Z" } });
  const out = await watchTick(l.deps(T0));
  expect(out).toHaveLength(1);
  expect(out[0]).toStartWith(`LEAD_LIMIT_NOTICE ${PANE} model failing since ${iso(T0 - 10 * MIN)}, retry 2026-01-01T13:00:00.000Z, 1 owner message(s) waiting; NOT_POSTED`);
});

test.each([SESSION_ID, "11111111-1111-1111-1111-111111111111"])("an older same-name session selected by resume keeps its own health and answer evidence (argv %s)", async (argvSession) => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  l.rollover();
  l.row(T0 - 20 * MIN, "q1", "", { kind: "answer", qid: "Q1", thread: "T-CARD", answer: "yes" });
  l.row(T0 - 19 * MIN, "m-2", "still waiting");
  l.current(T0 - 10 * MIN, { type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify({ kind: "answer", qid: "Q1", id: "q1" }) });
  appendFileSync(join(l.currentFile, "..", "2026-01-01T11-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl"), `${JSON.stringify({ type: "message", timestamp: iso(T0 - 5 * MIN), message: { role: "assistant", stopReason: "error", errorMessage: "All Claude accounts are blocked. Soonest automatic retry: 2026-01-01T13:00:00Z" } })}\n`);
  utimesSync(l.leadFile, new Date(T0 - MIN), new Date(T0 - MIN));
  utimesSync(l.currentFile, new Date(T0), new Date(T0));
  utimesSync(join(l.currentFile, "..", "2026-01-01T11-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl"), new Date(T0 - 2 * MIN), new Date(T0 - 2 * MIN));
  world.ps += "12 11 /bin/sleep 100\n";
  world.ps = world.ps.replace(SESSION_ID, argvSession);
  const deps = l.deps(T0);
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "12"
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=11111111-1111-1111-1111-111111111111 PI_SESSION_FILE=${l.currentFile}\n`, err: "" }
    : deps.run(argv, opts);
  expect(await watchTick({ ...deps, run })).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 19 * MIN)} (19 min); woke the lead (SUBMITTED)`]);
});

test.each([{ child: false, title: "Dori" }, { child: true, title: "Dori" }, { child: true, title: "Old Dori" }])("clear ignores a stale argv session's retry with surviving child $child and old title $title", async ({ child, title }) => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.argv(T0 - 100 * MIN, { type: "session_info", name: title });
  l.reply(T0 - 30 * MIN, "All Claude accounts are blocked. Soonest automatic retry: 2026-01-01T13:00:00Z");
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.current(T0 - 10 * MIN, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "working now" }] } });
  utimesSync(l.leadFile, new Date(T0 - 30 * MIN), new Date(T0 - 30 * MIN));
  utimesSync(l.currentFile, new Date(T0 - 10 * MIN), new Date(T0 - 10 * MIN));
  if (child) world.ps += "12 11 /bin/sleep 100\n";
  const deps = l.deps(T0), run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "12"
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${SESSION_ID} PI_SESSION_FILE=${l.leadFile}\n`, err: "" } : deps.run(argv, opts);
  expect(await watchTick({ ...deps, run })).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 20 * MIN)} (20 min); woke the lead (SUBMITTED)`]);
});

test("a card resolved before the first reconciliation keeps its answer row's asking pane", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  const pane = "aoe_Lane_fedcba09", session = "33333333-3333-3333-3333-333333333333";
  world.aoe.push({ id: "fedcba0987654321", title: "Lane", path: "/home/test/lane", tool: "omo", profile: "main" });
  world.tmux.push(pane);
  world.ps += `20 1 /bin/bash\n21 20 /x/senpi/dist/bundle/cli.js --session-id ${session}\n`;
  const deps = l.deps(T0), store = new QuestionStore(join(state.dir, "cards"));
  const q = store.create("continue?", ["yes"], "T-CARD", { tmux: pane, thread: "T-CARD" }, iso(T0 - 30 * MIN));
  store.answer(q.id, "yes", "button", iso(T0 - 20 * MIN));
  l.row(T0 - 20 * MIN, "q1", "", { kind: "answer", qid: q.id, tmux: q.tmux, thread: q.thread, answer: "yes" });
  store.resolve(q.id);
  l.row(T0 - 19 * MIN, "q2", "", { kind: "answer", qid: "Q2", tmux: pane, thread: "T-CARD", answer: "undelivered" });
  const dir = join(deps.config.sessionsDir, "--home-test-lane--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-01-01T10-00-00-000Z_${session}.jsonl`), `${JSON.stringify({ type: "session", timestamp: iso(T0 - 120 * MIN) })}\n${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: JSON.stringify({ kind: "answer", qid: q.id, id: "q1" }) }] } })}\n`);
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "tmux" && argv[1] === "display-message" && argv.some((arg) => arg.includes(pane))
    ? { code: 0, out: "20", err: "" }
    : deps.run(argv, opts);
  expect(await watchTick({ ...deps, run, answeredCards: () => store.all() })).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 19 * MIN)} (19 min); woke the lead (SUBMITTED)`]);
});

test("redelivery followed by resolution preserves the immutable answer version in reconciliation and cache", async () => {
  const l = limitWorld(), store = new QuestionStore(join(state.dir, "cards"));
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  const q = store.create("continue?", ["yes"], "T-CARD", { tmux: PANE, thread: "T-CARD" }, iso(T0 - 30 * MIN));
  store.answer(q.id, "yes", "button", iso(T0 - 20 * MIN));
  l.row(T0 - 20 * MIN + 300, "old-version", "", { kind: "answer", qid: q.id, tmux: PANE, thread: q.thread, answer: "yes" });
  l.current(T0 - 19 * MIN, { type: "message", message: { role: "user", content: [{ type: "text", text: `[DORI] ANSWER ${q.id} (button, ${iso(T0 - 20 * MIN)}): yes` }] } });
  store.reopen(q.id);
  store.answer(q.id, "yes", "button", iso(T0 - 15 * MIN));
  l.row(T0 - 15 * MIN + 400, "new-version", "", { kind: "answer", qid: q.id, tmux: PANE, thread: q.thread, answer: "yes" });
  store.resolve(q.id);
  const deps = {
    ...l.deps(T0), answeredCards: () => store.all(),
    answerHistory: () => readAnswerHistory(store.answersFile),
  };
  expect(await watchTick(deps)).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 15 * MIN + 400)} (14 min); woke the lead (SUBMITTED)`]);
  expect(JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8"))).toEqual(["old-version"]);
});

test("an answered row stays cleared after rollover while a genuinely unanswered row still wakes", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  l.row(T0 - 20 * MIN, "m-1", "first");
  l.row(T0 - 19 * MIN, "m-2", "second");
  l.sendCall(T0 - 18 * MIN, { id: "send-m1", to: "T-THREAD", reply: "m-1" })("153000000000000002");
  expect(await watchTick(l.deps(T0, { leadWakeMin: 0 }))).toEqual([]);
  l.rollover();
  expect(await watchTick(l.deps(T0 + MIN))).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 19 * MIN)} (20 min); woke the lead (SUBMITTED)`]);
  world.aoe.push({ id: "fedcba0987654321", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" });
  world.tmux.push("aoe_Dori_fedcba09");
  expect(await watchTick(l.deps(T0 + 2 * MIN, { leadPane: "aoe_Dori_fedcba09" }))).toEqual([`LEAD_OWNER_WAITING aoe_Dori_fedcba09 1 owner message(s), oldest ${iso(T0 - 19 * MIN)} (21 min); woke the lead (SUBMITTED)`]);
});

test("a reopened card needs its own later answer delivery, not the previous answer", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.startCurrent();
  l.row(T0 - 20 * MIN, "old-answer", "", { kind: "answer", qid: "Q1", thread: "T-CARD", answer: "first" });
  l.current(T0 - 19 * MIN, { type: "custom_message", customType: "senpi-monitor:notification", content: '<system-reminder>{"kind":"answer","qid":"Q1","id":"old-answer","ts":"2026-01-01T11:40:00.000Z"}</system-reminder>' });
  l.row(T0 - 15 * MIN, "new-answer", "", { kind: "answer", qid: "Q1", thread: "T-CARD", answer: "second" });
  l.current(T0 - 14 * MIN, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Still waiting for Q1" }] } });
  l.current(T0 - 13 * MIN, { type: "custom_message", customType: "senpi-monitor:notification", content: '<system-reminder>{"kind":"answer","qid":"Q1","id":"old-answer","ts":"2026-01-01T11:40:00.000Z"}</system-reminder>' });
  l.current(T0 - 12 * MIN, { type: "custom_message", customType: "senpi-monitor:notification", content: '<system-reminder>{"kind":"answer","qid":"Q2","id":"other-card","ts":"2026-01-01T11:48:00.000Z","answer":"Q1 mention"}</system-reminder>' });
  l.current(T0 - 11 * MIN, { type: "message", message: { role: "user", content: [{ type: "text", text: `[DORI] ANSWER Q1 (button, ${iso(T0 - 20 * MIN)}): first` }] } });
  const deps = { ...l.deps(T0), answeredCards: () => [card("Q1", T0 - 15 * MIN, "T-CARD")] };
  expect(await watchTick(deps)).toEqual([`LEAD_OWNER_WAITING ${PANE} 1 owner message(s), oldest ${iso(T0 - 15 * MIN)} (15 min); woke the lead (SUBMITTED)`]);
  l.current(T0 - MIN, { type: "message", message: { role: "user", content: [{ type: "text", text: `[DORI] ANSWER Q1 (button, ${iso(T0 - 15 * MIN)}): second` }] } });
  expect(await watchTick(l.deps(T0 + MIN, { leadWakeMin: 0 }))).toEqual([]);
});
