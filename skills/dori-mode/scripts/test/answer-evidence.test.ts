import { expect, test } from "bun:test";

import { discordAnswered, sawAnswer } from "../src/missed-answers.ts";

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
    { name: "an argv-array search pattern with a historical receipt", expected: false, entries: [directCall("c1", `grep -F -A1 '["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]' logfile`, "bash"), directResult("c1", "SENT 153000000000000001")] },
    { name: "an array assigned before a log search", expected: false, entries: [directCall("c1", `const pattern = ["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]; grep(pattern)`, "eval"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a stringified array used as a search pattern", expected: false, entries: [directCall("c1", `const pattern = JSON.stringify(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]); grep(pattern)`, "eval"), directResult("c1", "SENT 153000000000000001")] },
    { name: "a nested array inside spawned grep arguments", expected: false, entries: [directCall("c1", `Bun.spawn(["grep", "-F", "-A1", JSON.stringify(["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"]), logfile])`), directResult("c1", "SENT 153000000000000001")] },
    { name: "a search array passed as a later spawn argument", expected: false, entries: [directCall("c1", `spawn("grep", ["dori","send","discord","--to","${directRow.channel}","--reply","${directRow.id}"])`), directResult("c1", "SENT 153000000000000001")] },
    { name: "the send's own tool result", expected: true, entries: [directCall("c1", directCommand), directResult("c1", "SENT 153000000000000001")] },
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
