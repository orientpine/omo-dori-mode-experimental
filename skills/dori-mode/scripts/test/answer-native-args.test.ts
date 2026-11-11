import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reconcileRows } from "../src/missed-answers.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["foreground", "detached", "unknown-channel", "unknown-reply", "second-post", "unresolved-post", "unknown-qid"])("a native reply with %s text/routing keeps exact reconciliation and cache attribution", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z");
  const first = { id: "1569339203593044020", channel: "C-A", at }, second = { id: "1569339203593044021", channel: "C-B", at };
  const card = { id: "card-answer", qid: "Q1", thread: first.channel, at }, rows = [first, second, card];
  const args = `["dori","send","discord","--to",${kind === "unknown-channel" ? "channel" : JSON.stringify(first.channel)},"--reply",${kind === "unknown-reply" ? "reply" : JSON.stringify(first.id)},"--text",body]`;
  const other = kind === "second-post" ? `Bun.spawnSync(["dori","send","discord","--to","${second.channel}","--reply","${second.id}","--text","other"]);`
    : kind === "unresolved-post" ? 'Bun.spawnSync(["dori","send","discord","--to",channel,"--reply",reply,"--text",body]);' : "";
  const code = `const body = ${kind === "unknown-qid" ? "process.env.ANSWER_BODY" : '"answer"'}; const channel = "${second.channel}", reply = "${second.id}"; const p = Bun.spawnSync(${args}); ${other} console.log(p.stdout.toString("utf8").trim());`;
  const sent = "SENT 153000000000000001", detached = kind === "detached", good = ["foreground", "detached", "unknown-qid"].includes(kind);
  const entries: object[] = [
    { type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "send", name: "eval", arguments: { language: "js", code } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "send", content: [{ type: "text", text: detached ? "Eval cell send detached and is running" : sent }] } },
  ];
  const path = join(state.dir, "lead.jsonl"), cache = join(state.dir, "lead-answered.json");
  const replay = () => {
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n"); writeFileSync(path, text);
    return reconcileRows({ rows, cards: [], lead: { pane: "lead", path, title: "", text }, sessions: [], table: [], deps: depsFor(newWorld(), fakeClock(at + 3000), state.dir) });
  };
  try {
    if (detached) {
      expect(await replay()).toEqual({ waiting: rows, answeredIds: [] });
      expect(existsSync(cache)).toBe(false);
      entries.push({ type: "custom_message", customType: "senpi-codemode:notification", content: `Detached eval cell send (js) completed.\n${sent}` });
    }
    expect(await replay()).toEqual({ waiting: good ? [second, card] : rows, answeredIds: good ? [first.id] : [] });
    expect(existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : []).toEqual(good ? [first.id] : []);
  } finally { state.done(); }
});
