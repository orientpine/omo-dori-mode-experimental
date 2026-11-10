import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { keepSessions } from "../src/lane-handover.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory, reconcileRows } from "../src/missed-answers.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["facts-open", "facts-closed", "history-closed", "wrong-key", "wrong-header", "missing-history", "rolled-back"])("asking lane %s keeps only its delivered answer after handover and pane closure", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), iso = (t: number) => new Date(t).toISOString();
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222";
  const oldPane = "aoe_Asking_11111111", pane = "aoe_Asking_22222222", cwd = "/repo/asking", historyOnly = kind === "history-closed";
  const sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd), archive = historyOnly ? folder : join(state.dir, "retained logs"), moves = join(state.dir, "handover", "lanes");
  mkdirSync(folder, { recursive: true }); mkdirSync(archive, { recursive: true }); mkdirSync(moves, { recursive: true });
  const oldPath = join(archive, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(folder, `2026-01-01T12-00-02-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const first = store.create("first?", ["yes"], "CARD", { tmux: oldPane, session: historyOnly ? old : null, thread: "CARD" }, iso(at - 1000));
  const second = store.create("second?", ["yes"], "CARD", { tmux: oldPane, session: historyOnly ? old : null, thread: "CARD" }, iso(at - 900));
  store.answer(first.id, "yes", "button", iso(at)); store.answer(second.id, "yes", "button", iso(at + 1000));
  const delivered = { id: "answer-delivered", at: at + 300, qid: first.id, tmux: oldPane, thread: "CARD" }, pending = { ...delivered, id: "answer-pending", at: at + 1300, qid: second.id };
  writeFileSync(oldPath, [
    { type: "session", id: kind === "wrong-header" ? current : old, cwd, timestamp: iso(at - 2000) },
    { type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify({ kind: "answer", qid: first.id, id: delivered.id, ts: iso(delivered.at) }) },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(currentPath, JSON.stringify({ type: "session", id: current, cwd, timestamp: iso(at + 2000) }));
  const lane: Lane = { key: "asking", title: "Asking", thread: "none", pane: oldPane, session: old, cwd, brief: "/brief", done: "merged acme/app#1", openedAt: iso(at - 60_000) };
  const deps = { ...depsFor(newWorld(), fakeClock(at + 3000), state.dir, { backend: "aoe", sessionsDir }), answerHistory: () => readAnswerHistory(store.answersFile) };
  const leadPath = join(state.dir, "lead.jsonl"); writeFileSync(leadPath, "");
  try {
    await deps.registry.write(kind === "missing-history" ? { ...lane, pane, session: current } : lane);
    if (kind !== "missing-history") {
      await deps.registry.patch(lane.key, { pane });
      await keepSessions(deps, lane.key, old, current);
    }
    store.retarget({ tmux: oldPane }, { tmux: pane });
    if (!historyOnly) {
      writeFileSync(join(moves, "move.json"), JSON.stringify({ lane, from: { pane: oldPane, session: old, cwd }, cwd, oldLog: oldPath }));
      writeFileSync(join(moves, "move.result.json"), JSON.stringify({ at: iso(at + 2000), key: kind === "wrong-key" ? "other" : lane.key, to: pane, note: join(moves, "move.md"), result: kind === "rolled-back" ? "rolled-back" : "done" }));
    }
    const replacement = await deps.registry.read(lane.key);
    if (kind !== "facts-open" && replacement) expect((await closeLane(deps, replacement, "handover then finished")).closed).toBe(true);
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    const good = ["facts-open", "facts-closed", "history-closed"].includes(kind);
    expect(await reconcileRows({ rows: [delivered, pending], cards: store.all(), lead: { pane: "lead", path: leadPath, title: "", text: "" }, sessions: [], table: [], deps })).toEqual({ waiting: good ? [pending] : [delivered, pending], answeredIds: good ? [delivered.id] : [] });
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(good ? [delivered.id] : []);
  } finally { state.done(); }
});
