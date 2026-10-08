import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import { type DiscordMessage, DiscordListener, type GatewayConnection, LISTENER_INTENTS } from "../src/messenger/discord-listener.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const GUILD = "400000000000000004";
const CHANNEL = "200000000000000002";
const THREAD = "300000000000000003";

const fakeGateway = () => {
  const sent: string[] = [];
  const closed: number[] = [];
  let onMsg: (d: string) => void = () => {};
  let onClose: (code: number) => void = () => {};
  const conn: GatewayConnection = { send: (d) => sent.push(d), close: (code = 1000) => { closed.push(code); }, onMessage: (cb) => { onMsg = cb; }, onClose: (cb) => { onClose = cb; } };
  return { conn, sent, closed, push: (p: object) => onMsg(JSON.stringify(p)), drop: (code: number) => onClose(code) };
};

const fakeTimers = () => {
  const intervals = new Set<() => void>();
  const timeouts: number[] = [];
  return {
    intervals,
    timeouts,
    timers: { setInterval: (cb: () => void) => { intervals.add(cb); return cb; }, clearInterval: (h: unknown) => { intervals.delete(h as () => void); }, setTimeout: (_cb: () => void, ms: number) => { timeouts.push(ms); return ms; } },
    beat: () => { for (const cb of intervals) cb(); },
  };
};

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

