import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { reconcileRows } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["clear", "resolved-clear", "handover", "unrelated", "new-agent", "rolled-back", "wrong-target"])("send then %s before first reconciliation recovers only verified predecessor receipts", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), cwd = "/repo/dori", pane = "w1:p2";
  const oldId = "11111111-1111-1111-1111-111111111111", currentId = "22222222-2222-2222-2222-222222222222";
  const sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd);
  mkdirSync(folder, { recursive: true });
  const oldPath = join(folder, `2026-01-01T12-00-00-000Z_${oldId}.jsonl`);
  const currentPath = join(folder, `2026-01-01T12-00-02-000Z_${currentId}.jsonl`);
  const answered = { id: "1569339203593044020", channel: "C", at }, pending = { id: "1569339203593044021", channel: "C", at }, rows = [answered, pending];
  const transcript = (reply: string) => [
    { type: "session", id: oldId, cwd, timestamp: new Date(at).toISOString() },
    { type: "session_info", name: "Dori" },
    { type: "message", timestamp: new Date(at + 1000).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "send", name: "bash", arguments: { command: `dori send discord --to C --reply ${reply} --text answer` } }] } },
    { type: "message", timestamp: new Date(at + 1001).toISOString(), message: { role: "toolResult", toolCallId: "send", content: [{ type: "text", text: "SENT 153000000000000001" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(oldPath, transcript(answered.id));
  writeFileSync(join(folder, "2026-01-01T11-00-00-000Z_33333333-3333-3333-3333-333333333333.jsonl"), transcript(pending.id));
  const current = `${JSON.stringify({ type: "session", id: currentId, cwd, timestamp: new Date(at + 2000).toISOString() })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`;
  writeFileSync(currentPath, current);
  const agent = "11 Tue Nov 10 12:00:00 2026";
  if (kind === "clear" || kind === "new-agent") {
    recordHerdrSession(state.dir, pane, { session: oldId, cwd, log: oldPath, agent, at: new Date(at + 1001).toISOString() });
    recordHerdrSession(state.dir, pane, { session: currentId, cwd, log: currentPath, agent: kind === "new-agent" ? "11 restarted" : agent, at: new Date(at + 2000).toISOString() });
  }
  if (["handover", "rolled-back", "wrong-target"].includes(kind)) {
    const folder = join(state.dir, "handover");
    mkdirSync(folder, { recursive: true });
    const from = { pane: "w1:p1", session: oldId, cwd };
    writeFileSync(join(folder, "move.json"), JSON.stringify({ from, cwd, oldLog: oldPath }));
    writeFileSync(join(folder, "move.result.json"), JSON.stringify({ at: new Date(at + 2000).toISOString(), from, to: { pane: kind === "wrong-target" ? "w1:p99" : pane, session: currentId }, note: join(folder, "move.md"), result: kind === "rolled-back" ? "rolled-back" : "done", reasons: [] }));
  }
  const deps = depsFor(newWorld(), fakeClock(at + 3000), state.dir, { sessionsDir });
  const input = { rows, cards: [], lead: { pane, path: kind === "resolved-clear" ? oldPath : currentPath, title: "Dori", text: current }, sessions: [], table: [], deps };
  const good = ["clear", "resolved-clear", "handover"].includes(kind), answeredIds = good ? [answered.id] : [];
  try {
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect(await reconcileRows(input)).toEqual({ waiting: good ? [pending] : rows, answeredIds });
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(answeredIds);
    writeFileSync(oldPath, "");
    expect(await reconcileRows(input)).toEqual({ waiting: good ? [pending] : rows, answeredIds });
  } finally { state.done(); }
});
