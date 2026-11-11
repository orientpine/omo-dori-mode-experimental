import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick, type FlowDeps } from "../src/done-flow.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["clear", "replacement"])("a live asking lane's %s before its first watcher reconciliation preserves only same-agent delivery", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), min = 60_000, iso = (t: number) => new Date(t).toISOString();
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222", leadId = "99999999-9999-9999-9999-999999999999";
  const pane = "aoe_Asking_fedcba09", lead = "aoe_Dori_0a1b2c3d", cwd = "/home/test/asking", leadCwd = "/home/test/dori", owner = "100000000000000001";
  const sessionsDir = join(state.dir, "sessions"), dir = sessionDirFor(sessionsDir, cwd), leadDir = sessionDirFor(sessionsDir, leadCwd);
  mkdirSync(dir, { recursive: true }); mkdirSync(leadDir, { recursive: true });
  const oldPath = join(dir, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(dir, `2026-01-01T12-02-00-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const first = store.create("delivered?", ["yes"], "CARD", { tmux: pane, thread: "CARD" }, iso(at - min));
  const second = store.create("pending?", ["yes"], "CARD", { tmux: pane, thread: "CARD" }, iso(at - min));
  store.answer(first.id, "yes", "button", iso(at)); store.answer(second.id, "yes", "button", iso(at + min)); store.resolve(first.id);
  const delivered = { id: "answer-delivered", ts: iso(at + 300), kind: "answer", qid: first.id, tmux: pane, thread: "CARD", scope: "thread", channel_id: "CARD", author_id: owner, answer: "yes" };
  const pending = { ...delivered, id: "answer-pending", ts: iso(at + min + 300), qid: second.id };
  writeFileSync(oldPath, [
    { type: "session", id: old, cwd, timestamp: iso(at - 2 * min) },
    { type: "session_info", name: "Asking" },
    { type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify(delivered) },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(currentPath, `${JSON.stringify({ type: "session", id: current, cwd, timestamp: iso(at + 2 * min) })}\n${JSON.stringify({ type: "session_info", name: "Asking" })}\n`);
  writeFileSync(join(leadDir, `2026-01-01T12-02-00-000Z_${leadId}.jsonl`), `${JSON.stringify({ type: "session", id: leadId, cwd: leadCwd, timestamp: iso(at + 2 * min) })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`);
  utimesSync(oldPath, new Date(at + 500), new Date(at + 500)); utimesSync(currentPath, new Date(at + 2 * min), new Date(at + 2 * min));
  const world = newWorld(), cleared = kind === "clear", agent = cleared ? 21 : 31, child = agent + 1;
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: leadCwd, tool: "omo", profile: "main" }, { id: "fedcba0987654321", title: "Asking", path: cwd, tool: "omo", profile: "main" }];
  world.tmux = [lead, pane]; world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  world.agentStart = new Date(cleared ? at - 2 * min : at + 2 * min).toUTCString();
  world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${leadId}\n20 1 /bin/bash\n${agent} 20 /x/senpi/dist/bundle/cli.js --session-id ${cleared ? old : current}\n${child} ${agent} /bin/sleep 100\n`;
  if (!cleared) recordHerdrSession(state.dir, pane, { session: old, cwd, log: oldPath, agent: `21 ${new Date(at - 2 * min).toUTCString()}`, at: iso(at + 500) });
  const inbox = join(state.dir, "inbox.jsonl"); writeFileSync(inbox, [delivered, pending].map((row) => JSON.stringify(row)).join("\n"));
  const base = depsFor(world, fakeClock(at + 20 * min), state.dir, { backend: "aoe", leadPane: lead, sessionsDir, leadInboxMin: 0 });
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "tmux" && argv[1] === "display-message" && argv.some((a) => a.includes(pane))
    ? { code: 0, out: "20", err: "" } : argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === String(child)
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${current} PI_SESSION_FILE=${currentPath}`, err: "" } : base.run(argv, opts);
  try {
    await base.registry.write({ key: "asking", title: "Asking", thread: "none", pane, session: old, cwd, brief: "/brief", done: "merged acme/app#1", status: "paused", openedAt: iso(at - 2 * min) });
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect(await watchTick({ ...base, run, readGoal: async () => ({ status: "active" }), ownerInbox: { path: inbox, ownerId: owner, ownerChannel: "C" }, answeredCards: () => store.all(), answerHistory: () => readAnswerHistory(store.answersFile) })).toEqual([
      `LEAD_OWNER_WAITING ${lead} ${cleared ? 1 : 2} owner message(s), oldest ${cleared ? pending.ts : delivered.ts} (${cleared ? 18 : 19} min); woke the lead (SUBMITTED)`,
    ]);
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(cleared ? [delivered.id] : []);
  } finally { state.done(); }
});
