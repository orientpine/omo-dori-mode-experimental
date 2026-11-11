import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reconcileRows, type AnswerRow } from "../src/missed-answers.ts";
import { sentLine } from "../src/send-dedupe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const at = Date.parse("2026-01-01T12:00:00Z"), id = "153000000000000001";
const first = { id: "1569339203593044020", channel: "C-A", at }, pending = { id: "1569339203593044021", channel: "C-B", at };
const call = (command: string, tool: string) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "send", name: tool, arguments: tool === "eval" ? { code: command } : { command } }] } });
const result = (text: string, details: object = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: "send", content: [{ type: "text", text }], details } });
const replay = async (entries: readonly object[], rows: readonly AnswerRow[]) => {
  const state = withState(), text = entries.map((entry) => JSON.stringify(entry)).join("\n"), path = join(state.dir, "lead.jsonl");
  writeFileSync(path, text);
  try {
    const reconciled = await reconcileRows({ rows, cards: [], lead: { pane: "lead", path, title: "", text }, sessions: [], table: [], deps: depsFor(newWorld(), fakeClock(at + 3000), state.dir) });
    const cache = join(state.dir, "lead-answered.json");
    return { ...reconciled, cached: existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : [] };
  } finally { state.done(); }
};

test.each(["foreground", "nested", "detached", "background"])("%s receipts reject refused-send diagnostics without clearing reconciliation or cache", async (transport) => {
  const send = `dori send discord --to ${first.channel} --reply ${first.id} --text answer`;
  const refused = [
    `UNKNOWN_OPTION send: unexpected "SENT ${id}"; nothing was sent`,
    `SPEECH_REFUSED send: it is in polite speech ("SENT ${id}"); nothing was sent`,
    `SENT ${id}"; nothing was sent`,
    `"POSTED ${id}"`,
    `historical SENT ${id}`,
    `SENT ${id} len=6 sha=12345678 first="\\q"`,
  ];
  for (const output of [...refused, sentLine("SENT", { id, content: "answer" })]) {
    const command = `${send}${output.startsWith("UNKNOWN_OPTION") ? ` SENT ${id}` : ""}`;
    const good = !refused.includes(output), direct = transport === "foreground" || transport === "background";
    const entries: object[] = [call(direct ? command : `display(await tool.bash({command:${JSON.stringify(command)}}))`, direct ? "bash" : "eval")];
    if (transport === "detached") entries.push(result("Eval cell send detached and is running"), { type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell send (js) completed.\n${output}` });
    else if (transport === "background") entries.push(result("Command running in background with ID: bash_7"), { type: "custom_message", customType: "senpi-monitor:notification", content: `<system-reminder>Background terminal session bash_7 finished: completed (exit code 0).\n${output}</system-reminder>` });
    else entries.push(result(output, transport === "nested" ? { toolCalls: [{ name: "bash", args: { command }, resultPreview: output }] } : {}));
    expect(await replay(entries, [first, pending]), output).toEqual({ waiting: good ? [pending] : [first, pending], answeredIds: good ? [first.id] : [], cached: good ? [first.id] : [] });
  }
});

test.each(["done", "wait"])("standalone thread %s extracts its own destination and QID with a genuine receipt", async (verb) => {
  const row = { id: "card-answer", qid: "Q1", thread: "CARD", at }, other = { ...row, id: "other-card", qid: "Q2" };
  for (const form of ["shell", "native", "wrapped"]) {
    const command = `dori thread --lane work ${verb} 'discord:CARD' 'Q1 applied'`;
    const code = form === "native" ? `console.log(Bun.spawnSync(["dori","thread","${verb}","discord:CARD","Q1 applied"]).stdout.toString())` : form === "wrapped" ? `display(await tool.bash({command:${JSON.stringify(command)}}))` : command;
    const receipt = `${sentLine("POSTED", { id, content: "Q1 applied" })} ${verb === "done" ? "THREAD_DONE" : "THREAD_WAITING"}`;
    expect(await replay([call(code, form === "shell" ? "bash" : "eval"), result(receipt)], [row, other, first]), form).toEqual({ waiting: [other, first], answeredIds: [row.id], cached: [row.id] });
  }
});

test.each(["truncated", "no-args", "other-tool", "other-command", "source-peers", "source-native", "historical-print", "refused", "preview-only"])("wrapped %s preview uses full receipt content only with sole execution provenance", async (kind) => {
  const command = `dori send discord --to ${first.channel} --reply ${first.id} --text answer`, receipt = sentLine("SENT", { id, content: "answer ".repeat(10) });
  const preview = receipt.slice(0, -8) + String.fromCodePoint(0x2026);
  const post = `display(await tool.bash({command:${JSON.stringify(command)}}))`;
  const code = kind === "source-peers" ? `display(await tool.bash({command:"grep -F SENT history"})); ${post}`
    : kind === "source-native" ? `console.log(Bun.spawnSync(["grep","-F","SENT","history"]).stdout.toString()); ${post}`
    : kind === "historical-print" ? `await tool.bash({command:${JSON.stringify(command)}}); console.log(await Bun.file("history").text())` : post;
  const own = { name: "bash", ...(kind === "no-args" ? {} : { args: { command: kind === "other-command" ? "pwd" : command } }), resultPreview: kind === "preview-only" ? receipt : preview };
  const output = kind === "refused" ? `UNKNOWN_OPTION send: unexpected "SENT ${id}"; nothing was sent` : kind === "preview-only" ? "wrapped output not printed" : receipt;
  const details = { toolCalls: [own, ...(kind === "other-tool" ? [{ name: "read", resultPreview: receipt }] : [])] }, good = ["truncated", "no-args", "preview-only"].includes(kind);
  expect(await replay([call(code, "eval"), result(output, details)], [first, pending])).toEqual({ waiting: good ? [pending] : [first, pending], answeredIds: good ? [first.id] : [], cached: good ? [first.id] : [] });
});
