import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { type Interaction, QuestionCards, QuestionError, QuestionStore } from "../src/messenger/discord-cards.ts";
import { progressText, threadHook, ThreadRefError } from "../src/messenger/discord-thread.ts";
import { type Http, type HttpRequest, type HttpResponse, UnsafeMessageError } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const CHANNEL = "200000000000000002";

const fakeDiscord = (route: (req: HttpRequest) => unknown = () => ({})) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req): Promise<HttpResponse> => {
    seen.push(req);
    const body = req.url.includes("/interactions/") ? "" : JSON.stringify(route(req));
    return { status: body ? 200 : 204, headers: {}, body };
  };
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`);
  const json = (n: number) => JSON.parse(String(seen[n]?.body));
  return { dc: new Discord(http, fakeClock(0), "bot"), seen, calls, json };
};

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

const setup = (route?: (req: HttpRequest) => unknown) => {
  state = withState();
  const f = fakeDiscord(route ?? ((req) => (req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {})));
  const store = new QuestionStore(`${state.dir}/discord`);
  const cards = new QuestionCards(f.dc, store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  return { ...f, store, cards };
};

const tap = (customId: string, user = OWNER): Interaction => ({ id: "i1", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: user } }, data: { custom_id: customId } });

const rows = (card: unknown) => ((card as { components: { type: number; components?: { style: number; label: string; custom_id: string }[] }[] }[])[0]?.components ?? []).filter((c) => c.type === 1).map((c) => c.components?.[0]);

test("a question card is a V2 message that pings only the owner, recommended option first and primary, write-my-own last", async () => {
  const { cards, store, calls, json } = setup();
  const q = await cards.ask("Ship the fix today?", ["Ship it", "Wait for review"], { thread: "300", session: "sess-1", tmux: "aoe_demo_1234abcd" });
  expect(q.id).toBe("Q1");
  expect(calls()).toEqual([`POST /channels/${CHANNEL}/messages`]);
  const body = json(0);
  expect(body.flags).toBe(1 << 15);
  expect(body.allowed_mentions).toEqual({ users: [OWNER] });
  expect(body.components[0].type).toBe(17);
  expect(body.components[0].components[0].content).toBe(`<@${OWNER}> **Q1** Ship the fix today? · <#300>`);
  expect(rows(body.components)).toEqual([
    { type: 2, style: 1, label: "Ship it", custom_id: "q:Q1:0" },
    { type: 2, style: 2, label: "Wait for review", custom_id: "q:Q1:1" },
    { type: 2, style: 2, label: "Write my own", custom_id: "q:Q1:other" },
  ] as never);
  expect(store.get("Q1")).toMatchObject({ status: "open", message: "900", session: "sess-1", tmux: "aoe_demo_1234abcd" });
});

