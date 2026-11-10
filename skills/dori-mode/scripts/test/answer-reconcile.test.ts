import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reconcileRows, type AnswerRow } from "../src/missed-answers.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const at = Date.parse("2026-01-01T12:00:00Z");
const first = { id: "1569339203593044020", channel: "C-A", at };
const second = { id: "1569339203593044021", channel: "C-B", at };
const send = `dori send discord --to ${first.channel} --reply ${first.id} --text answer`;
const sent = "SENT 153000000000000001 len=6 sha=12345678 first=answer";
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const call = (code: string, name = "eval", id = "call-1") => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", name, id, arguments: name === "eval" ? { language: "js", code } : { command: code } }] } });
const result = (text: string, id = "call-1", details: object = {}) => ({ type: "message", timestamp: new Date(at + 1000).toISOString(), message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], details } });
const completion = (handle: string) => ({ type: "custom_message", customType: "senpi-monitor:notification", timestamp: new Date(at + 2000).toISOString(), content: `<system-reminder>Background terminal session ${handle} finished: completed (exit code 0).\n${sent}</system-reminder>` });
const cache = (): string[] => existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : [];
const replay = (entries: readonly object[], rows: readonly AnswerRow[] = [first, second]) => {
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n"), path = join(state.dir, "lead.jsonl");
  writeFileSync(path, text);
  return reconcileRows({ rows, cards: [], lead: { pane: "lead", path, title: "", text }, sessions: [], table: [], deps: depsFor(newWorld(), fakeClock(at + 3000), state.dir) });
};

