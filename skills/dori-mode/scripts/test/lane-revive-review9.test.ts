import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { recordMove } from "../src/lane-lifecycle.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory } from "../src/missed-answers.ts";
import { Registry } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { laneOf, SESSION, T0 } from "./lane-revive-rig.ts";

// Review 9 of #535: an old read written back after two revives, or as a not-done objection, keeps the revived pane; a
// handover to a reused terminal number (a new session) is not held back; an answer asked from a pane a lane was revived
// away from is read through that lane's live pane, a /clear there included.
const at = (ms: number) => new Date(ms).toISOString();
const move = (dir: string, from: string, to: string) => recordMove(dir, { key: "h3-charsheet", session: SESSION, from, to, at: at(T0) });

test("an old read naming the first pane, written back after two revives, keeps the pane the lane runs in now", async () => {
  const state = withState();
  try {
    const registry = new Registry(state.dir);
    const old = laneOf(state.dir, { pane: "hc:t27" });
    await registry.write({ ...old, pane: "hc:t3" });
    move(state.dir, "hc:t27", "hc:t2");
    move(state.dir, "hc:t2", "hc:t3");
    await registry.write(old);
    expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t3");
    // a handover that lands in a terminal hc numbered like the first pane runs a new session: it moves the lane
    await registry.write({ ...old, session: "77777777-2222-4333-8444-555555555555" });
    expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t27");
  } finally {
    state.done();
  }
});

test("a not-done objection written from an old read keeps the revived pane", async () => {
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { backend: "herdr" });
    const old = laneOf(state.dir, { status: "done-claimed" });
    await deps.registry.write({ ...old, pane: "hc:t1" });
    move(state.dir, "hc:t27", "hc:t1");
    expect(await objectDone({ ...deps, run: async () => ({ code: 1, out: "", err: "" }) }, old, ["a signal is not live"])).toStartWith("LANE_NOT_DONE h3-charsheet");
    const after = await deps.registry.read("h3-charsheet");
    expect([after?.status, after?.pane]).toEqual(["not-done", "hc:t1"]);
  } finally {
    state.done();
  }
});

test("an answer asked from a pane the lane was revived away from counts as seen once the revived pane's session after a /clear read it", async () => {
  // Given: two cards asked from the gone pane; the lane was revived into the asking pane on session old, which then ran
  // /clear into current (its child names current); the first answer reached current's log, the second nowhere yet
  const state = withState(), t = Date.parse("2026-01-01T12:00:00Z"), min = 60_000;
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222", leadId = "99999999-9999-9999-9999-999999999999";
  const gone = "aoe_Gone_11112222", pane = "aoe_Asking_fedcba09", lead = "aoe_Dori_0a1b2c3d", cwd = "/home/test/asking", leadCwd = "/home/test/dori", owner = "100000000000000001";
  const sessionsDir = join(state.dir, "sessions"), dir = sessionDirFor(sessionsDir, cwd), leadDir = sessionDirFor(sessionsDir, leadCwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(leadDir, { recursive: true });
  const oldPath = join(dir, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(dir, `2026-01-01T12-02-00-000Z_${current}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const first = store.create("delivered?", ["yes"], "CARD", { tmux: gone, thread: "CARD" }, at(t - min));
  const second = store.create("pending?", ["yes"], "CARD", { tmux: gone, thread: "CARD" }, at(t - min));
  store.answer(first.id, "yes", "button", at(t));
  store.answer(second.id, "yes", "button", at(t + min));
  store.resolve(first.id);
  const delivered = { id: "answer-delivered", ts: at(t + 300), kind: "answer", qid: first.id, tmux: gone, thread: "CARD", scope: "thread", channel_id: "CARD", author_id: owner, answer: "yes" };
  const pending = { ...delivered, id: "answer-pending", ts: at(t + min + 300), qid: second.id };
  writeFileSync(oldPath, `${JSON.stringify({ type: "session", id: old, cwd, timestamp: at(t - 2 * min) })}\n${JSON.stringify({ type: "session_info", name: "Asking" })}\n`);
  writeFileSync(currentPath, [{ type: "session", id: current, cwd, timestamp: at(t + 2 * min) }, { type: "session_info", name: "Asking" }, { type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify(delivered) }].map((e) => JSON.stringify(e)).join("\n"));
  writeFileSync(join(leadDir, `2026-01-01T12-02-00-000Z_${leadId}.jsonl`), `${JSON.stringify({ type: "session", id: leadId, cwd: leadCwd, timestamp: at(t + 2 * min) })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`);
  utimesSync(oldPath, new Date(t + 500), new Date(t + 500));
  utimesSync(currentPath, new Date(t + 2 * min), new Date(t + 2 * min));
  const world = newWorld();
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: leadCwd, tool: "omo", profile: "main" }, { id: "fedcba0987654321", title: "Asking", path: cwd, tool: "omo", profile: "main" }];
  world.tmux = [lead, pane];
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  world.agentStart = new Date(t - 2 * min).toUTCString();
  world.ps = `10 1 /bin/bash\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${leadId}\n20 1 /bin/bash\n21 20 /x/senpi/dist/bundle/cli.js --session-id ${old}\n22 21 /bin/sleep 100\n`;
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [delivered, pending].map((row) => JSON.stringify(row)).join("\n"));
  const base = depsFor(world, fakeClock(t + 20 * min), state.dir, { backend: "aoe", leadPane: lead, sessionsDir, leadInboxMin: 0 });
  const run: FlowDeps["run"] = async (argv, opts) =>
    argv[0] === "tmux" && argv[1] === "display-message" && argv.some((a) => a.includes(pane)) ? { code: 0, out: "20", err: "" }
    : argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "22" ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${current} PI_SESSION_FILE=${currentPath}`, err: "" }
    : base.run(argv, opts);
  try {
    await base.registry.write({ key: "asking", title: "Asking", thread: "none", pane, session: old, cwd, brief: "/brief", done: "merged acme/app#1", status: "paused", openedAt: at(t - 2 * min) });
    recordMove(state.dir, { key: "asking", session: old, from: gone, to: pane, at: at(t + 500) });
    // When
    const out = await watchTick({ ...base, run, readGoal: async () => ({ status: "active" }), ownerInbox: { path: inbox, ownerId: owner, ownerChannel: "C" }, answeredCards: () => store.all(), answerHistory: () => readAnswerHistory(store.answersFile) });
    // Then: only the second answer still waits; the first counts as delivered
    expect(out).toEqual([`LEAD_OWNER_WAITING ${lead} 1 owner message(s), oldest ${pending.ts} (18 min); woke the lead (SUBMITTED)`]);
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual([delivered.id]);
  } finally {
    state.done();
  }
});
