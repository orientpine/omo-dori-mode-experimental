import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { takeLock } from "../src/checkpoints.ts";
import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { type Interaction, QuestionCards, QuestionError, QuestionStore } from "../src/messenger/discord-cards.ts";
import { setThreadStatus, progressText, threadHook, ThreadRefError } from "../src/messenger/discord-thread.ts";
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
  const f = fakeDiscord(route ?? ((req) => (req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : req.method === "GET" ? { type: 11 } : {})));
  const store = new QuestionStore(`${state.dir}/discord`);
  const cards = new QuestionCards(f.dc, store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  return { ...f, store, cards };
};

const tap = (customId: string, user = OWNER): Interaction => ({ id: "i1", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: user } }, data: { custom_id: customId } });

type Button = { style: number; label: string; custom_id: string };
type Part = { type: number; content?: string; components?: (Button & { type: number; content?: string })[]; accessory?: Button };
const parts = (card: unknown) => (card as { components: Part[] }[])[0]?.components ?? [];
// every button in order: an option's pick button beside its section text, then the write-my-own row
const rows = (card: unknown) => parts(card).flatMap((c) => (c.type === 9 ? [c.accessory] : c.type === 1 ? [c.components?.[0]] : []));
const optionTexts = (card: unknown) => parts(card).filter((c) => c.type === 9).map((c) => c.components?.[0]?.content);

test("a question card is a V2 message that pings only the owner, recommended option first and primary, write-my-own last", async () => {
  const { cards, store, calls, json } = setup();
  const q = await cards.ask("Ship the fix today?", ["Ship it", "Wait for review"], { session: "sess-1", tmux: "aoe_demo_1234abcd" });
  expect(q.id).toBe("Q1");
  expect(calls()).toEqual([`POST /channels/${CHANNEL}/messages`]);
  const body = json(0);
  expect(body.flags).toBe(1 << 15);
  expect(body.allowed_mentions).toEqual({ users: [OWNER] });
  expect(body.components[0].type).toBe(17);
  expect(body.components[0].components[0].content).toBe(`<@${OWNER}> **Q1** Ship the fix today?`);
  expect(body.components[0].components.map((c: Part) => c.type)).toEqual([10, 9, 9, 1]);
  expect(optionTexts(body.components)).toEqual(["**1.** Ship it", "**2.** Wait for review"]);
  expect(rows(body.components)).toEqual([
    { type: 2, style: 1, label: "Pick 1 (recommended)", custom_id: "q:Q1:0" },
    { type: 2, style: 2, label: "Pick 2", custom_id: "q:Q1:1" },
    { type: 2, style: 2, label: "Write my own", custom_id: "q:Q1:other" },
  ] as never);
  expect(store.get("Q1")).toMatchObject({ status: "open", message: "900", session: "sess-1", tmux: "aoe_demo_1234abcd" });
});

test("a long option is shown in full in its section text, not clipped into a button label, and its tap answers with the full text", async () => {
  const { cards, store, json } = setup();
  const long = `Keep the old session cookie for thirty days, then log everyone out on the next deploy and send a notice ${"x".repeat(40)}`;
  expect(long.length).toBeGreaterThan(100);
  await cards.ask("Ship?", ["Yes", long]);
  const card = json(0).components;
  expect(optionTexts(card)[1]).toBe(`**2.** ${long}`);
  expect(rows(card).every((b) => (b?.label.length ?? 0) <= 80)).toBe(true);
  expect(rows(card)[1]).toMatchObject({ label: "Pick 2", custom_id: "q:Q1:1" });
  await cards.handle(tap("q:Q1:1"));
  expect(store.get("Q1")?.answer).toBe(long);
});

test("a long question folds with its answer and footer whole: the question is cut, never the answer (egress gate card answer, review 1 of #370)", async () => {
  const { cards, json } = setup();
  const option = `Take the cleanup ${"y".repeat(290)}`;
  await cards.ask(`Clean up? ${"x".repeat(2890)}`, ["Keep", option]);
  await cards.handle(tap("q:Q1:1"));
  const text: string = json(1).data.components[0].components[0].content;
  expect(text.length).toBeLessThanOrEqual(3000);
  expect(text.startsWith("[answered] **Q1** Clean up? x")).toBe(true);
  expect(text.endsWith(`x…\n→ **${option}**\n-# button · 1/2, 03:04`)).toBe(true);
});

