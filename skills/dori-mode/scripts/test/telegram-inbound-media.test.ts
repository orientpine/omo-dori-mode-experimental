import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore, pollTelegramInbound } from "../src/messenger/telegram-inbound.ts";
import { withState } from "./fakes.ts";
import { mk, msg, OWNER, telegramFake } from "./telegram-inbound-setup.ts";

setDefaultTimeout(30_000); // load-proof: the CLI tests here start dori inbound telegram (bun src/cli.ts) as a child process; a loaded host (40-67 on 20 cores) slows them several times over, so this file, not the suite, gets 30 s

const state = withState();
afterAll(() => state.done());

// upstream dori-superagent #79 (https://github.com/sisyphuslabs/dori-superagent/pull/79, closes its issue #77): its tests,
// as merged there; the state dir stays shared (each test has its own offset file) and is removed after the file
test("edited messages arrive as their own edit kind with the edited text", async () => {
  const { http, bodies } = telegramFake([
    [{ update_id: 90, edited_message: { ...msg(OWNER, OWNER, "private", "fixed typo"), edit_date: 1730 } }],
    [{ update_id: 91, message: msg(OWNER, OWNER, "private", "fresh after edit") }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-9"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("edit");
  expect(out[0]!.text).toBe("fixed typo");
  expect(store.load()).toBe(91);
  expect(bodies[0]!["allowed_updates"]).toEqual(["message", "edited_message"]);
  const second = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(second[0]!.kind).toBe("message");
});

test("a voice note identifies its media so transcribe can fetch it", async () => {
  const { http } = telegramFake([
    [{ update_id: 100, message: { message_id: 55, from: { id: OWNER, is_bot: false, username: "owner" }, chat: { id: OWNER, type: "private" }, voice: { file_id: "FID_VOICE", duration: 9 } } }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-10"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("message");
  expect(out[0]!.text).toBeUndefined();
  expect(out[0]!.media).toEqual({ kind: "voice", fileId: "FID_VOICE", messageId: 55 });
  expect(store.load()).toBe(101);
});

test("a photo with a caption carries both the text and the largest photo", async () => {
  const { http } = telegramFake([
    [{ update_id: 110, message: { message_id: 56, from: { id: OWNER, is_bot: false, username: "owner" }, chat: { id: OWNER, type: "private" }, photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }], caption: "look at this" } }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-11"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("look at this");
  expect(out[0]!.media).toEqual({ kind: "photo", fileId: "LARGE", messageId: 56 });
});

test("an unparseable offset warns once across several polls and restarts from 0", async () => {
  writeFileSync(join(state.dir, "telegram-offset"), "not-a-number");
  const warns: string[] = [];
  const orig = console.error;
  console.error = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
    // Three polls, no updates: nothing saves over the corrupt file, every poll loads it.
    const { http } = telegramFake([[], [], []]);
    const tg = mk(http);
    for (let i = 0; i < 3; i++) await pollTelegramInbound(tg, store, { ownerId: OWNER });
    expect(store.load()).toBe(0);
  } finally {
    console.error = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("WARN");
  expect(warns[0]).toContain("unparseable");
});
