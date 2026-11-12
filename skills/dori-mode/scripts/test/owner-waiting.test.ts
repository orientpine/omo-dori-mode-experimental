import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Discord } from "../src/messenger/discord.ts";
import { eyesOff } from "../src/messenger/discord-listener.ts";
import type { OwnerRow } from "../src/lead-limit.ts";
import { EYES_OFF_FILE, waitingOwnerRows } from "../src/owner-waiting.ts";
import { withState } from "./fakes.ts";

const PAIR = "500000000000000005";
let state: ReturnType<typeof withState> | undefined;
afterEach(() => state?.done());

test("dori eyes off records each message it took the eyes off, and none it could not", async () => {
  state = withState();
  const removed: string[] = [];
  const dc = { unreact: async (channel: string, id: string) => { if (id === "600000000000000009") throw new Error("403 Missing Access"); removed.push(`${channel}/${id}`); } } as unknown as Discord;
  const eyesFile = join(state.dir, "eyes.json");
  expect(await eyesOff(dc, eyesFile, "600000000000000001", PAIR)).toBe(`EYES_OFF ${PAIR} 600000000000000001`);
  expect(await eyesOff(dc, eyesFile, "600000000000000009", PAIR).catch((e: Error) => e.message)).toContain("403");
  const rows = readFileSync(join(state.dir, EYES_OFF_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { channel: string; id: string });
  expect(rows.map((r) => `${r.channel}/${r.id}`)).toEqual(removed);
  expect(removed).toEqual([`${PAIR}/600000000000000001`]);
});

test("an uncalled reply to another Dori's post older than the inbox tail is still left out; one to an unknown post waits", () => {
  state = withState();
  const inbox = join(state.dir, "inbox.jsonl");
  const line = (r: object) => `${JSON.stringify(r)}\n`;
  const old = line({ id: "p-old", scope: "pair-bot", channel_id: PAIR, author_id: "200000000000000002", content: "digest failed" });
  const tail = line({ id: "o-reply", scope: "pair", called: false, reply_to: "p-old", author_id: "1", content: "why again?" }) + line({ id: "o-lost", scope: "pair", called: false, reply_to: "p-gone", author_id: "1", content: "and this?" });
  writeFileSync(inbox, old + tail);
  const rows: OwnerRow[] = [{ id: "o-reply", at: 1, scope: "pair", text: "why again?" }, { id: "o-lost", at: 2, scope: "pair", text: "and this?" }];
  expect(waitingOwnerRows(rows, tail, inbox).map((r) => r.id)).toEqual(["o-lost"]);
});
