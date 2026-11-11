import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discordAnswered, readAnswerHistory, reconcileRows, sawAnswer } from "../src/missed-answers.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { sessionFile } from "../src/background.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { sessionDirFor } from "../src/session-id.ts";

const iso = (ms: number) => new Date(ms).toISOString();

const directRow = { id: "1569339203593044020", channel: "1555211347338199112", at: Date.parse("2026-01-01T12:00:00Z") };
const directCall = (id: string, code: string, name = "eval") => ({ type: "message", timestamp: "2026-01-01T12:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { code } }] } });
const directResult = (id: string, text: string) => ({ type: "message", timestamp: "2026-01-01T12:00:01.000Z", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } });
const directDetached = (id: string, text: string, language = "js") => ({ type: "custom_message", timestamp: "2026-01-01T12:00:01.000Z", customType: "senpi-codemode:notification", content: `<system-reminder>Detached eval cell ${id} (${language}) completed. ${text}` });
const directCommand = `dori send discord --to ${directRow.channel} --reply ${directRow.id} --text answer`;
const directAnswered = (entries: readonly object[]) => discordAnswered(entries.map((entry) => JSON.stringify(entry)).join("\n"), directRow);

test("a receipt counts only from the send's own tool result or detached cell", () => {
  const cases = [
    { name: "another tool quoting the pending id", expected: false, entries: [directCall("c1", directCommand), directResult("read-log", "Previously observed: c1 SENT 153000000000000001")] },
    { name: "another detached cell quoting the pending id", expected: false, entries: [directCall("c1", directCommand), directDetached("read-log", "Previously observed: c1 SENT 153000000000000001")] },
    { name: "a log-search tool quoting the command and receipt", expected: false, entries: [directCall("c1", directCommand, "grep"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a bash log search executing grep", expected: false, entries: [directCall("c1", `grep -F '${directCommand}' logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "an assigned shell pattern followed by grep", expected: false, entries: [directCall("c1", `pattern='${directCommand}'\ngrep -F -A1 "$pattern" logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a quoted command in narration", expected: false, entries: [directCall("c1", `console.log("${directCommand}")`), directResult("c1", "SENT 153000000000000001")] },
    { name: "an argv-array search pattern with a historical receipt", expected: false, entries: [directCall("c1", `grep -F -A1 '["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]' logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "an array assigned before a log search", expected: false, entries: [directCall("c1", `const pattern = ["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]; grep(pattern)`, "eval"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a stringified array used as a search pattern", expected: false, entries: [directCall("c1", `const pattern = JSON.stringify(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]); grep(pattern)`, "eval"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a nested array inside spawned grep arguments", expected: false, entries: [directCall("c1", `Bun.spawn(["grep", "-F", "-A1", JSON.stringify(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]), logfile])`), directResult("c1", "SENT 153000000000000001")] },
    { name: "a search array passed as a later spawn argument", expected: false, entries: [directCall("c1", `spawn("grep", ["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"])`), directResult("c1", "SENT 153000000000000001")] },
    { name: "the send's own tool result", expected: true, entries: [directCall("c1", directCommand), directResult("c1", "SENT 153000000000000001")] },
    { name: "an executed monitor command after other properties", expected: true, entries: [directCall("c1", `await tool.monitor({description: "send", command: ${JSON.stringify(directCommand)}, timeout_ms: ttl})`), directResult("c1", "SENT 153000000000000001")] },
    { name: "an executed tagged shell template", expected: true, entries: [directCall("c1", `await Bun.$\`${directCommand}\``), directResult("c1", "SENT 153000000000000001")] },
    { name: "an executed native shell string", expected: true, entries: [directCall("c1", `await exec(${JSON.stringify(directCommand)})`), directResult("c1", "SENT 153000000000000001")] },
    { name: "a regexp search method is not an execution wrapper", expected: false, entries: [directCall("c1", `pattern.exec(${JSON.stringify(directCommand)})`), directResult("c1", "SENT 153000000000000001")] },
    { name: "a wrapper executing a search instead of its description", expected: false, entries: [directCall("c1", `await tool.bash({description: ${JSON.stringify(directCommand)}, command: "grep -F pattern logfile"})`), directResult("c1", "SENT 153000000000000001")] },
    { name: "an executed wrapper without its matching receipt", expected: false, entries: [directCall("c1", `await tool.bash({command: ${JSON.stringify(directCommand)}})`), directResult("other", "SENT 153000000000000001")] },
    { name: "the send's own detached completion including a pipe in its cell id", expected: true, entries: [directCall("call_c1|fc_1", directCommand), directDetached("call_c1|fc_1", "SENT 153000000000000001")] },
    { name: "the Python send's own detached completion", expected: true, entries: [directCall("py-send", `subprocess.run(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}","--text","answer"])`), directDetached("py-send", "SENT 153000000000000001", "py")] },
    { name: "another Python cell's completion quoting the send id", expected: false, entries: [directCall("py-send", directCommand), directDetached("py-other", "py-send SENT 153000000000000001", "py")] },
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
  const mixed = `Bun.spawn(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]); Bun.spawn(['dori','send','discord','--to','1557744292393386074','--reply','1569339203593044021'])`;
  expect(directAnswered([directCall("c1", mixed), directResult("c1", "first command FAILED; second command SENT 153000000000000001")])).toBe(false);
});

test("mixed dynamic and literal posting operations remain ambiguous before argument extraction", () => {
  const literal = `Bun.spawn(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}","--text","answer"])`;
  const dynamic = `Bun.spawn(["dori","send","discord","--to",otherChannel,"--reply",otherId,"--text",otherText])`;
  for (const code of [`${dynamic}; ${literal}`, `${literal}; ${dynamic}`, `await tool.bash({command: otherCommand}); ${literal}`]) {
    expect(directAnswered([directCall("mixed", code), directResult("mixed", "dynamic command SENT 153000000000000001; literal command FAILED")])).toBe(false);
  }
});

test("executable wrapped eval commands clear only their own answered rows and cache", async () => {
  const state = withState(), deps = depsFor(newWorld(), fakeClock(directRow.at), state.dir);
  const entries = [directCall("wrapped", `await tool.bash({command: ${JSON.stringify(directCommand)}})`), directResult("wrapped", "SENT 153000000000000001")];
  const path = join(state.dir, "lead.jsonl"), text = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, text);
  try {
    const pending = { ...directRow, id: "still-waiting" };
    expect(await reconcileRows({ rows: [directRow, pending], cards: [], lead: { pane: "lead", path, title: "", text }, sessions: [], table: [], deps })).toEqual({ waiting: [pending], answeredIds: [directRow.id] });
  } finally { state.done(); }
});

test("template text is not executable but interpolation retains executable wrappers and arrays", () => {
  const argv = `Bun.spawn(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"])`;
  const cases = [
    { code: `const pattern = \`${argv}\`; grep(pattern)`, expected: false },
    { code: `const pattern = \`prefix \${"text"} ${argv}\`; grep(pattern)`, expected: false },
    { code: `const pattern = \`prefix \${\`nested ${argv}\`}\`; grep(pattern)`, expected: false },
    { code: `const output = \`sent \${await ${argv}}\``, expected: true },
    { code: `const output = \`sent \${await tool.bash({command: ${JSON.stringify(directCommand)}})}\``, expected: true },
  ];
  for (const c of cases) expect(directAnswered([directCall("template", c.code), directResult("template", "historical SENT 153000000000000001")]), c.code).toBe(c.expected);
});

test("following shell commands cannot supply a posting command's reply options or qids", () => {
  for (const separator of [";", "\n", "&&", "|"]) {
    const code = `dori send discord --to ${directRow.channel} --text status${separator} printf '%s\\n' --reply ${directRow.id}`;
    expect(directAnswered([directCall("boundary", code), directResult("boundary", "SENT 153000000000000001")]), separator).toBe(false);
    const thread = `dori send discord --to T-CARD --text status${separator} printf '%s\\n' Q1`;
    expect(discordAnswered([directCall("qid", thread), directResult("qid", "SENT 153000000000000001")].map((e) => JSON.stringify(e)).join("\n"), { ...directRow, qid: "Q1", thread: "T-CARD" }), separator).toBe(false);
  }
});

test.each([11, 99])("only records for the same agent %s can outlive the child that identified a resumed session", async (recordedPid) => {
  const state = withState(), world = newWorld(), old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222";
  const cwd = "/home/test/dori", pane = "aoe_Dori_0a1b2c3d", sessions = join(state.dir, "sessions"), folder = sessionDirFor(sessions, cwd);
  mkdirSync(folder, { recursive: true });
  const oldFile = join(folder, `2026-01-01T10-00-00-000Z_${old}.jsonl`), currentFile = join(folder, `2026-01-01T11-00-00-000Z_${current}.jsonl`);
  writeFileSync(oldFile, ""); writeFileSync(currentFile, "");
  utimesSync(oldFile, new Date(directRow.at - 1000), new Date(directRow.at - 1000));
  utimesSync(currentFile, new Date(directRow.at), new Date(directRow.at));
  world.agentStart = new Date(directRow.at - 60_000).toUTCString();
  world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${old}\n12 11 /bin/sleep 100\n`;
  recordHerdrSession(state.dir, pane, { session: current, cwd, log: currentFile, agent: `${recordedPid} ${world.agentStart}`, at: iso(directRow.at) });
  const deps = depsFor(world, fakeClock(directRow.at), state.dir);
  const run: typeof deps.run = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "12"
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${old} PI_SESSION_FILE=${oldFile}`, err: "" } : deps.run(argv, opts);
  try { expect((await sessionFile(run, sessions, pane, cwd, undefined, state.dir))?.path).toBe(recordedPid === 11 ? currentFile : oldFile); }
  finally { state.done(); }
});

test("an argv-array Discord reply uses its matching receipt", () => {
  const argv = `const p = Bun.spawn(["dori", "send", "discord", "--to", "${directRow.channel}", "--thread", "T-THREAD", "--reply", "${directRow.id}", "--text", "[done] Answer"], { env: process.env, stdin: "ignore", stdout: "pipe" }); console.log(await new Response(p.stdout).text()); await p.exited;`;
  expect(discordAnswered([directCall("c1", argv), directResult("c1", "SENT 153000000000000001")].map((entry) => JSON.stringify(entry)).join("\n"), { ...directRow, channel: "T-THREAD" })).toBe(true);
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

test("embedded answer records honor braces and exact qid boundaries", () => {
  const entry = { type: "custom_message", customType: "senpi-monitor:notification", content: '<system-reminder>{"kind":"answer","qid":"Q1","id":"new-answer","question":"Use {until}?","answer":"{yes}","ts":"2026-01-01T11:55:00.000Z"}</system-reminder>' };
  expect(sawAnswer(JSON.stringify(entry), "Q1", { ...directRow, qid: "Q1", id: "new-answer", at: Date.parse("2026-01-01T11:55:00.000Z") })).toBe(true);
  expect(sawAnswer(JSON.stringify(entry), "Q11", { ...directRow, qid: "Q11", id: "new-answer", at: Date.parse("2026-01-01T11:55:00.000Z") })).toBe(false);
});

test("card evidence requires delivered answer content, never assistant narration or search arguments", () => {
  const row = { ...directRow, id: "new-answer", qid: "Q1" };
  const answer = JSON.stringify({ kind: "answer", qid: "Q1", id: row.id });
  const cases = [
    { name: "assistant narration", expected: false, entry: { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } } },
    { name: "tool search arguments", expected: false, entry: directCall("search", `grep -F '${answer}' inbox.jsonl`) },
    { name: "assistant redelivery narration", expected: false, entry: { type: "message", message: { role: "assistant", content: [{ type: "text", text: `[DORI] ANSWER Q1 (button, ${iso(row.at)}): yes` }] } } },
    { name: "delivered object without answer kind", expected: false, entry: directResult("search", JSON.stringify({ qid: "Q1", id: row.id })) },
    { name: "delivered object with another kind", expected: false, entry: directResult("search", JSON.stringify({ kind: "search", qid: "Q1", id: row.id })) },
    { name: "tool result answer", expected: true, entry: directResult("read", answer) },
    { name: "monitor answer", expected: true, entry: { type: "custom_message", customType: "senpi-monitor:notification", content: answer } },
    { name: "user redelivery", expected: true, entry: { type: "message", message: { role: "user", content: [{ type: "text", text: `[DORI] ANSWER Q1 (button, ${iso(row.at)}): yes` }] } } },
  ];
  for (const c of cases) {
    expect(sawAnswer(JSON.stringify(c.entry), "Q1", row, iso(row.at)), c.name).toBe(c.expected);
    expect(sawAnswer(JSON.stringify(c.entry), "Q1"), `${c.name} without a row`).toBe(c.expected);
  }
});

test.each(["record", "wrapped-record", "old-only", "old-record", "old-then-current", "current-then-old", "future"])("mixed %s card deliveries check every version and persist only delivered IDs", async (kind) => {
  const state = withState(), store = new QuestionStore(join(state.dir, "cards")), oldAt = directRow.at - 120_000, currentAt = directRow.at - 60_000;
  const q = store.create("continue?", ["yes"], "T-CARD", { tmux: "lead", thread: "T-CARD" }, iso(oldAt - 1000));
  store.answer(q.id, "yes", "button", iso(oldAt)); store.reopen(q.id); store.answer(q.id, "yes", "button", iso(currentAt)); store.resolve(q.id);
  const old = { id: "old-answer", qid: q.id, at: oldAt + 300 }, current = { id: "current-answer", qid: q.id, at: currentAt + 300 }, pending = { id: "pending-answer", qid: "Q2", at: currentAt + 300 };
  const marker = (at: number) => `[DORI] ANSWER ${q.id} (button, ${iso(at)}): yes`;
  const record = { kind: "answer", qid: q.id, id: current.id, ts: iso(current.at) };
  const tail = kind === "record" ? JSON.stringify(record) : kind === "wrapped-record" ? JSON.stringify({ stdout: JSON.stringify(record) })
    : kind === "old-record" ? JSON.stringify({ ...record, id: old.id, ts: iso(old.at) }) : kind === "future" ? marker(directRow.at)
    : ["old-then-current", "current-then-old"].includes(kind) ? marker(currentAt) : "";
  const content = kind === "current-then-old" ? `${tail}\n${marker(oldAt)}` : `${marker(oldAt)}\n${tail}`;
  const text = JSON.stringify(directResult("read-inbox", content)), path = join(state.dir, "lead.jsonl"), good = ["record", "wrapped-record", "old-then-current", "current-then-old"].includes(kind);
  writeFileSync(path, text);
  try {
    const deps = { ...depsFor(newWorld(), fakeClock(directRow.at), state.dir), answerHistory: () => readAnswerHistory(store.answersFile) };
    expect(await reconcileRows({ rows: [old, current, pending], cards: store.all(), lead: { pane: "lead", path, title: "", text }, sessions: [], table: [], deps })).toEqual({ waiting: good ? [pending] : [current, pending], answeredIds: good ? [old.id, current.id] : [old.id] });
    expect(JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8"))).toEqual(good ? [old.id, current.id] : [old.id]);
  } finally { state.done(); }
});