test("the owner's tap folds the card into a record in the same response and logs the answer once; a second tap changes nothing", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship the fix today?", ["Ship it", "Wait for review"]);
  const first = await cards.handle(tap("q:Q1:1"));
  expect(first.kind).toBe("answered");
  expect(calls()[1]).toBe("POST /interactions/i1/tok/callback");
  const update = json(1);
  expect(update.type).toBe(7);
  expect(update.data.components[0].components).toHaveLength(1);
  expect(update.data.components[0].components[0].content).toBe("[answered] **Q1** Ship the fix today?\n→ **Wait for review**\n-# button · 1/2, 03:04");
  expect(store.get("Q1")).toMatchObject({ status: "answered", answer: "Wait for review", answerKind: "button" });
  const again = await cards.handle(tap("q:Q1:0"));
  expect(again).toEqual({ kind: "stale", qid: "Q1" });
  expect(json(2).type).toBe(7);
  expect(store.get("Q1")?.answer).toBe("Wait for review");
  expect(readFileSync(store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("anyone but the owner gets a private refusal and the question stays open", async () => {
  const { cards, store, json } = setup();
  await cards.ask("Ship?", ["Yes"]);
  expect(await cards.handle(tap("q:Q1:0", "555"))).toEqual({ kind: "refused", user: "555" });
  expect(json(1)).toEqual({ type: 4, data: { content: "Only the owner can answer this.", flags: 64 } });
  expect(store.get("Q1")?.status).toBe("open");
  expect(existsSync(store.answersFile)).toBe(false);
});

test("write-my-own opens a modal, and its typed text becomes the answer", async () => {
  const { cards, store, json } = setup();
  await cards.ask("When should it ship?", ["Today"]);
  expect(await cards.handle(tap("q:Q1:other"))).toEqual({ kind: "modal", qid: "Q1" });
  const modal = json(1);
  expect(modal.type).toBe(9);
  expect(modal.data.custom_id).toBe("m:Q1");
  expect(store.get("Q1")?.status).toBe("open");
  const submit: Interaction = { id: "i2", token: "t2", type: 5, channel_id: CHANNEL, user: { id: OWNER }, data: { custom_id: "m:Q1", components: [{ type: 18, component: { type: 4, custom_id: "answer", value: "  next monday  " } }] } };
  const done = await cards.handle(submit);
  expect(done.kind).toBe("answered");
  expect(store.get("Q1")).toMatchObject({ answer: "next monday", answerKind: "text" });
  expect(json(2).data.components[0].components[0].content).toContain("-# typed");
});

test("reopen puts the buttons back on the posted card; resolve forgets the question", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship?", ["Yes", "No"]);
  await cards.handle(tap("q:Q1:0"));
  const q = await cards.reopen("Q1");
  expect(q.status).toBe("open");
  expect(calls()[2]).toBe(`PATCH /channels/${CHANNEL}/messages/900`);
  expect(rows(json(2).components).map((b) => b?.custom_id)).toEqual(["q:Q1:0", "q:Q1:1", "q:Q1:other"]);
  expect(store.get("Q1")?.answer).toBeUndefined();
  expect(cards.resolve("Q1")).toBe(true);
  expect(store.all()).toEqual([]);
  await expect(cards.reopen("Q1")).rejects.toBeInstanceOf(QuestionError);
});

test("a question with no options or with shell-substitution text is refused before anything is posted", async () => {
  const { cards, seen } = setup();
  await expect(cards.ask("Ship?", [])).rejects.toBeInstanceOf(QuestionError);
  await expect(cards.ask("Ship $(whoami)?", ["Yes"])).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("an answered question with a work thread leaves the answer there without pinging anyone", async () => {
  const { cards, calls, json } = setup();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const out = await cards.handle(tap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.echo(out.question);
  expect(calls()[2]).toBe("POST /channels/300/messages");
  expect(json(2)).toEqual({ content: "Q1 Ship?\n→ Yes (1/2, 03:04)", flags: 1 << 12, allowed_mentions: { parse: [] } });
});

test("the done thread hook posts without emoji, swaps the status word in the thread name, then archives", async () => {
  const f = fakeDiscord((req) => (req.method === "GET" ? { name: "[working] fix login" } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));
  const t = "300000000000000003";
  expect(await threadHook(f.dc, "done", `discord:${t}`, "merged 🎉 abc123", defaultDiscordWords)).toBe("901");
  expect(f.calls()).toEqual([`POST /channels/${t}/typing`, `POST /channels/${t}/messages`, `GET /channels/${t}`, `PATCH /channels/${t}`, `PATCH /channels/${t}`]);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "[done] fix login" });
  expect(f.json(4)).toEqual({ archived: true });
  await expect(threadHook(f.dc, "reply", "telegram:1", "x", defaultDiscordWords)).rejects.toBeInstanceOf(ThreadRefError);
});

const emoji = { ...defaultDiscordWords, statusStyle: "emoji" } as const;
const T = "300000000000000003";
const threadAs = (name: string, archived = false) => fakeDiscord((req) => (req.method === "GET" ? { name, thread_metadata: { archived } } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));

test("with emoji status the done hook swaps the word mark for ✅ and archives; the posted note still has no emoji", async () => {
  const f = threadAs("[working] fix login");
  await threadHook(f.dc, "done", `discord:${T}`, "merged 🎉 abc123", emoji);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "✅ fix login" });
  expect(f.json(4)).toEqual({ archived: true });
});

test("reply marks the thread working and wait marks it waiting, opening an archived thread in the same request", async () => {
  const done = threadAs("✅ fix login", true);
  await threadHook(done.dc, "reply", `discord:${T}`, "picking this up again", emoji);
  expect(done.calls().slice(2)).toEqual([`GET /channels/${T}`, `PATCH /channels/${T}`]);
  expect(done.json(3)).toEqual({ name: "🔄 fix login", archived: false });
  const working = threadAs("🔄 fix login");
  await threadHook(working.dc, "wait", `discord:${T}`, "Q2 is waiting on you", emoji);
  expect(working.json(3)).toEqual({ name: "⏸ fix login" });
});

test("a status that already holds sends no rename, since Discord allows only about two per ten minutes", async () => {
  const f = threadAs("🔄 fix login");
  await threadHook(f.dc, "reply", `discord:${T}`, "tests are green", emoji);
  expect(f.calls().filter((c) => c.startsWith("PATCH"))).toEqual([]);
  const words = threadAs("fix login");
  await threadHook(words.dc, "reply", `discord:${T}`, "started", defaultDiscordWords);
  expect(words.json(3)).toEqual({ name: "[working] fix login" });
});

test("the progress message reads working:/done: in words, ⏳ · / ✅ with emoji", () => {
  expect(progressText("working", "14:05 edited", defaultDiscordWords)).toBe("working: 14:05 edited");
  expect(progressText("done", "login fixed", defaultDiscordWords)).toBe("done: login fixed");
  expect(progressText("working", "14:05 edited", emoji)).toBe("⏳ · 14:05 edited");
  expect(progressText("done", "login fixed", emoji)).toBe("✅ login fixed");
});

test("with emoji status a folded card starts with ✅ instead of the answered word", async () => {
  state = withState();
  const f = fakeDiscord((req) => (req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {}));
  const cards = new QuestionCards(f.dc, new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words: emoji }, () => Date.parse("2026-01-02T03:04:00Z"));
  await cards.ask("Ship?", ["Yes"]);
  await cards.handle(tap("q:Q1:0"));
  expect(f.json(1).data.components[0].components[0].content).toBe("✅ **Q1** Ship?\n→ **Yes**\n-# button · 1/2, 03:04");
});