test("a question that fits only unescaped folds whole and unescaped, not cut (review 2 of #370)", async () => {
  const { cards, json } = setup();
  const question = `${"q_".repeat(1000)}TAIL`;
  await cards.ask(question, ["Keep", "Drop"]);
  await cards.handle(tap("q:Q1:1"));
  const text: string = json(1).data.components[0].components[0].content;
  expect(text).toBe(`[answered] **Q1** ${question}\n→ **Drop**\n-# button · 1/2, 03:04`);
});

test("pick-button wording comes from the discord words", async () => {
  const { dc, store, json } = setup();
  const words = { ...defaultDiscordWords, pick: "{n} 선택", recommended: "추천", other: "직접 입력" };
  await new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words }, () => 0).ask("배포?", ["예", "아니오"]);
  expect(rows(json(0).components).map((b) => b?.label)).toEqual(["1 선택 (추천)", "2 선택", "직접 입력"]);
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
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(store.all()).toEqual([]);
  await expect(cards.reopen("Q1")).rejects.toBeInstanceOf(QuestionError);
});

test("an option a card cannot show whole is refused before anything is stored or posted; one that just fits is shown whole and its tap answers with it (review 4 of #370)", async () => {
  // The egress gate takes a tap's answer only when it equals the pressed option's text in the card, so a section cut to
  // its 1000 characters would make the owner's real tap a forged answer after the question was already marked answered.
  const { cards, store, seen, json } = setup();
  const fits = `${"o_".repeat(496)}o`;
  expect(`**2.** ${fits}`.length).toBe(1000);
  await expect(cards.ask("Ship?", ["Yes", `${fits}x`])).rejects.toBeInstanceOf(QuestionError);
  expect(seen).toHaveLength(0);
  expect(store.all()).toHaveLength(0);
  await cards.ask("Ship?", ["Yes", fits]);
  expect(optionTexts(json(0).components)[1]).toBe(`**2.** ${fits}`);
  await cards.handle(tap("q:Q1:1"));
  expect(store.get("Q1")?.answer).toBe(fits);
});

test("an option holding the answer arrow line is refused before anything is stored or posted (review 6 of #370)", async () => {
  // The folded card's answer is the text after its last "\n→ **"; an option holding one would read as two answers.
  const { cards, store, seen } = setup();
  await expect(cards.ask("Ship?", ["Yes", "Keep\n→ **old**"])).rejects.toBeInstanceOf(QuestionError);
  expect(seen).toHaveLength(0);
  expect(store.all()).toHaveLength(0);
});

test("a button answer folds into the card as its option reads on the card, escaped or not (round 7 of #370)", async () => {
  // The egress gate takes a tap only when the folded answer is the pressed option's text exactly as the card shows it.
  const { cards, json } = setup();
  const option = "a_".repeat(496); // fits the 1000-character section only unescaped
  await cards.ask("Pick?", ["Keep", option]);
  const section: string = optionTexts(json(0).components)[1] ?? "";
  expect(section).toBe(`**2.** ${option}`);
  await cards.handle(tap("q:Q1:1"));
  const text: string = json(1).data.components[0].components[0].content;
  expect(text.endsWith(`\n→ **${section.slice("**2.** ".length)}**\n-# button · 1/2, 03:04`)).toBe(true);
});

