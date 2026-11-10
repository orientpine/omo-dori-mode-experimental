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
  const data = `cat > /dev/null 2>&1 <<'EOF'\nawait tool.bash({command: ${JSON.stringify(send)}})\n${sent}\nEOF`;
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

test.each(["prepared", "historical-search", "unresolved", "other-cell"])("detached send after %s preserves operation-specific receipt ownership", async (kind) => {
  const prep = kind === "historical-search" ? "grep -F SENT historical.log" : "pwd";
  const code = `await tool.bash({command: ${JSON.stringify(prep)}}); display(await tool.bash({command: ${JSON.stringify(send)}}))`;
  const details = kind === "unresolved" ? {} : { toolCalls: [{ name: "bash", args: { command: prep }, resultPreview: kind === "historical-search" ? sent : "/repo" }] };
  const start = result("Eval cell call-1 detached and is running", "call-1", details);
  const completed = { type: "custom_message", customType: "senpi-codemode:notification", content: `<system-reminder>Detached eval cell ${kind === "other-cell" ? "other" : "call-1"} (js) completed.\n${sent}\nKernel state updated</system-reminder>` };
  const good = kind === "prepared";
  expect(await replay([call(code), start, completed])).toEqual({ waiting: good ? [second] : [first, second], answeredIds: good ? [first.id] : [] });
  expect(cache()).toEqual(good ? [first.id] : []);
});

