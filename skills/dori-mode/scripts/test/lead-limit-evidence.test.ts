import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick } from "../src/done-flow.ts";
import { discordAnswered } from "../src/missed-answers.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import type { Question } from "../src/messenger/discord-cards.ts";
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
    config: { ...at(ms).config, ...patch, sessionsDir },
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
  return { deps, row, reply, argv, current, startCurrent, rollover, sendCall };
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

const directRow = { id: "1569339203593044020", channel: "1555211347338199112", at: Date.parse("2026-01-01T12:00:00Z") };
const directCall = (id: string, code: string, name = "eval") => ({ type: "message", timestamp: "2026-01-01T12:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { code } }] } });
const directResult = (id: string, text: string) => ({ type: "message", timestamp: "2026-01-01T12:00:01.000Z", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } });
const directDetached = (id: string, text: string) => ({ type: "custom_message", timestamp: "2026-01-01T12:00:01.000Z", customType: "senpi-codemode:notification", content: `<system-reminder>Detached eval cell ${id} (js) completed. ${text}` });
const directCommand = `dori send discord --to ${directRow.channel} --reply ${directRow.id} --text answer`;
const directAnswered = (entries: readonly object[]) => discordAnswered(entries.map((entry) => JSON.stringify(entry)).join("\n"), directRow);

test("a receipt counts only from the send's own tool result or detached cell", () => {
  const cases = [
    { name: "another tool quoting the pending id", expected: false, entries: [directCall("c1", directCommand), directResult("read-log", "Previously observed: c1 SENT 153000000000000001")] },
    { name: "another detached cell quoting the pending id", expected: false, entries: [directCall("c1", directCommand), directDetached("read-log", "Previously observed: c1 SENT 153000000000000001")] },
    { name: "a log-search tool quoting the command and receipt", expected: false, entries: [directCall("c1", directCommand, "grep"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a bash log search executing grep", expected: false, entries: [directCall("c1", `grep -F '${directCommand}' logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "an argv-array search pattern with a historical receipt", expected: false, entries: [directCall("c1", `grep -F -A1 '["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]' logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "the send's own tool result", expected: true, entries: [directCall("c1", directCommand), directResult("c1", "SENT 153000000000000001")] },
    { name: "the send's own detached completion including a pipe in its cell id", expected: true, entries: [directCall("call_c1|fc_1", directCommand), directDetached("call_c1|fc_1", "SENT 153000000000000001")] },
  ];
  for (const row of cases) expect(directAnswered(row.entries), row.name).toBe(row.expected);
});

test("one eval's second send cannot validate its failed first reply", () => {
  const both = `${directCommand}; dori send discord --to 1557744292393386074 --reply 1569339203593044021 --text other`;
  expect(directAnswered([directCall("c1", both), directResult("c1", "first command FAILED; second command SENT 153000000000000001")])).toBe(false);
  const threadDone = `${directCommand}; dori thread done discord:done-thread --text other`;
  expect(directAnswered([directCall("c1", threadDone), directResult("c1", "first command FAILED; thread done POSTED 153000000000000001")])).toBe(false);
  const arrayDone = `${directCommand}; Bun.spawn(["dori", "thread", "done", "discord:done-thread", "done"])`;
  expect(directAnswered([directCall("c1", arrayDone), directResult("c1", "first command FAILED; done POSTED 153000000000000001")])).toBe(false);
});

test("an argv-array Discord reply uses its matching receipt", () => {
  const argv = `const p = Bun.spawn(["dori", "send", "discord", "--to", "${directRow.channel}", "--thread", "T-THREAD", "--reply", "${directRow.id}", "--text", "[done] Answer"], { env: process.env, stdin: "ignore", stdout: "pipe" }); console.log(await new Response(p.stdout).text()); await p.exited;`;
  expect(discordAnswered([directCall("c1", argv), directResult("c1", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), { ...directRow, channel: "T-THREAD" })).toBe(true);
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

test("shell replies use the effective thread and quoted arguments", () => {
  const row = { ...directRow, channel: "T-THREAD" };
  const double = `dori send discord --to "${directRow.channel}" --thread "T-THREAD" --reply "${directRow.id}" --text answer`;
  const single = `dori send discord --to '${directRow.channel}' --thread 'T-THREAD' --reply '${directRow.id}' --text answer`;
  expect(discordAnswered([directCall("double", double), directResult("double", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), row)).toBe(true);
  expect(discordAnswered([directCall("single", single), directResult("single", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), row)).toBe(true);
  expect(discordAnswered([directCall("channel", directCommand), directResult("channel", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), row)).toBe(false);
  const card = `dori send discord --to "${directRow.channel}" --thread "T-CARD" --text "Q1"`;
  expect(discordAnswered([directCall("card", card), directResult("card", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), { ...directRow, qid: "Q1", thread: "T-CARD" })).toBe(true);
  const optionText = `dori send discord --to T-THREAD --reply ${directRow.id} --text 'Use --thread OTHER and --reply OTHER for that'`;
  expect(discordAnswered([directCall("option-text", optionText), directResult("option-text", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), row)).toBe(true);
  const trailing = `${directCommand}; printf 'unterminated`;
  expect(discordAnswered([directCall("trailing", trailing), directResult("trailing", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), directRow)).toBe(true);
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