test.each(["'EOF'", "EOF", "-'EOF'", "bare"])("printed heredoc %s text is not a send and never enters the answered cache", async (kind) => {
  const delimiter = kind === "bare" ? "'EOF'" : kind, body = kind === "bare" ? send : `await tool.bash({command: ${JSON.stringify(send)}})`;
  const code = `cat <<${delimiter}\n${body}\n${sent}\nEOF`;
  expect(await replay([call(code, "bash"), result(sent)])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test("shell comments and wrapped shell heredocs exclude JS-looking data while later real sends still count", async () => {
  const data = `cat <<'EOF'\nawait tool.bash({command: ${JSON.stringify(send)}})\n${sent}\nEOF`;
  const real = `dori send discord --to ${second.channel} --reply ${second.id} --text answer # --reply ${first.id} --to ${first.channel}`;
  const code = `await tool.bash({command: ${JSON.stringify(`# await tool.bash({command: "${send}"})\n${data}\n${real}`)}})`;
  expect(await replay([call(code), result(sent)])).toEqual({ waiting: [first], answeredIds: [second.id] });
  expect(cache()).toEqual([second.id]);
});

test.each(["space", "equals", "thread"])("only effective repeated %s CLI destination, reply and message clear their rows", async (style) => {
  const options = style === "equals"
    ? `--to=C-A --to=C-B --reply=${first.id} --reply=${second.id} --text=Q1 --text=Q2`
    : `${style === "thread" ? "--to C --thread C-A --thread C-B" : "--to C-A --to C-B"} --reply ${first.id} --reply ${second.id} --text Q1 --text Q2`;
  const q1 = { id: "answer-1", at, qid: "Q1", thread: "C-B" }, q2 = { id: "answer-2", at, qid: "Q2", thread: "C-B" };
  expect(await replay([call(`dori send discord ${options}`, "bash"), result(sent)], [first, second, q1, q2])).toEqual({ waiting: [first, q1], answeredIds: [second.id, q2.id] });
  expect(cache()).toEqual([second.id, q2.id]);
});

test.each(["toolResult", "monitor", "assistant", "arguments"])("escaped JSON output in %s preserves answer identity and versions only when delivered", async (kind) => {
  const row = { id: "answer-current", at, qid: "Q1", thread: "T-CARD" };
  const next = { ...row, id: "answer-next", at: at + 1000 }, other = { ...row, id: "other-card", qid: "Q11" };
  const inbox = `${JSON.stringify({ kind: "answer", qid: "Q1", id: "answer-old", ts: new Date(at - 1000).toISOString() })}\n${JSON.stringify({ kind: "answer", qid: "Q1", id: row.id, ts: new Date(at).toISOString(), answer: "{yes}" })}`;
  const wrapped = JSON.stringify({ result: JSON.stringify({ stdout: inbox }) });
  const entry = kind === "toolResult" ? result(wrapped) : kind === "monitor" ? { type: "custom_message", customType: "senpi-monitor:notification", content: wrapped } : kind === "assistant" ? { type: "message", message: { role: "assistant", content: [{ type: "text", text: wrapped }] } } : call(`grep -F ${JSON.stringify(wrapped)} inbox.jsonl`);
  const delivered = kind === "toolResult" || kind === "monitor";
  expect(await replay([entry], [row, next, other])).toEqual({ waiting: delivered ? [next, other] : [row, next, other], answeredIds: delivered ? [row.id] : [] });
  expect(cache()).toEqual(delivered ? [row.id] : []);
});

test.each(["background", "auto-detached", "bash-auto-detached", "other-handle", "other-call"])("bash %s completion correlates its starting handle and persists only answered IDs", async (kind) => {
  const handle = "bash_7";
  const start = kind === "auto-detached"
    ? result("background started", "call-1", { toolCalls: [{ name: "bash", resultPreview: `Command is still running; auto-detached to background with ID: ${handle} (not killed).` }] })
    : kind === "bash-auto-detached" ? result(`Command is still running; auto-detached to background with ID: ${handle} (not killed).`)
    : result(`Command running in background with ID: ${handle}`, kind === "other-call" ? "other-call" : "call-1", { bash_id: handle, background: true });
  const command = kind === "auto-detached" ? call(`await tool.bash({command: ${JSON.stringify(send)}})`) : call(send, "bash");
  const entries = [command, start];
  expect(await replay(entries)).toEqual({ waiting: [first, second], answeredIds: [] });
  const good = kind !== "other-handle" && kind !== "other-call", answeredIds = good ? [first.id] : [];
  expect(await replay([...entries, completion(kind === "other-handle" ? "bash_other" : handle)])).toEqual({ waiting: good ? [second] : [first, second], answeredIds });
  expect(cache()).toEqual(answeredIds);
  expect(await replay([])).toEqual({ waiting: good ? [second] : [first, second], answeredIds });
});

test.each(["search-with-args", "search-without-args", "native-send", "send-with-args"])("nested bash %s receipts belong to the execution that attempted the send", async (kind) => {
  const search = "grep -F SENT historical.log", background = "Command running in background with ID: bash_7";
  const attempt = kind === "native-send"
    ? `Bun.spawn(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"])`
    : `await tool.bash({command: ${JSON.stringify(send)}})`;
  const command = call(`${attempt}; await tool.bash({command: ${JSON.stringify(search)}})`);
  const good = kind === "send-with-args";
  const toolCalls = [
    ...(kind === "native-send" ? [] : [{ name: "bash", args: { command: send }, resultPreview: good ? background : "send failed (exit code 1)" }]),
    { name: "bash", args: kind === "search-without-args" ? {} : { command: search }, resultPreview: good ? "Command running in background with ID: bash_8" : background },
  ];
  const entries = [command, result("send attempted; background started", "call-1", { toolCalls }), completion("bash_7")];
  expect(await replay(entries)).toEqual({ waiting: good ? [second] : [first, second], answeredIds: good ? [first.id] : [] });
  expect(cache()).toEqual(good ? [first.id] : []);
});

test.each([
  "dori thread done 'discord:OTHER' 'done'",
  'dori thread wait "discord:OTHER" "wait"',
  "dori thread reply --lane other 'discord:OTHER' 'reply'",
  "dori thread --lane other done 'discord:OTHER' 'done'",
  "dori send --to OTHER discord --text other",
  'dori thread done "$thread" done',
])("a failed reply plus %s retains both posting operations", async (other) => {
  expect(await replay([call(`${send}; ${other}`, "bash"), result("first FAILED; other POSTED 153000000000000001")])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test("a quoted thread reply with reordered options clears only its own card", async () => {
  const row = { id: "answer-card", qid: "Q1", thread: "CARD", at };
  expect(await replay([call("dori thread reply --lane other 'discord:CARD' 'Q1 answer'", "bash"), result("POSTED 153000000000000001")], [first, row])).toEqual({ waiting: [first], answeredIds: [row.id] });
  expect(cache()).toEqual([row.id]);
});
