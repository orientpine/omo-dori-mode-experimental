import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reconcileRows } from "../src/missed-answers.ts";
import { sendKey, sendOnce } from "../src/send-dedupe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// The four shapes of the 2026-11-11 reports (#dori-pair 1569977418431594507, 1569977434269294616, 1569977449335234622):
// the lead answered, the lead transcript the watch reads does not show it, and the post records of `dori send` /
// `dori thread` (state/sent) do.
const at = Date.parse("2026-11-11T06:42:10Z");
const owner = { id: "1569965444360699985", channel: "1566837864325455893", at };
const later = "1569974345923690547", earlier = "1569900000000000000";
const iso = (ms: number) => new Date(ms).toISOString();

const leadLog = (dir: string, entries: readonly object[]): { path: string; text: string } => {
  const text = [{ type: "session", id: "d864772e-0000-4000-8000-000000000000", cwd: "/home/lead", timestamp: iso(at - 60_000) }, ...entries].map((e) => JSON.stringify(e)).join("\n");
  const path = join(dir, "lead.jsonl");
  writeFileSync(path, text);
  return { path, text };
};

// soodori daf729ed 2026-11-11T07:17:31Z: how the lead really sent the reply (an eval running the Dori's own binary, piped)
const realSend = (reply: string): object[] => [
  { type: "message", timestamp: iso(at + 60_000), message: { role: "assistant", content: [{ type: "toolCall", id: "toolu_send", name: "eval", arguments: { language: "js", code: `const o = await tool.bash({command:"~/.soodori/bin/dori send discord --to ${owner.channel} --reply ${reply} --text-file /tmp/answer.txt 2>&1 | tail -1", timeout:120});\nprint(o.text);` } }] } },
  { type: "message", timestamp: iso(at + 61_000), message: { role: "toolResult", toolCallId: "toolu_send", toolName: "eval", content: [{ type: "text", text: `SENT ${later} len=6 sha=12345678 first="answer"` }] } },
];

// a post as dori send discord / dori thread record it: the place, the reply target, the id Discord returned
const post = (dir: string, place: string, id: string, postedAt: number, replyTo?: string) =>
  sendOnce(join(dir, "sent"), `discord:${place}`, sendKey(["discord", place, replyTo, undefined, `text ${id}`]), async () => ({ id }), { now: () => postedAt, ...(replyTo ? { replyTo } : {}) });

const waitingFor = async (rows: readonly (typeof owner & { qid?: string; thread?: string })[], setup: (dir: string) => Promise<void>, entries: readonly object[] = []) => {
  const state = withState();
  try {
    await setup(state.dir);
    const lead = leadLog(state.dir, entries);
    const deps = depsFor(newWorld(), fakeClock(at + 20 * 60_000), state.dir);
    const { waiting } = await reconcileRows({ rows, cards: [], lead: { pane: "w1:p4C", path: lead.path, title: "lead", text: lead.text }, sessions: [], table: [], deps });
    return waiting.map((row) => row.id);
  } finally { state.done(); }
};

test("a --reply sent in the lead's own session counts, whatever the command looked like", async () => {
  expect(await waitingFor([owner], (dir) => post(dir, owner.channel, later, at + 61_000, owner.id).then(() => {}), realSend(owner.id))).toEqual([]);
});

test("a --reply sent before the lead moved to another pane (no handover) counts", async () => {
  // okdori w1:p8 -> w3:p2: the reply sits in a session the watch no longer resolves for the lead pane
  expect(await waitingFor([owner], (dir) => post(dir, owner.channel, later, at + 61_000, owner.id).then(() => {}))).toEqual([]);
});

test("a --reply sent by the old lead session before a handover counts", async () => {
  // zzangdori 01a1c428 -> d864772e: the owner wrote 19 h ago, the old session answered, the new one never saw it
  const old = { ...owner, at: at - 19 * 60 * 60_000 };
  expect(await waitingFor([old], (dir) => post(dir, owner.channel, later, old.at + 60_000, owner.id).then(() => {}))).toEqual([]);
});

test("a later post of this Dori in the message's own thread or channel counts without --reply", async () => {
  // gongdori: "스레드 레인 닫아" answered by dori thread done in that thread; "도리들아 응답해" by a plain #dori-pair post;
  // soodori 06:51:47Z + 06:52:06Z: two lines of his, one answer after the second
  const inThread = { ...owner, channel: "1569651000000000000" }, inRoom = { ...owner, id: "1569965444360699986", channel: "1557744292393386074" };
  const first = { ...owner, id: "1569965444360699988", channel: "1569651000000000002" }, second = { ...first, id: "1569965444360699989", at: at + 1000 };
  expect(await waitingFor([inThread, inRoom, first, second], async (dir) => {
    await post(dir, first.channel, "1569974345923690549", at + 60_000, second.id);
    await post(dir, inThread.channel, later, at + 60_000);
    await post(dir, inRoom.channel, "1569974345923690548", at + 60_000);
  })).toEqual([]);
});

test("a message answered by a post record is kept in the answered set like a transcript answer", async () => {
  const state = withState();
  try {
    await post(state.dir, owner.channel, later, at + 61_000, owner.id);
    const lead = leadLog(state.dir, []);
    const deps = depsFor(newWorld(), fakeClock(at + 20 * 60_000), state.dir);
    const result = await reconcileRows({ rows: [owner], cards: [], lead: { pane: "w1:p4C", path: lead.path, title: "lead", text: lead.text }, sessions: [], table: [], deps });
    expect(result).toEqual({ waiting: [], answeredIds: [owner.id] });
    expect(JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8"))).toEqual([owner.id]);
  } finally { state.done(); }
});

test("a post that does not answer the message leaves it waiting", async () => {
  const card = { ...owner, id: "1569965444360699987", channel: "1569651000000000001", qid: "Q7", thread: "1569651000000000001" };
  expect(await waitingFor([owner, card], async (dir) => {
    await post(dir, owner.channel, earlier, at - 60_000); // in its channel, but before it
    await post(dir, "1566837864325455000", later, at + 60_000, "1569000000000000000"); // a reply to another message, elsewhere
    await post(dir, card.channel, later, at + 60_000); // a card answer is not answered by a post in its thread
  })).toEqual([owner.id, card.id]);
});