test("a tap whose callback Discord or the egress gate refuses leaves the question open and unlogged (round 7 of #370)", async () => {
  state = withState();
  const http: Http = async (req): Promise<HttpResponse> =>
    req.url.includes("/interactions/") ? { status: 403, headers: {}, body: JSON.stringify({ error: "card-answer-forged" }) }
    : { status: 200, headers: {}, body: JSON.stringify(req.method === "POST" ? { id: "900" } : { type: 11 }) };
  const store = new QuestionStore(`${state.dir}/discord`);
  const cards = new QuestionCards(new Discord(http, fakeClock(0), "bot"), store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  await cards.ask("Ship?", ["Yes", "No"]);
  await expect(cards.handle(tap("q:Q1:0"))).rejects.toThrow();
  expect(store.get("Q1")?.status).toBe("open");
  expect(existsSync(store.answersFile)).toBe(false);
});

test("a second tap while the first tap's callback is in flight folds nothing, and a refused fold frees the question (review 7 of #370)", async () => {
  // The listener handles taps at once. Two folds in flight would let the card and the egress gate's tap receipt say B
  // while the store keeps A; the second tap is only acknowledged, and a fold Discord refuses lets the next tap fold.
  state = withState();
  const callbacks: { body: { type: number; data?: { components: unknown } }; settle: (r: HttpResponse) => void }[] = [];
  let arrived: () => void = () => {};
  const http: Http = (req) =>
    req.url.includes("/interactions/")
      ? new Promise((settle) => { callbacks.push({ body: JSON.parse(String(req.body)), settle }); arrived(); })
      : Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(req.method === "POST" ? { id: "900" } : { type: 11 }) });
  const until = (n: number) => new Promise<void>((done) => { arrived = () => callbacks.length >= n && done(); arrived(); });
  const store = new QuestionStore(`${state.dir}/discord`);
  const cards = new QuestionCards(new Discord(http, fakeClock(0), "bot"), store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  const ok: HttpResponse = { status: 204, headers: {}, body: "" };
  await cards.ask("Ship?", ["Yes", "No"]);

  const first = cards.handle(tap("q:Q1:0"));
  await until(1);
  const second = cards.handle({ ...tap("q:Q1:1"), id: "i2" });
  await until(2);
  expect(callbacks.map((c) => c.body.type)).toEqual([7, 6]);
  callbacks[1]?.settle(ok);
  expect(await second).toEqual({ kind: "stale", qid: "Q1" });
  callbacks[0]?.settle(ok);
  expect((await first).kind).toBe("answered");
  expect(store.get("Q1")).toMatchObject({ status: "answered", answer: "Yes" });
  expect(readFileSync(store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);

  await cards.ask("Deploy?", ["Now", "Later"]);
  const refused = cards.handle(tap("q:Q2:0"));
  await until(3);
  callbacks[2]?.settle({ status: 403, headers: {}, body: JSON.stringify({ error: "card-answer-forged" }) });
  await expect(refused).rejects.toThrow();
  expect(store.get("Q2")?.status).toBe("open");
  const retry = cards.handle(tap("q:Q2:1"));
  await until(4);
  expect(callbacks[3]?.body.type).toBe(7);
  callbacks[3]?.settle(ok);
  expect((await retry).kind).toBe("answered");
  expect(store.get("Q2")?.answer).toBe("Later");
});

test("dori resolve or reopen, another process on the same store, waits for a tap's fold in flight; a tap during their claim is only acknowledged (review of #374)", async () => {
  // The challenge of #370's next plan: tap, resolve and reopen each wrote one question by their own path, so a resolve
  // landing in the callback's window logged the typed answer while Discord and the egress gate's receipt kept the tap's.
  // The listener folds taps; dori resolve and dori reopen are separate processes with their own QuestionCards on the
  // same store directory, so the hold is a claim file there.
  state = withState();
  const seen: string[] = [];
  const callbacks: { body: { type: number }; settle: (r: HttpResponse) => void }[] = [];
  let arrived: () => void = () => {};
  const http: Http = (req) => {
    seen.push(`${req.method} ${req.url.replace("https://discord.com/api/v10", "")}`);
    return req.url.includes("/interactions/")
      ? new Promise((settle) => { callbacks.push({ body: JSON.parse(String(req.body)), settle }); arrived(); })
      : Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(req.method === "POST" ? { id: "900" } : { type: 11 }) });
  };
  const until = (n: number) => new Promise<void>((done) => { arrived = () => callbacks.length >= n && done(); arrived(); });
  const now = Date.parse("2026-01-02T03:04:00Z");
  const instance = () => new QuestionCards(new Discord(http, fakeClock(0), "bot"), new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => now);
  const listener = instance();
  const cli = instance();
  const store = listener.store;
  const ok: HttpResponse = { status: 204, headers: {}, body: "" };
  const logged = () => readFileSync(store.answersFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { answer: string; answerKind: string });
  await listener.ask("Ship?", ["Yes", "No"]);

  const tapped = listener.handle(tap("q:Q1:0"));
  await until(1);
  const resolved = cli.resolve("Q1", "No");
  await Promise.resolve();
  expect(seen.filter((s) => s.startsWith("PATCH"))).toEqual([]);
  callbacks[0]?.settle(ok);
  expect((await tapped).kind).toBe("answered");
  expect(await resolved).toBe("kept");
  expect(logged().map((q) => [q.answer, q.answerKind])).toEqual([["Yes", "button"]]);
  expect(seen.filter((s) => s.startsWith("PATCH"))).toEqual([]);

  await listener.ask("Deploy?", ["Now", "Later"]);
  const refused = listener.handle(tap("q:Q2:1"));
  await until(2);
  const reopened = cli.reopen("Q2");
  const typed = cli.resolve("Q2", "Tomorrow");
  callbacks[1]?.settle({ status: 403, headers: {}, body: JSON.stringify({ error: "card-answer-forged" }) });
  await expect(refused).rejects.toThrow();
  expect((await reopened).status).toBe("open");
  expect(await typed).toBe("folded");
  expect(logged().map((q) => q.answer)).toEqual(["Yes", "Tomorrow"]);

  // A claim another holder has (a resolve editing the card), however old its record: the tap is only acknowledged.
  await listener.ask("Merge?", ["Yes", "No"]);
  const lock = `${state.dir}/discord/claim-Q3.lock`;
  const held = takeLock(lock, now - 60_000, "question", "Q3");
  const tapped3 = listener.handle(tap("q:Q3:0"));
  await until(3);
  expect(callbacks[2]?.body.type).toBe(6);
  callbacks[2]?.settle(ok);
  expect(await tapped3).toEqual({ kind: "stale", qid: "Q3" });
  expect(store.get("Q3")?.status).toBe("open");
  held();
  // A lock file nobody holds (its process ended) claims nothing.
  writeFileSync(lock, JSON.stringify({ pid: 1, host: "x", at: "2026-01-01T00:00:00Z", nonce: "n" }));
  expect(await cli.resolve("Q3", "Later")).toBe("folded");

  // Another process holding the claim: dori resolve waits until it lets go, then folds.
  await listener.ask("Tag?", ["Yes", "No"]);
  const child = Bun.spawn(["bun", "-e", `const { takeLock } = await import(${JSON.stringify(`${import.meta.dir}/../src/checkpoints.ts`)}); const r = takeLock(${JSON.stringify(`${state.dir}/discord/claim-Q4.lock`)}, Date.now(), "question", "Q4"); console.log("HELD"); await Bun.stdin.text(); r();`], { stdin: "pipe", stdout: "pipe" });
  const reader = child.stdout.getReader();
  let said = "";
  while (!said.includes("HELD")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder ended: ${said}`);
    said += new TextDecoder().decode(value);
  }
  expect(store.claim("Q4", now)).toBeNull();
  const patches = seen.filter((s) => s.startsWith("PATCH")).length;
  const waiting = cli.resolve("Q4", "Never");
  await Promise.resolve();
  expect(seen.filter((s) => s.startsWith("PATCH")).length).toBe(patches);
  expect(store.get("Q4")?.status).toBe("open");
  child.stdin.end();
  await child.exited;
  expect(await waiting).toBe("folded");
  expect(logged().map((q) => q.answer)).toEqual(["Yes", "Tomorrow", "Later", "Never"]);

  // A late tap on an answered card repaints its record; a reopen waits for that repaint, so the reopened card is the
  // last drawing and the store says open as Discord does (review 3 of #374).
  await listener.ask("Ship now?", ["Yes", "No"]);
  const first = listener.handle(tap("q:Q5:0"));
  await until(4);
  callbacks[3]?.settle(ok);
  expect((await first).kind).toBe("answered");
  const repaint = listener.handle({ ...tap("q:Q5:1"), id: "i9" });
  await until(5);
  expect(callbacks[4]?.body.type).toBe(7);
  const order: string[] = [];
  const drawn = seen.filter((s) => s.startsWith("PATCH")).length;
  const reopening = cli.reopen("Q5").then((q) => { order.push("reopened"); return q; });
  await new Promise((drained) => setImmediate(drained)); // an unheld reopen finishes within these queued jobs
  expect(order).toEqual([]);
  expect(seen.filter((s) => s.startsWith("PATCH")).length).toBe(drawn);
  order.push("repainted");
  callbacks[4]?.settle(ok);
  expect(await repaint).toEqual({ kind: "stale", qid: "Q5" });
  expect((await reopening).status).toBe("open");
  expect(order).toEqual(["repainted", "reopened"]);
  expect(store.get("Q5")?.status).toBe("open");
});

test("a question with no options or with shell-substitution text is refused before anything is posted", async () => {
  const { cards, seen } = setup();
  await expect(cards.ask("Ship?", [])).rejects.toBeInstanceOf(QuestionError);
  await expect(cards.ask("Ship $(whoami)?", ["Yes"])).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

// a work thread whose name the fake keeps current, so each status change is one rename
const threadCards = (name = "🔄 fix login") => {
  const thread = { name };
  const f = setup((req) => {
    if (req.method === "GET") return { name: thread.name, type: 11 };
    if (req.method === "PATCH" && req.url.endsWith("/channels/300")) thread.name = JSON.parse(String(req.body)).name ?? thread.name;
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  const cards = new QuestionCards(f.dc, f.store, { channel: CHANNEL, owner: OWNER, words: { ...defaultDiscordWords, statusStyle: "emoji" } }, () => Date.parse("2026-01-02T03:04:00Z"));
  return { ...f, cards, thread };
};
const threadTap = (customId: string): Interaction => ({ ...tap(customId), channel_id: "300" });

test("with a work thread the card is posted inside it, with no link back, and the thread is marked 🔔", async () => {
  const { cards, store, calls, json, thread } = threadCards();
  await cards.ask("Ship?", ["Yes", "No"], { thread: "300" });
  expect(calls()).toEqual(["POST /channels/300/messages", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(0).components[0].components[0].content).toBe(`<@${OWNER}> **Q1** Ship?`);
  expect(json(2)).toEqual({ name: "🔔 fix login" });
  expect(thread.name).toBe("🔔 fix login");
  expect(store.get("Q1")).toMatchObject({ channel: "300", thread: "300", message: "900" });
});

test("an answer to a card inside its thread posts no record line and marks the thread 🔄 again", async () => {
  const { cards, calls, json } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(calls().slice(3)).toEqual(["POST /interactions/i1/tok/callback", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(5)).toEqual({ name: "🔄 fix login" });
});

test("while another question in the same thread is still open, an answer leaves the thread 🔔", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  const before = calls().length;
  await cards.afterAnswer(out.question);
  expect(calls().slice(before).filter((c) => c.startsWith("PATCH"))).toEqual([]);
  expect(thread.name).toBe("🔔 fix login");
});

test("a card posted in the channel for a work thread leaves a silent record line there, then marks the thread 🔄", async () => {
  const { cards, store, calls, json } = threadCards("🔔 fix login");
  const asked = store.create("Ship?", ["Yes"], CHANNEL, { thread: "300" }, "2026-01-02T03:00:00Z");
  store.setMessage(asked.id, "900");
  const out = await cards.handle(tap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(calls()).toEqual(["POST /interactions/i1/tok/callback", "POST /channels/300/messages", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(1)).toEqual({ content: "Q1 Ship?\n→ Yes (1/2, 03:04)", flags: 1 << 12, allowed_mentions: { parse: [] } });
  expect(json(3)).toEqual({ name: "🔄 fix login" });
});

test("reopening a card inside its thread patches it there and marks the thread 🔔 again", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(thread.name).toBe("🔄 fix login");
  const before = calls().length;
  await cards.reopen("Q1");
  expect(calls().slice(before)).toEqual(["PATCH /channels/300/messages/900", "GET /channels/300", "PATCH /channels/300"]);
  expect(thread.name).toBe("🔔 fix login");
});

test("resolving the last open card in a thread without an answer marks the thread 🔄", async () => {
  const { cards, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q2:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(thread.name).toBe("🔔 fix login");
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(thread.name).toBe("🔄 fix login");
});

test("with word status the same resolve marks the thread [working]", async () => {
  const { dc, store, thread } = threadCards("[waiting] fix login");
  const cards = new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => 0);
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(thread.name).toBe("[working] fix login");
});

test("resolving an open card while another card in the thread is still open leaves the thread 🔔", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const before = calls().length;
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(calls().slice(before).filter((c) => c.startsWith("PATCH"))).toEqual(["PATCH /channels/300/messages/900"]);
  expect(thread.name).toBe("🔔 fix login");
});

test("resolving an answered card does not touch the thread status", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.handle(threadTap("q:Q1:0"));
  thread.name = "🔔 fix login";
  const before = calls().length;
  expect(await cards.resolve("Q1", "no")).toBe("kept");
  expect(calls().slice(before)).toEqual([]);
  expect(thread.name).toBe("🔔 fix login");
  expect(await cards.resolve("Q9")).toBeNull();
});

const content = (card: unknown) => parts(card)[0]?.content;

test("resolving a card the owner answered in text folds it into the record a tap leaves, logs the answer once, and a second resolve changes nothing", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship?", ["Yes", "No"]);
  expect(await cards.resolve("Q1", "  ship it monday  ")).toBe("folded");
  expect(calls()).toEqual([`POST /channels/${CHANNEL}/messages`, `PATCH /channels/${CHANNEL}/messages/900`]);
  expect(parts(json(1).components)).toHaveLength(1);
  expect(content(json(1).components)).toBe("[answered] **Q1** Ship?\n→ **ship it monday**\n-# reply · 1/2, 03:04");
  const logged = readFileSync(store.answersFile, "utf8").trim().split("\n");
  expect(logged).toHaveLength(1);
  expect(JSON.parse(logged[0] ?? "")).toMatchObject({ id: "Q1", status: "answered", answer: "ship it monday", answerKind: "reply" });
  expect(store.all()).toEqual([]);
  expect(await cards.resolve("Q1", "ship it monday")).toBe("already");
  expect(calls()).toHaveLength(2);
  expect(readFileSync(store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("without --answer the folded card reads the repliedInText word, marked byReply", async () => {
  const { dc, store, json } = setup();
  const words = { ...defaultDiscordWords, statusStyle: "emoji", byReply: "글", repliedInText: "형 글로 답함" } as const;
  const cards = new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words }, () => Date.parse("2026-01-02T03:04:00Z"));
  await cards.ask("Ship?", ["Yes"]);
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(content(json(1).components)).toBe("✅ **Q1** Ship?\n→ **형 글로 답함**\n-# 글 · 1/2, 03:04");
});

test("resolving a card inside its thread folds it there, then marks the thread 🔄", async () => {
  const { cards, calls, json, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const before = calls().length;
  expect(await cards.resolve("Q1", "yes, today")).toBe("folded");
  expect(calls().slice(before)).toEqual(["PATCH /channels/300/messages/900", "GET /channels/300", "PATCH /channels/300"]);
  expect(content(json(before).components)).toBe("✅ **Q1** Ship?\n→ **yes, today**\n-# reply · 1/2, 03:04");
  expect(thread.name).toBe("🔄 fix login");
});

test("a card in a thread that archived itself is folded by opening the thread and editing it again", async () => {
  const thread = { archived: false };
  const { cards, calls, json } = setup((req) => {
    if (req.method === "PATCH" && req.url.endsWith("/channels/300")) thread.archived = JSON.parse(String(req.body)).archived ?? thread.archived;
    if (req.method === "PATCH" && req.url.includes("/messages/") && thread.archived) throw new Error('discord PATCH /channels/300/messages/900: 400 {"message": "Thread is archived", "code": 50083}');
    if (req.method === "GET") return { name: "🔔 fix login", type: 11, thread_metadata: { archived: thread.archived } };
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  thread.archived = true;
  const before = calls().length;
  expect(await cards.resolve("Q1", "yes")).toBe("folded");
  expect(calls().slice(before, before + 3)).toEqual(["PATCH /channels/300/messages/900", "PATCH /channels/300", "PATCH /channels/300/messages/900"]);
  expect(json(before + 1)).toEqual({ archived: false });
  expect(content(json(before + 2).components)).toBe("[answered] **Q1** Ship?\n→ **yes**\n-# reply · 1/2, 03:04");
  expect(readFileSync(cards.store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("a failed card edit keeps the question open and unlogged, so resolve can be run again", async () => {
  const { cards, store } = setup((req) => {
    if (req.method === "PATCH") throw new Error("discord down");
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  await cards.ask("Ship?", ["Yes"]);
  await expect(cards.resolve("Q1", "yes")).rejects.toThrow();
  expect(store.get("Q1")?.status).toBe("open");
  expect(existsSync(store.answersFile)).toBe(false);
});

test("a failed thread rename does not fail the ask: the card is already posted", async () => {
  const { cards, store } = setup((req) => {
    if (req.method === "GET") throw new Error("rate limited");
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  const q = await cards.ask("Ship?", ["Yes"], { thread: "300" });
  expect(q.message).toBe("900");
  expect(store.get("Q1")?.status).toBe("open");
});

test("the done thread hook posts without emoji, swaps the status word in the thread name, then archives", async () => {
  const f = fakeDiscord((req) => (req.method === "GET" ? { name: "[working] fix login", type: 11 } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));
  const t = "300000000000000003";
  expect((await threadHook(f.dc, "done", `discord:${t}`, "merged 🎉 abc123", defaultDiscordWords)).id).toBe("901");
  expect(f.calls()).toEqual([`POST /channels/${t}/typing`, `POST /channels/${t}/messages`, `GET /channels/${t}`, `PATCH /channels/${t}`, `PATCH /channels/${t}`]);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "[done] fix login" });
  expect(f.json(4)).toEqual({ archived: true });
  await expect(threadHook(f.dc, "reply", "telegram:1", "x", defaultDiscordWords)).rejects.toBeInstanceOf(ThreadRefError);
});

const emoji = { ...defaultDiscordWords, statusStyle: "emoji" } as const;
const T = "300000000000000003";
const threadAs = (name: string, archived = false) => fakeDiscord((req) => (req.method === "GET" ? { name, type: 11, thread_metadata: { archived } } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));

test("with emoji status the done hook swaps the word mark for ✅ and archives; the posted note still has no emoji", async () => {
  const f = threadAs("[working] fix login");
  await threadHook(f.dc, "done", `discord:${T}`, "merged 🎉 abc123", emoji);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "✅ fix login" });
  expect(f.json(4)).toEqual({ archived: true });
});

test("a reply with no lane working leaves the thread to the owner (🔔) and wait marks it waiting, opening an archived thread in the same request", async () => {
  const done = threadAs("✅ fix login", true);
  await threadHook(done.dc, "reply", `discord:${T}`, "picking this up again", emoji);
  expect(done.calls().slice(2)).toEqual([`GET /channels/${T}`, `PATCH /channels/${T}`]);
  expect(done.json(3)).toEqual({ name: "🔔 fix login", archived: false });
  const working = threadAs("🔄 fix login");
  await threadHook(working.dc, "wait", `discord:${T}`, "Q2 is waiting on you", emoji);
  expect(working.json(3)).toEqual({ name: "🔔 fix login" });
});

test("a thread named with the old ⏸ (no U+FE0F) mark is still recognized: its mark is replaced, never doubled", async () => {
  const legacy = threadAs("\u23F8 fix login");
  await setThreadStatus(legacy.dc, T, "working", emoji);
  expect(legacy.json(1)).toEqual({ name: "🔄 fix login" });
  const waiting = threadAs("\u23F8\uFE0F fix login");
  await threadHook(waiting.dc, "wait", `discord:${T}`, "still waiting", emoji);
  expect(waiting.json(3)).toEqual({ name: "🔔 fix login" });
});

test("a status that already holds sends no rename, since Discord allows only about two per ten minutes", async () => {
  const f = threadAs("🔔 fix login");
  await threadHook(f.dc, "reply", `discord:${T}`, "tests are green", emoji);
  expect(f.calls().filter((c) => c.startsWith("PATCH"))).toEqual([]);
  const words = threadAs("fix login");
  await threadHook(words.dc, "reply", `discord:${T}`, "started", defaultDiscordWords);
  expect(words.json(3)).toEqual({ name: "[waiting] fix login" });
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