const setup = (route: (req: HttpRequest) => unknown = () => ({}), opts: { inbox?: string; transcribe?: (url: string) => Promise<string> } = {}) => {
  state = withState();
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    const body = req.url.includes("/interactions/") || req.method === "PUT" ? "" : JSON.stringify(route(req));
    return { status: body ? 200 : 204, headers: {}, body };
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const cards = new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  const inboxFile = `${state.dir}/discord/inbox.jsonl`;
  if (opts.inbox) {
    mkdirSync(`${state.dir}/discord`, { recursive: true });
    writeFileSync(inboxFile, opts.inbox);
  }
  const gw = fakeGateway();
  const t = fakeTimers();
  const logs: string[] = [];
  const fatal: number[] = [];
  const listener = new DiscordListener({ dc, cards, open: () => gw.conn, token: "BOT", guild: GUILD, channel: CHANNEL, owner: OWNER, words: { ...defaultDiscordWords, statusStyle: "emoji" }, inboxFile, timers: t.timers, now: () => Date.parse("2026-01-02T03:04:00Z"), log: (l) => logs.push(l), fatal: (c) => fatal.push(c), ...(opts.transcribe ? { transcribe: opts.transcribe } : {}) });
  const inbox = () => (existsSync(inboxFile) ? readFileSync(inboxFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`);
  return { listener, cards, gw, t, logs, fatal, inbox, calls, seen };
};

const msg = (id: string, patch: Partial<DiscordMessage> = {}): DiscordMessage => ({ id, channel_id: CHANNEL, guild_id: GUILD, content: `hello ${id}`, timestamp: "2026-01-02T03:00:00Z", author: { id: OWNER }, ...patch });

test("the listener identifies with the message-content intents after hello, heartbeats, and drops a zombie connection", () => {
  const { listener, gw, t } = setup();
  listener.start();
  gw.push({ op: 10, d: { heartbeat_interval: 41250 } });
  const identify = JSON.parse(gw.sent[0] ?? "{}");
  expect(identify).toMatchObject({ op: 2, d: { token: "BOT", intents: LISTENER_INTENTS } });
  expect(LISTENER_INTENTS & (1 << 15)).toBeTruthy();
  gw.push({ op: 0, s: 5, t: "TYPING_START", d: {} });
  t.beat();
  expect(JSON.parse(gw.sent[1] ?? "{}")).toEqual({ op: 1, d: 5 });
  t.beat();
  expect(gw.closed).toEqual([4000]);
});

test("an owner message in the channel gets the eyes reaction and an inbox row; other authors, bots and other guilds are skipped", async () => {
  const { listener, gw, inbox, calls, logs } = setup();
  listener.start();
  gw.push({ op: 0, s: 1, t: "MESSAGE_CREATE", d: msg("1001") });
  gw.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg("1002", { author: { id: "555" } }) });
  gw.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg("1003", { author: { id: OWNER, bot: true } }) });
  gw.push({ op: 0, s: 4, t: "MESSAGE_CREATE", d: msg("1004", { guild_id: "999" }) });
  gw.push({ op: 0, s: 5, t: "MESSAGE_CREATE", d: msg("1001") });
  await listener.settled();
  expect(calls()).toEqual([`PUT /channels/${CHANNEL}/messages/1001/reactions/%F0%9F%91%80/@me`]);
  expect(inbox()).toEqual([{ ts: "2026-01-02T03:00:00Z", id: "1001", channel_id: CHANNEL, scope: "channel", author_id: OWNER, content: "hello 1001", transcript: null, attachments: [], reply_to: null }]);
  expect(logs).toContain(`INBOUND discord-channel ${CHANNEL} 1001 ${OWNER} "hello 1001"`);
});

test("a message in a thread under the channel counts, one under another channel does not, and DMs count", async () => {
  const { listener, inbox } = setup((req) => (req.url.endsWith(`/channels/${THREAD}`) ? { parent_id: CHANNEL } : { parent_id: "777" }));
  await listener.onMessage(msg("1001", { channel_id: THREAD }));
  await listener.onMessage(msg("1002", { channel_id: "888" }));
  await listener.onMessage(msg("1003", { channel_id: "dm1", guild_id: undefined }));
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "thread"], ["1003", "dm"]]);
});

test("the owner writing in a closed thread reopens it as working; an open thread is left alone", async () => {
  const names: Record<string, string> = { "501": "✅ fix login", "502": "[done] old thread", "503": "🔄 still going" };
  const { listener, calls, seen, logs } = setup((req) => {
    const id = /\/channels\/(\d+)$/.exec(req.url)?.[1] ?? "";
    return id in names ? { parent_id: CHANNEL, name: names[id], thread_metadata: { archived: id !== "503" } } : {};
  });
  for (const [n, thread] of ["501", "502", "503"].entries()) await listener.onMessage(msg(`100${n}`, { channel_id: thread }));
  const patches = seen.filter((r) => r.method === "PATCH");
  expect(patches.map((r) => [r.url.replace("https://discord.com/api/v10", ""), JSON.parse(String(r.body))])).toEqual([
    ["/channels/501", { name: "🔄 fix login", archived: false }],
    ["/channels/502", { name: "🔄 old thread", archived: false }],
  ]);
  expect(calls().some((c) => c === "PATCH /channels/503")).toBe(false);
  expect(logs.filter((l) => l.startsWith("THREAD_REOPENED"))).toEqual(["THREAD_REOPENED 501", "THREAD_REOPENED 502"]);
});

test("a voice note is transcribed into the inbox row; a failed transcription still records the message", async () => {
  let fail = false;
  const { listener, inbox, logs } = setup(() => ({}), { transcribe: async () => { if (fail) throw new Error("stt down"); return "ship it"; } });
  const voice = { attachments: [{ url: "https://cdn.example/v.ogg", filename: "v.ogg", content_type: "audio/ogg" }] };
  await listener.onMessage(msg("1001", { content: "", ...voice }));
  fail = true;
  await listener.onMessage(msg("1002", { content: "", ...voice }));
  expect(inbox().map((r) => r.transcript)).toEqual(["ship it", null]);
  expect(logs.some((l) => l.startsWith("DISCORD_TRANSCRIBE_FAIL 1002"))).toBe(true);
});

test("a tap on a card inside its work thread is taken, lands in the inbox with its session and tmux, and turns the thread working; a tap from an unrelated channel is ignored", async () => {
  const { listener, cards, gw, inbox, calls } = setup((req) => (req.method === "GET" ? { name: "⏸️ fix login" } : req.method === "POST" && req.url.endsWith(`/channels/${THREAD}/messages`) ? { id: "900" } : {}));
  await cards.ask("Ship?", ["Yes", "No"], { thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" });
  expect(calls()[0]).toBe(`POST /channels/${THREAD}/messages`);
  const before = calls().length;
  listener.start();
  gw.push({ op: 0, s: 1, t: "INTERACTION_CREATE", d: { id: "5001", token: "tok", type: 3, channel_id: "777", member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:0" } } });
  gw.push({ op: 0, s: 2, t: "INTERACTION_CREATE", d: { id: "5002", token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:1" } } });
  await listener.settled();
  expect(inbox()).toEqual([{ ts: "2026-01-02T03:04:00.000Z", id: "5002", kind: "answer", qid: "Q1", answer: "No", answer_kind: "button", question: "Ship?", thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" }]);
  expect(calls().slice(before)).toEqual(["POST /interactions/5002/tok/callback", `GET /channels/${THREAD}`, `PATCH /channels/${THREAD}`]);
});

test("a tap in the configured channel is still taken, and a tap on an unknown question from another channel is ignored", async () => {
  const { listener, cards, inbox, calls } = setup((req) => (req.method === "POST" && req.url.endsWith(`/channels/${CHANNEL}/messages`) ? { id: "900" } : {}));
  await cards.ask("Ship?", ["Yes"]);
  await listener.onInteraction({ id: "5003", token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: "q:Q9:0" } });
  await listener.onInteraction({ id: "5004", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:0" } });
  expect(inbox().map((r) => r.id)).toEqual(["5004"]);
  expect(calls().filter((c) => c.includes("/interactions/"))).toEqual(["POST /interactions/5004/tok/callback"]);
});

test("on READY it backfills owner messages newer than the inbox from the channel and its active threads, oldest first", async () => {
  const route = (req: HttpRequest) => {
    if (req.url.endsWith(`/guilds/${GUILD}/threads/active`)) return { threads: [{ id: THREAD, parent_id: CHANNEL }, { id: "666", parent_id: "777" }] };
    if (req.url.includes(`/channels/${CHANNEL}/messages?after=1000`)) return [msg("1002", { guild_id: undefined }), msg("1001", { guild_id: undefined })];
    if (req.url.includes(`/channels/${THREAD}/messages?after=1000`)) return [msg("1003", { channel_id: THREAD, guild_id: undefined })];
    return {};
  };
  const { listener, gw, inbox, calls, logs } = setup(route, { inbox: `${JSON.stringify({ id: "1000", ts: "x" })}\n${JSON.stringify({ id: "5000", kind: "answer" })}\n` });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: {} });
  await listener.settled();
  expect(inbox().map((r) => r.id)).toEqual(["1000", "5000", "1001", "1002", "1003"]);
  expect(calls().filter((c) => c.startsWith("GET")).some((c) => c.includes("/channels/666/"))).toBe(false);
  expect(logs).toContain("DISCORD_BACKFILL since=1000 added=3");
});

test("a dropped connection reconnects with growing backoff; a rejected token or intent stops the listener", () => {
  const { listener, gw, t, fatal, logs } = setup();
  listener.start();
  gw.drop(1006);
  gw.drop(1006);
  expect(t.timeouts).toEqual([1000, 2000]);
  gw.drop(4014);
  expect(fatal).toEqual([4014]);
  expect(t.timeouts).toHaveLength(2);
  expect(logs).toContain("DISCORD_LISTENER_FATAL close=4014");
});
