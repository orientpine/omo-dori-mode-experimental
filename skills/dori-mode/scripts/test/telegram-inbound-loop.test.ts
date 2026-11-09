// From upstream dori-superagent #110 (https://github.com/sisyphuslabs/dori-superagent/pull/110, closes its issues #95, #98), on the
// fork's test setup; the last test is the fork's addition.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { fileTgInboundStore, pollTelegramInbound, type TgInbound, telegramInboundLoop } from "../src/messenger/telegram-inbound.ts";
import { withState } from "./fakes.ts";
import { mk, msg, OWNER, telegramFake } from "./telegram-inbound-setup.ts";

const state = withState();
afterAll(() => state.done());

const liveLocation = (update_id: number, extra: Record<string, unknown> = {}) => ({
  update_id,
  edited_message: {
    message_id: 42,
    from: { id: OWNER, is_bot: false, username: "owner" },
    chat: { id: OWNER, type: "private" },
    location: { latitude: 1.3 + update_id * 0.0001, longitude: 103.8 },
    edit_date: 1731 + update_id,
    ...extra,
  },
});

test("live-location edit refreshes carry no text and are dropped, not one line each", async () => {
  const realEdit = { update_id: 200, edited_message: { ...msg(OWNER, OWNER, "private", "moved the pin"), edit_date: 1730 } };
  const locEdits = Array.from({ length: 6 }, (_, i) => liveLocation(201 + i));
  // One getUpdates response can carry the whole burst, and so can one poll.
  const { http } = telegramFake([[realEdit, ...locEdits]]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-loc"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("moved the pin"); // the text edit survives
  expect(store.load()).toBe(207); // the location stream was consumed, not replayed
});

test("--loop re-polls after a poll whose updates were all gate-dropped", async () => {
  // A stranger's message is dropped by the owner gate, but updates came back:
  // more may be waiting, so the next poll must happen before any interval sleep.
  const { http, bodies } = telegramFake([[{ update_id: 300, message: msg(999, -1003801002434, "supergroup", "stranger", 3, true) }], []]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-drop"));
  const emitted: TgInbound[] = [];
  const sleeps: number[] = [];
  const stop = new Error("STOP");
  await telegramInboundLoop(mk(http), store, { ownerId: OWNER }, 1, (i) => emitted.push(i), () => {}, async (ms) => {
    sleeps.push(ms);
    throw stop;
  }).catch((e: unknown) => {
    if (e !== stop) throw e;
  });
  expect(emitted).toHaveLength(0); // nothing passed the gate
  expect(bodies.length).toBe(2); // dropped poll -> immediate re-poll -> empty poll -> only then sleep
  expect(sleeps).toEqual([60_000]);
});

test("only a live-location refresh is dropped: a first location and a located edit with a caption still arrive", async () => {
  const first = { update_id: 400, message: { ...liveLocation(400).edited_message } };
  const captioned = liveLocation(401, { caption: "here now" });
  const { http } = telegramFake([[first, captioned]]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-loc-kept"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.map((i) => [i.kind, i.text])).toEqual([["message", undefined], ["edit", "here now"]]);
});
