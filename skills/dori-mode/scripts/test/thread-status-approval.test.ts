import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { mapThread, threads } from "../src/messenger/thread-map.ts";
import { doneWorld, live, THREAD } from "./thread-status-world.ts";

afterEach(doneWorld);

// 2026-11-12 (YooDori mail thread 1570290417285726290): the owner wrote in a thread whose mail approval card still
// waited for him, and the receiver turned the node's 🔔 into 🔄. The lead's rule: a card waiting for the owner keeps 🔔;
// with no card left his message gives 🔄. The receiver cannot see a node's or the egress gate's cards, but the one who
// set a 🔔 keeps it while its card waits, so the receiver never undoes a 🔔 it did not set itself.

test("the owner writing in a thread another writer marked 🔔 (a waiting mail card) leaves it 🔔 with no rename", async () => {
  const { w, listener, say } = live("🔔 ✉️ lecture reply");
  await listener.onMessage(say("1004", "add a question about their level"));
  expect({ name: w.name, patches: w.patches }).toEqual({ name: "🔔 ✉️ lecture reply", patches: [] });
  expect(w.logs).toContain(`THREAD_STATUS_KEPT ${THREAD} working: 🔔 was set by another writer`);
});

test("a working lane in that thread does not take another writer's 🔔 either", async () => {
  const { w, q } = live("🔔 ✉️ lecture reply", async () => ["lane-a"]);
  await q.request(THREAD, "working");
  expect({ name: w.name, patches: w.patches }).toEqual({ name: "🔔 ✉️ lecture reply", patches: [] });
});

test("a 🔔 the receiver set itself still turns 🔄 when the owner answers", async () => {
  const { w, q, listener, say } = live("🔄 fix login");
  await q.request(THREAD, "waiting");
  expect(w.name).toBe("🔔 fix login");
  await listener.onMessage(say("1005", "here is the answer"));
  expect(w.name).toBe("🔄 fix login");
});

test("a thread another writer ended (✅ ⛔ 💤) reopens 🔄 on the owner's message: no card waits there", async () => {
  for (const name of ["✅ ✉️ lecture reply", "💤 ✉️ lecture reply"]) {
    const { w, listener, say } = live(name);
    await listener.onMessage(say("1006", "one more change"));
    expect(w.name).toBe("🔄 ✉️ lecture reply");
    doneWorld();
  }
});

test("once another writer renames the thread to its own 🔔, the receiver's earlier 🔔 no longer counts as its own", async () => {
  const { w, q, listener, say } = live("🔄 ✉️ lecture reply");
  await q.request(THREAD, "waiting");
  w.name = "🔔 ✉️ revised lecture reply";
  await listener.onMessage(say("1007", "and this too"));
  expect(w.name).toBe("🔔 ✉️ revised lecture reply");
});

test("a question this Dori asks in that thread does not take the other writer's 🔔: answering it leaves 🔔 (review 6 of #467)", async () => {
  const { w, cards, listener, tap } = live("🔔 ✉️ lecture reply");
  await cards.ask("Which date?", ["Fri", "Sat"], { thread: THREAD });
  await listener.onInteraction(tap("Q1"));
  expect(w.name).toBe("🔔 ✉️ lecture reply");
});

test("done on a thread another writer keeps 🔔 is kept open: the result says so and the lane mapping stays (review 6 of #467)", async () => {
  const { w, q, dir } = live("🔔 ✉️ lecture reply");
  mapThread(`${dir}/discord`, THREAD, "session-1", "lecture reply");
  expect(await q.request(THREAD, "done")).toBe("kept");
  expect({ name: w.name, archived: w.archived, mapped: Boolean(threads(`${dir}/discord`)[THREAD]) }).toEqual({ name: "🔔 ✉️ lecture reply", archived: false, mapped: true });
});

test("renaming another writer's 🔔 to this Dori's style or reopening it does not make it ours (review 7 of #467)", async () => {
  const { w, q, listener, say } = live("🔔 ✉️ lecture reply");
  w.archived = true;
  await q.request(THREAD, "waiting");
  await listener.onMessage(say("1009", "and the venue"));
  expect(w.name.startsWith("🔔")).toBe(true);
});

test("a 🔔 this Dori set on a title of Discord's full 100 characters is still its own (review 7 of #467)", async () => {
  const long = "x".repeat(100);
  const { w, q, listener, say } = live(long);
  await q.request(THREAD, "waiting");
  expect(w.name).toBe(`🔔 ${long}`.slice(0, 100));
  await listener.onMessage(say("1010", "answer"));
  expect(w.name.startsWith("🔄")).toBe(true);
});

test("this Dori never sets 🔔 in a card thread: a wait asked there leaves the card writer's mark as it is", async () => {
  const { w, q } = live("🔄 ✉️ lecture reply");
  expect(await q.request(THREAD, "waiting")).toBe("kept");
  expect({ name: w.name, patches: w.patches }).toEqual({ name: "🔄 ✉️ lecture reply", patches: [] });
});

test("a 🔔 in a card thread stays the card writers' even when it matches a name this Dori once gave (a gate card joined it unchanged)", async () => {
  const { w, listener, say, dir } = live("🔔 ✉️ lecture reply");
  writeFileSync(`${dir}/discord/thread-names.json`, JSON.stringify({ [THREAD]: "🔔 ✉️ lecture reply" }));
  await listener.onMessage(say("1011", "the room is booked"));
  expect(w.name).toBe("🔔 ✉️ lecture reply");
});

test("a gate card that joins a 🔔 this Dori set renames it a card thread (🔔 🔐), and the receiver leaves it", async () => {
  const { w, q, listener, say } = live("🔄 fix login");
  await q.request(THREAD, "waiting");
  w.name = "🔔 🔐 fix login";
  await listener.onMessage(say("1012", "go ahead"));
  expect(w.name).toBe("🔔 🔐 fix login");
});
