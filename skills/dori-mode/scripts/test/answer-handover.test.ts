import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick } from "../src/done-flow.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["committed", "chain", "wrong-pane", "wrong-id", "wrong-cwd", "wrong-target", "rolled-back"])("card delivery then %s handover and old pane removal survives the first watcher tick", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), min = 60_000, iso = (t: number) => new Date(t).toISOString();
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222", middle = "33333333-3333-3333-3333-333333333333";
  const oldPane = "aoe_Old_11111111", pane = "aoe_Dori_22222222", cwd = "/repo/dori", owner = "100000000000000001";
  const sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd), archive = join(state.dir, "retained logs"), handover = join(state.dir, "handover");
  mkdirSync(folder, { recursive: true }); mkdirSync(archive); mkdirSync(handover);
  const oldPath = join(archive, `old_${old}.jsonl`), currentPath = join(folder, `2026-01-01T12-03-00-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const q = store.create("continue?", ["yes"], "T-CARD", { tmux: oldPane, thread: "T-CARD" }, iso(at - min));
  store.answer(q.id, "yes", "button", iso(at));
  const delivered = { ts: iso(at + 300), id: "answer-delivered", kind: "answer", qid: q.id, tmux: oldPane, thread: "T-CARD", scope: "thread", channel_id: "T-CARD", author_id: owner, answer: "yes" };
  const pending = { ...delivered, ts: iso(at + min + 300), id: "answer-pending" };
  writeFileSync(oldPath, [
    { type: "session", id: old, cwd, timestamp: iso(at - 2 * min) },
    { type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify(delivered) },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  store.reopen(q.id); store.answer(q.id, "yes", "button", iso(at + min)); store.resolve(q.id);
  writeFileSync(currentPath, `${JSON.stringify({ type: "session", id: current, cwd, timestamp: iso(at + 3 * min) })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`);
  const from = { pane: kind === "wrong-pane" ? "aoe_Other_99999999" : oldPane, session: kind === "wrong-id" ? middle : old, cwd: kind === "wrong-cwd" ? "/other" : cwd };
  const note = join(handover, "move.md");
  writeFileSync(join(handover, "move.json"), JSON.stringify({ from, cwd, oldLog: oldPath }));
  writeFileSync(join(handover, "move.result.json"), JSON.stringify({ at: iso(at + 2 * min), from, to: { pane: kind === "chain" ? "aoe_Middle_33333333" : pane, session: kind === "chain" || kind === "wrong-target" ? middle : current }, note, result: kind === "rolled-back" ? "rolled-back" : "done", reasons: [] }));
  if (kind === "chain") {
    const path = join(archive, `middle_${middle}.jsonl`), from = { pane: "aoe_Middle_33333333", session: middle, cwd };
    writeFileSync(path, JSON.stringify({ type: "session", id: middle, cwd, timestamp: iso(at + 2 * min) }));
    writeFileSync(join(handover, "next.json"), JSON.stringify({ from, cwd, oldLog: path }));
    writeFileSync(join(handover, "next.result.json"), JSON.stringify({ at: iso(at + 3 * min), from, to: { pane, session: current }, note: join(handover, "next.md"), result: "done", reasons: [] }));
  }
  const world = newWorld();
  world.aoe = [{ id: "11111111aaaaaaaa", title: "Old", path: cwd, tool: "omo", profile: "main" }, { id: "22222222aaaaaaaa", title: "Dori", path: cwd, tool: "omo", profile: "main" }];
  world.tmux = [oldPane, pane];
  // The former lead is removed after the committed move, before any reconciliation can cache the delivery.
  world.aoe = world.aoe.filter((s) => s.title !== "Old"); world.tmux = world.tmux.filter((p) => p !== oldPane);
  world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${current}\n`;
  world.agentStart = iso(at + 3 * min);
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [delivered, pending].map((row) => JSON.stringify(row)).join("\n"));
  const deps = { ...depsFor(world, fakeClock(at + 20 * min), state.dir, { backend: "aoe", leadPane: pane, sessionsDir, leadInboxMin: 0 }), readGoal: async () => ({ status: "active" }), ownerInbox: { path: inbox, ownerId: owner, ownerChannel: "C" }, answeredCards: () => store.all(), answerHistory: () => readAnswerHistory(store.answersFile) };
  try {
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect(await deps.registry.list()).toEqual([]);
    const good = kind === "committed" || kind === "chain";
    expect(await watchTick(deps)).toEqual([`LEAD_OWNER_WAITING ${pane} ${good ? 1 : 2} owner message(s), oldest ${good ? pending.ts : delivered.ts} (${good ? 18 : 19} min); woke the lead (SUBMITTED)`]);
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(good ? [delivered.id] : []);
  } finally { state.done(); }
});
