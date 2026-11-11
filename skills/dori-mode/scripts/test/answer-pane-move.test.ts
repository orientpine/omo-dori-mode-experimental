import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick } from "../src/done-flow.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { reconcileRows } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState } from "./fakes.ts";

const at = Date.parse("2026-01-01T12:00:00Z");
const session = "01a1c440-e7c0-768c-9f01-6b97bfe3e6f4";
const otherSession = "11111111-1111-1111-1111-111111111111";
const answered = { id: "1569933837268680785", channel: "C-OWNER", at };
const pending = { ...answered, id: "1569933894902612000", at: at + 1000 };
const iso = (ms: number) => new Date(ms).toISOString();

type Identity = { readonly session: string; readonly cwd: string };

const transcript = (identity: Identity, title: string, reply?: string): string => [
  { type: "session", id: identity.session, cwd: identity.cwd, timestamp: iso(at - 1000) },
  { type: "session_info", name: title },
  ...(reply ? [
    { type: "message", timestamp: iso(at + 2000), message: { role: "assistant", content: [{ type: "toolCall", id: "send", name: "bash", arguments: { command: `dori send discord --to C-OWNER --reply ${reply} --text answer` } }] } },
    { type: "message", timestamp: iso(at + 2001), message: { role: "toolResult", toolCallId: "send", content: [{ type: "text", text: "SENT 153000000000000001 len=6 sha=12345678 first=\"answer\"" }] } },
  ] : []),
].map((entry) => JSON.stringify(entry)).join("\n");

const moveFixture = (kind: string) => {
  const state = withState(), cwd = "/repo/dori", sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd);
  mkdirSync(folder, { recursive: true });
  const oldPath = join(state.dir, `old_${session}.jsonl`), currentPath = join(folder, `2026-01-01T12-03-00-000Z_${session}.jsonl`);
  const oldIdentity = { session: kind === "wrong-session" ? otherSession : session, cwd: kind === "wrong-cwd" ? "/other" : cwd };
  const headerIdentity = kind === "wrong-header" ? { session: otherSession, cwd } : oldIdentity;
  const reply = kind === "unrelated-receipt" ? "1569000000000000000" : answered.id;
  writeFileSync(oldPath, transcript(headerIdentity, "Old lead", reply));
  const currentText = transcript({ session, cwd }, "Revived lead");
  writeFileSync(currentPath, currentText);
  recordHerdrSession(state.dir, "w1:pA", { ...oldIdentity, log: oldPath, agent: "4001 old", at: iso(at + 2001) });
  recordHerdrSession(state.dir, "w2:p2", { session, cwd, log: currentPath, agent: "5001 revived", at: iso(at + 3000) });
  return { state, cwd, sessionsDir, oldPath, currentPath, currentText };
};

const answeredCache = (dir: string): string[] => {
  const path = join(dir, "lead-answered.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
};

test.each(["moved", "wrong-session", "wrong-cwd", "wrong-header", "unrelated-receipt"])("manual pane move %s recovers only exact same-session reply evidence", async (kind) => {
  const f = moveFixture(kind), good = kind === "moved";
  const deps = depsFor(newWorld(), fakeClock(at + 3000), f.state.dir, { sessionsDir: f.sessionsDir });
  const input = { rows: [answered, pending], cards: [], lead: { pane: "w2:p2", path: f.currentPath, title: "Revived lead", text: f.currentText }, sessions: [], table: [], deps };
  const expected = { waiting: good ? [pending] : [answered, pending], answeredIds: good ? [answered.id] : [] };
  try {
    expect(answeredCache(f.state.dir)).toEqual([]);
    expect(await reconcileRows(input)).toEqual(expected);
    expect(answeredCache(f.state.dir)).toEqual(expected.answeredIds);
    expect(await reconcileRows(input)).toEqual(expected);
  } finally { f.state.done(); }
});

test("watch after a manual pane move wakes only for the new owner row once", async () => {
  const f = moveFixture("moved"), world = newWorld(), inbox = join(f.state.dir, "inbox.jsonl");
  writeFileSync(inbox, [answered, pending].map((row) => JSON.stringify({ ...row, ts: iso(row.at), author_id: "owner", channel_id: row.channel, scope: "channel", content: row.id })).join("\n"));
  world.panes = [{ pane_id: "w2:p2", workspace_id: "w2", cwd: f.cwd, title: "Revived lead" }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${session}\n`;
  world.agentStart = "Thu Jan 01 12:03:00 2026";
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  const deps = {
    ...depsFor(world, fakeClock(at + 20 * 60_000), f.state.dir, { backend: "herdr", leadPane: "w2:p2", sessionsDir: f.sessionsDir, leadInboxMin: 0, leadReviveMin: 0 }),
    readGoal: async () => ({ status: "active" }),
    ownerInbox: { path: inbox, ownerId: "owner", ownerChannel: "C-OWNER" },
  };
  try {
    expect(await watchTick(deps)).toEqual([`LEAD_OWNER_WAITING w2:p2 1 owner message(s), oldest ${iso(pending.at)} (19 min); woke the lead (SUBMITTED)`]);
    expect(answeredCache(f.state.dir)).toEqual([answered.id]);
    expect(sent(world).filter((line) => line.includes("LEAD_OWNER_WAITING"))).toHaveLength(1);
    expect(await watchTick({ ...deps, clock: fakeClock(at + 21 * 60_000) })).toEqual([]);
  } finally { f.state.done(); }
});
