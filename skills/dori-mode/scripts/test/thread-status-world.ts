// The Discord work thread, clock, queue and listener the thread status tests share (thread-status.test.ts,
// thread-status-approval.test.ts).
import { readFileSync, existsSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { type Interaction, openCardIds, QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import { type DiscordMessage, DiscordListener } from "../src/messenger/discord-listener.ts";
import type { Http, HttpResponse } from "../src/messenger/http.ts";
import { ThreadStatusQueue } from "../src/messenger/thread-status-queue.ts";
import { fakeClock, withState } from "./fakes.ts";

export const OWNER = "100000000000000001";
export const CHANNEL = "200000000000000002";
export const THREAD = "300000000000000003";
export const GUILD = "400000000000000004";
export const T0 = Date.parse("2026-10-11T10:12:00Z");
export const WORDS = { ...defaultDiscordWords, statusStyle: "emoji" as const };

// the state folder of the newest world; a test file ends it with doneWorld in afterEach
let state: ReturnType<typeof withState> | undefined;
export const doneWorld = (): void => {
  state?.done();
  state = undefined;
};

export const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

// One Discord work thread with a clock and timers the test moves by hand. `limited` holds the retry_after (seconds)
// the next thread PATCHes are refused with, as Discord does past about two renames per ten minutes.
export const world = (name: string) => {
  const own = withState();
  state = own;
  const w = { t: T0, name, archived: false, limited: [] as number[], patches: [] as Record<string, unknown>[], timers: [] as { at: number; cb: () => void }[], logs: [] as string[] };
  const http: Http = async (req) => {
    const path = req.url.replace("https://discord.com/api/v10", "");
    if (path === `/channels/${THREAD}` && req.method === "GET") return ok({ name: w.name, parent_id: CHANNEL, type: 11, thread_metadata: { archived: w.archived } });
    if (path === `/channels/${THREAD}` && req.method === "PATCH") {
      const wait = w.limited.shift();
      if (wait !== undefined) return { status: 429, headers: {}, body: JSON.stringify({ message: "You are being rate limited.", retry_after: wait, global: false }) };
      const body = JSON.parse(String(req.body)) as { name?: string; archived?: boolean };
      w.patches.push(body);
      if (body.name) w.name = body.name;
      if (body.archived !== undefined) w.archived = body.archived;
      return ok({});
    }
    return ok(req.method === "POST" && path.endsWith("/messages") ? { id: "900" } : {});
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const store = new QuestionStore(`${own.dir}/discord`);
  const file = `${own.dir}/discord/thread-status.json`;
  const queue = (workingLanes?: (t: string) => Promise<readonly string[]>) => new ThreadStatusQueue({ dc, words: WORDS, file, openCards: (t) => openCardIds(store, t), ...(workingLanes ? { workingLanes } : {}), now: () => w.t, log: (l) => w.logs.push(l), jitterMs: () => 500 });
  const timers = { setTimeout: (cb: () => void, ms: number) => w.timers.push({ at: w.t + ms, cb }), setInterval: () => 0 };
  // runs every timer due within `ms`, in order, letting each rename finish before the next
  const advance = async (q: ThreadStatusQueue, ms: number) => {
    const end = w.t + ms;
    for (;;) {
      const next = w.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      w.timers.splice(w.timers.indexOf(next), 1);
      w.t = Math.max(w.t, next.at);
      next.cb();
      await q.settled();
    }
    w.t = end;
  };
  const pending = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {});
  return { w, dc, store, queue, timers, advance, pending, dir: own.dir };
};

// the listener and cards as `dori inbound discord` builds them, sharing one queue
export const live = (name: string, workingLanes?: (t: string) => Promise<readonly string[]>) => {
  const wd = world(name);
  const q = wd.queue(workingLanes);
  const cards = new QuestionCards(wd.dc, wd.store, { channel: CHANNEL, owner: OWNER, words: WORDS }, () => wd.w.t, q);
  const inboxFile = `${wd.dir}/discord/inbox.jsonl`;
  const listener = new DiscordListener({ dc: wd.dc, cards, open: () => { throw new Error("no gateway in this test"); }, token: "BOT", guild: GUILD, channel: CHANNEL, owner: OWNER, words: WORDS, inboxFile, timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 }, now: () => wd.w.t, log: (l) => wd.w.logs.push(l), fatal: () => {} });
  const inbox = () => readFileSync(inboxFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const tap = (qid: string, option = 0): Interaction => ({ id: `i-${qid}`, token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: `q:${qid}:${option}` } });
  const say = (id: string, content: string): DiscordMessage => ({ id, channel_id: THREAD, guild_id: GUILD, content, timestamp: "2026-10-11T10:12:00Z", author: { id: OWNER } });
  return { ...wd, q, cards, listener, inbox, tap, say };
};
