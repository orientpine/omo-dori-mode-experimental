import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { keepSessions } from "../src/lane-handover.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory, reconcileRows } from "../src/missed-answers.ts";
import type { Lane } from "../src/registry.ts";
import { procTable, sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["lead", "lane"].flatMap((role) => ["delivery", "ack", "live-old", "chain", "unrelated", "rolled-back", "wrong-source", "wrong-session"].map((kind) => [role, kind] as const)))("%s successor %s proves only inherited post-move card delivery or acknowledgement", async (role, kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), iso = (t: number) => new Date(t).toISOString(), cwd = "/repo/dori";
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222", middle = "33333333-3333-3333-3333-333333333333";
  const oldPane = "aoe_Old_11111111", pane = "aoe_Dori_22222222", middlePane = "aoe_Middle_33333333", sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd);
  const moves = join(state.dir, "handover", ...(role === "lane" ? ["lanes"] : []));
  mkdirSync(folder, { recursive: true }); mkdirSync(moves, { recursive: true });
  const oldPath = join(folder, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(folder, `2026-01-01T12-00-04-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const q = store.create("first?", ["yes"], "CARD", { tmux: oldPane, session: old, thread: "CARD" }, iso(at - 1000));
  const q2 = store.create("second?", ["yes"], "CARD", { tmux: oldPane, session: old, thread: "CARD" }, iso(at - 900));
  store.answer(q.id, "yes", "button", iso(at)); store.answer(q2.id, "yes", "button", iso(at + 1000));
  const answered = { id: "answer-delivered", qid: q.id, at: at + 300, thread: "CARD", tmux: oldPane }, pending = { ...answered, id: "answer-pending", qid: q2.id, at: at + 1300 };
  const evidenceAt = at + (kind === "chain" ? 3000 : 5000), evidence = kind === "ack" ? [
    { type: "message", timestamp: iso(at + 5000), message: { role: "assistant", content: [{ type: "toolCall", id: "reply", name: "bash", arguments: { command: `dori send discord --to CARD --text '${q.id} applied'` } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "reply", content: [{ type: "text", text: "SENT 153000000000000001" }] } },
  ] : [{ type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify({ kind: "answer", qid: q.id, id: answered.id, ts: iso(evidenceAt) }) }];
  writeFileSync(oldPath, JSON.stringify({ type: "session", id: old, cwd, timestamp: iso(at - 2000) }));
  const currentText = [{ type: "session", id: kind === "wrong-session" ? middle : current, cwd, timestamp: iso(at + 4000) }, ...(kind === "chain" ? [] : evidence)].map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(currentPath, currentText);
  const leadPath = role === "lead" ? currentPath : join(state.dir, "lead.jsonl");
  if (role !== "lead") writeFileSync(leadPath, JSON.stringify({ type: "session", id: "99999999-9999-9999-9999-999999999999", cwd: "/repo/lead" }));
  const world = newWorld();
  if (kind === "live-old") {
    world.aoe = [{ id: "11111111aaaaaaaa", title: "Old", path: cwd, tool: "omo", profile: "main" }];
    world.tmux = [oldPane]; world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${old}\n`; world.agentStart = iso(at - 2000);
  }
  const deps = { ...depsFor(world, fakeClock(at + 6000), state.dir, { sessionsDir }), answerHistory: () => readAnswerHistory(store.answersFile) };
  const lane: Lane = { key: "work", title: "Work", pane: oldPane, session: old, cwd, thread: "none", brief: "/brief", done: "merged acme/app#1", status: "paused", openedAt: iso(at - 60_000) };
  try {
    if (role === "lane") await deps.registry.write(lane);
    const steps = kind === "chain" ? [{ pane: middlePane, session: middle }, { pane, session: current }] : [{ pane, session: current }];
    let from = { pane: kind === "wrong-source" ? "aoe_Other_99999999" : oldPane, session: old, cwd }, path = oldPath;
    for (const [i, to] of steps.entries()) {
      const note = join(moves, `move-${i}.md`);
      if (role === "lane") { await deps.registry.patch(lane.key, { pane: to.pane }); await keepSessions(deps, lane.key, from.session, to.session); }
      if (kind !== "unrelated") {
        writeFileSync(note.replace(/\.md$/, ".json"), JSON.stringify({ from, cwd, oldLog: path, ...(role === "lane" ? { lane } : {}) }));
        writeFileSync(note.replace(/\.md$/, ".result.json"), JSON.stringify({ at: iso(at + 2000 + i * 2000), from, key: lane.key, to: role === "lead" ? to : to.pane, note, result: kind === "rolled-back" ? "rolled-back" : "done" }));
      }
      if (to.session === middle) {
        path = join(folder, `2026-01-01T12-00-02-000Z_${middle}.jsonl`);
        writeFileSync(path, [{ type: "session", id: middle, cwd, timestamp: iso(at + 2000) }, ...evidence].map((entry) => JSON.stringify(entry)).join("\n"));
      }
      from = { ...to, cwd };
    }
    store.retarget({ tmux: oldPane }, { tmux: pane, session: current });
    const good = ["delivery", "ack", "live-old", "chain"].includes(kind);
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect(await reconcileRows({ rows: [answered, pending], cards: store.all(), lead: { pane: role === "lead" ? pane : "lead", path: leadPath, title: "", text: readFileSync(leadPath, "utf8") }, sessions: world.aoe, table: await procTable(deps.run), deps })).toEqual({ waiting: good ? [pending] : [answered, pending], answeredIds: good ? [answered.id] : [] });
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(good ? [answered.id] : []);
  } finally { state.done(); }
});