test.each(["tool-search", "native-search"])("failed native send cannot borrow foreground %s output or its detached completion", async (kind) => {
  const native = `Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"])`;
  const search = kind === "tool-search" ? 'display(await tool.bash({command: "grep -F SENT historical.log"}))' : 'console.log(Bun.spawnSync(["grep","-F","SENT","historical.log"]).stdout.toString())';
  const details = kind === "tool-search" ? { toolCalls: [{ name: "bash", args: { command: "grep -F SENT historical.log" }, resultPreview: sent }] } : {};
  const entries = [call(`${native}; ${search}`), result(`send FAILED; search returned ${sent}`, "call-1", details)];
  const detached = { type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell call-1 (js) completed.\n${sent}` };
  expect(await replay([...entries, detached])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test("a native send's own output without sibling executions still clears its row", async () => {
  const code = `console.log(Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"]).stdout.toString())`;
  expect(await replay([call(code), result(sent)])).toEqual({ waiting: [second], answeredIds: [first.id] });
  expect(cache()).toEqual([first.id]);
});

test.each(["direct", "bound", "checked", "detached"])("native preparation preserves the send's %s stdout receipt and cache", async (kind) => {
  const post = `Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"])`;
  const code = `const directory = Bun.spawnSync(["pwd"]); ${kind === "direct" ? `console.log(${post}.stdout.toString())` : `const reply = ${post}; ${kind === "checked" ? "if (reply.exitCode === 0) " : ""}console.log(reply.stdout.toString())`}`;
  const output = kind === "detached"
    ? [result("Eval cell call-1 detached and is running"), { type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell call-1 (js) completed.\n${sent}` }]
    : [result(sent)];
  expect(await replay([call(code), ...output])).toEqual({ waiting: [second], answeredIds: [first.id] });
  expect(cache()).toEqual([first.id]);
});

test.each(["grep", "read"])("a failed native send cannot borrow printed tool.%s results", async (tool) => {
  const code = `Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"]); display(await tool.${tool}(${tool === "grep" ? '{pattern:"SENT",path:"historical.log"}' : '{path:"historical.log"}'}))`;
  expect(await replay([call(code), result(sent)])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test.each([";", "\n", "||", "|"])("compound bash cannot borrow a following search receipt across %s", async (separator) => {
  const command = `${send}${separator} grep -F SENT historical.log`;
  for (const entry of [call(command, "bash"), call(`display(await tool.bash({command: ${JSON.stringify(command)}}))`)]) {
    expect(await replay([entry, result(`send failed; search output:\n${sent}`)])).toEqual({ waiting: [first, second], answeredIds: [] });
    expect(cache()).toEqual([]);
  }
});

test("heredoc history and a failed terminal send are not operation-specific receipt evidence", async () => {
  const code = `cat <<'EOF'\nawait tool.bash({command: ${JSON.stringify(send)}})\n${sent}\nEOF\ndori send discord --to ${second.channel} --reply ${second.id} --text answer`;
  expect(await replay([call(`display(await tool.bash({command: ${JSON.stringify(code)}}))`), result(`await tool.bash({command: ${JSON.stringify(send)}})\n${sent}\nterminal send failed`)])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test.each([
  { setup: "set -e; ", transport: "bash" },
  { setup: "set -euo pipefail; ", transport: "bash" },
  { setup: "cd /repo && ", transport: "eval" },
  { setup: "set -e; ", transport: "background" },
  { setup: "set -e; ", transport: "detached" },
])("silent preparation $setup preserves the $transport send's receipt and cache", async ({ setup, transport }) => {
  const command = `${setup}${send}`, wrapped = transport === "eval" || transport === "detached";
  const entry = call(wrapped ? `display(await tool.bash({command: ${JSON.stringify(command)}}))` : command, wrapped ? "eval" : "bash");
  const output = transport === "background" ? [result("Command running in background with ID: bash_7", "call-1", { bash_id: "bash_7", background: true }), completion("bash_7")]
    : transport === "detached" ? [result("Eval cell call-1 detached and is running"), { type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell call-1 (js) completed.\n${sent}` }] : [result(sent)];
  expect(await replay([entry, ...output])).toEqual({ waiting: [second], answeredIds: [first.id] });
  expect(cache()).toEqual([first.id]);
  expect(await replay([])).toEqual({ waiting: [second], answeredIds: [first.id] });
});

test.each(["set", "cd -", "cd '/SENT 153000000000000001' &&", "set -x;"])("output-capable setup %s cannot supply a failed send's receipt", async (setup) => {
  const command = setup.startsWith("set -x") || setup.endsWith("&&") ? `${setup} ${send}` : `${send}; ${setup}`;
  expect(await replay([call(command, "bash"), result(`setup output: ${sent}\nsend failed`)])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test.each(["spawn", "detached-spawn", "exec", "tagged"])("a native file read cannot validate the failed %s send or cache its owner", async (kind) => {
  const native = kind === "exec" ? `await exec(${JSON.stringify(send)})` : kind === "tagged" ? `await Bun.$\`${send}\`` : `Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"])`;
  const entry = call(`${native}; console.log(await Bun.file("historical.log").text())`);
  const output = kind === "detached-spawn" ? [result("Eval cell call-1 detached and is running"), { type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell call-1 (js) completed.\n${sent}` }] : [result(sent)];
  expect(await replay([entry, ...output])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test.each(["spawn-trim", "execSync-direct", "execSync-bound", "shell-text", "shell-bound", "exec-stdout", "async-trim", "decoder-trim", "trim-chain"])("safe %s stdout formatting preserves reconciliation and cache", async (kind) => {
  const argv = JSON.stringify(["dori", "send", "discord", "--to", first.channel, "--reply", first.id, "--text", "answer"]);
  const code = kind === "execSync-direct" ? `console.log(execSync(${JSON.stringify(send)}).toString().trim())`
    : kind === "execSync-bound" ? `const p = execSync(${JSON.stringify(send)}); console.log(p.toString())`
    : kind === "shell-text" ? `console.log((await Bun.$\`${send}\`.text()).trim())`
    : kind === "shell-bound" ? `const p = await Bun.$\`${send}\`; console.log(p.text().trim())`
    : kind === "exec-stdout" ? `const p = await exec(${JSON.stringify(send)}); console.log(p.stdout.trim())`
    : kind === "async-trim" ? `const p = Bun.spawn(${argv}, {env:process.env,stdin:"ignore",stdout:"pipe"}); console.log((await new Response(p.stdout).text()).trim()); await p.exited;`
    : kind === "decoder-trim" ? `const p = Bun.spawnSync(${argv}); console.log(new TextDecoder("utf-8").decode(p.stdout).trimEnd())`
    : kind === "trim-chain" ? `console.log(Bun.spawnSync(${argv}).stdout.toString().trimStart().trimEnd())`
    : `const p = Bun.spawnSync(${argv}); console.log(p.stdout.toString("utf8").trim())`;
  expect(await replay([call(code), result(sent)])).toEqual({ waiting: [second], answeredIds: [first.id] });
  expect(cache()).toEqual([first.id]);
});

test("formatting an unrelated result binding cannot become the send's stdout", async () => {
  const code = `const $SEND = ${JSON.stringify({ stdout: sent })}; const p = Bun.spawnSync(["dori","send","discord","--to","${first.channel}","--reply","${first.id}","--text","answer"]); console.log($SEND.stdout.trim())`;
  expect(await replay([call(code), result(sent)])).toEqual({ waiting: [first, second], answeredIds: [] });
  expect(cache()).toEqual([]);
});

test.each(["foreground", "detached", "failed-metadata", "prepared-failure", "own-receipt", "own-background"])("wrapped send plus file output keeps %s evidence operation-specific", async (kind) => {
  const prepared = kind === "prepared-failure", good = kind === "own-receipt" || kind === "own-background";
  const code = `${prepared ? 'await tool.bash({command:"pwd"}); ' : ""}await tool.bash({command:${JSON.stringify(send)}}); console.log(await Bun.file("historical.log").text())`;
  const details = kind === "foreground" || kind === "detached" ? {} : { toolCalls: [...(prepared ? [{ name: "bash", args: { command: "pwd" }, resultPreview: "/repo" }] : []), { name: "bash", args: { command: send }, resultPreview: kind === "own-receipt" ? sent : kind === "own-background" ? "Command running in background with ID: bash_7" : "send failed (exit code 1)" }] };
  const entries: object[] = [call(code), result(kind === "foreground" || good ? sent : "Eval cell call-1 detached and is running", "call-1", details)];
  if (kind !== "foreground") entries.push({ type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell call-1 (js) completed.\n${sent}` });
  if (kind === "own-background") {
    expect(await replay(entries)).toEqual({ waiting: [first, second], answeredIds: [] });
    expect(cache()).toEqual([]);
    entries.push(completion("bash_7"));
  }
  expect(await replay(entries)).toEqual({ waiting: good ? [second] : [first, second], answeredIds: good ? [first.id] : [] });
  expect(cache()).toEqual(good ? [first.id] : []);
});
