import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discord } from "../src/messenger/discord.ts";
import type { Http } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { notePosted, type PostParts, type Sent, sendOnce, setPostLedger } from "../src/send-dedupe.ts";
import { fakeClock } from "./fakes.ts";

// windowMs 0: the 10 minute window is over, only the place's last post still counts
const AFTER = { windowMs: 0 };
const T = "1566900000000000001";
const discordText = (text: string, extra: Partial<PostParts> = {}) => ({ parts: { platform: "discord", where: T, ...extra }, text });

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "send-dedupe-"));
  try {
    await body(dir);
  } finally {
    setPostLedger(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
};

// a Discord whose every created message gets the next snowflake, and which answers edits
const discordApi = () => {
  let n = 200;
  const http: Http = async (req) => ({ status: 200, headers: {}, body: JSON.stringify(req.method === "POST" && req.url.endsWith("/messages") ? { id: String(1566900000000000000n + BigInt(++n)), content: "" } : {}) });
  return new Discord(http, fakeClock(0), "t", "http://discord.test");
};

// review of #338: a thread reply posts, then waits for its status; a send posted meanwhile must stay the place's last post
test("a post that finishes after a later post to the same place never takes the last-post record from it", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    // a messenger client records the message when it is created, as Discord.post does
    const created = (id: string, text: string): Sent => (notePosted(`discord:${T}`, id, discordText(text)), { id, content: text });
    let finishA: (s: Sent) => void = () => {};
    const a = sendOnce(dir, `discord:${T}`, discordText("A"), () => new Promise<Sent>((r) => (finishA = r)));
    const b = await sendOnce(dir, `discord:${T}`, discordText("B"), async () => created("1566900000000000102", "B"));
    finishA(created("1566900000000000101", "A"));
    await a;
    const againB = await sendOnce(dir, `discord:${T}`, discordText("B"), async () => created("1566900000000000103", "B"), AFTER);
    const againA = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => created("1566900000000000104", "A"), AFTER);
    expect({ b: b.duplicate, againB: [againB.id, againB.duplicate], againA: againA.duplicate }).toEqual({ b: false, againB: ["1566900000000000102", true], againA: false });
  }));

// review 2 of #338: a lane's close posts its summary straight through Discord (done-flow postInThread), not dori send
test("a post the CLI makes past dori send (a close summary, a card) is the place's last post too", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const dc = discordApi();
    await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"));
    await dc.send(T, "B");
    const a = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"), AFTER);
    await dc.call("POST", `/channels/${T}/messages`, { components: [] });
    const b = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"), AFTER);
    const repeat = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"), AFTER);
    expect({ a: a.duplicate, afterCard: b.duplicate, repeat: repeat.duplicate }).toEqual({ a: false, afterCard: false, repeat: true });
  }));

// review 2 of #338: send A as a reply, edit it to B; B as the same reply again is the repeat
test("an edit of the place's last post keeps its reply target and takes the edited text; an older message's edit changes nothing", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const dc = discordApi();
    const asReply = { reply: "1566800000000000009", files: [] };
    const first = await sendOnce(dir, `discord:${T}`, discordText("A", asReply), async () => dc.post(T, "A", false, undefined, asReply.reply));
    await dc.edit(T, "1566800000000000001", "X");
    const stillA = await sendOnce(dir, `discord:${T}`, discordText("A", asReply), async () => dc.post(T, "A", false, undefined, asReply.reply), AFTER);
    await dc.edit(T, first.id, "B");
    const b = await sendOnce(dir, `discord:${T}`, discordText("B", asReply), async () => dc.post(T, "B", false, undefined, asReply.reply), AFTER);
    const plainB = await sendOnce(dir, `discord:${T}`, discordText("B"), async () => dc.post(T, "B"), AFTER);
    expect({ stillA: stillA.duplicate, b: [b.id, b.duplicate], plainB: plainB.duplicate }).toEqual({ stillA: true, b: [first.id, true], plainB: false });
  }));

// review 3 of #338: thread reply's post is recorded, then it waits for its status while another command edits the post
test("an edit made while the posting command still runs stays the post's record", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const dc = discordApi();
    await sendOnce(dir, `discord:${T}`, discordText("A"), async () => {
      const p = await dc.post(T, "A");
      await dc.edit(T, p.id, "B");
      return p;
    });
    const b = await sendOnce(dir, `discord:${T}`, discordText("B"), async () => dc.post(T, "B"), AFTER);
    const a = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"), AFTER);
    expect({ b: b.duplicate, a: a.duplicate }).toEqual({ b: true, a: false });
  }));

// review 3 of #338: a text posted while a file share is still uploading is newer than the share's request
test("a text posted while a Slack share uploads stays the channel's last post when the share answers later", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const clock = fakeClock(1700000200_000);
    let ts = 1700000300;
    let slack: Slack | undefined;
    const text = { parts: { platform: "slack", where: "C1/" }, text: "다른 글" };
    const http: Http = async (req) => {
      const method = req.url.split("/").pop();
      if (method === "files.completeUploadExternal") {
        await sendOnce(dir, "slack:C1", text, async () => ({ id: (await (slack as Slack).post("C1", text.text)).ts }));
        clock.at = 1700000400_000;
      }
      const body = method === "chat.postMessage" ? { ok: true, channel: "C1", ts: `${++ts}.000100` } : method === "files.getUploadURLExternal" ? { ok: true, upload_url: "http://slack.test/up", file_id: "F1" } : { ok: true };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    };
    slack = new Slack(http, clock, { token: "t" }, "http://slack.test/api");
    await slack.upload("C1", [{ filename: "deck.pdf", length: 3, read: async () => new Uint8Array([1, 2, 3]) }]);
    const again = await sendOnce(dir, "slack:C1", text, async () => ({ id: (await slack.post("C1", text.text)).ts }), AFTER);
    expect(again.duplicate).toBe(true);
  }));

// review 5 of #338: two edits of one message at once; the first one's answer comes last. The service holds the edit it
// applied last, and the record must say the same, so a repeat of that text is refused
test("two edits of one message at once: the record holds the text the service applied last, though the first edit answers last", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    let n = 300;
    let held: string | undefined;
    let releaseB: () => void = () => {};
    const bAnswered = new Promise<void>((r) => (releaseB = r));
    const http: Http = async (req) => {
      if (req.method === "PATCH") {
        held = (JSON.parse(String(req.body)) as { content: string }).content;
        if (held === "B") await bAnswered;
        return { status: 200, headers: {}, body: "{}" };
      }
      return { status: 200, headers: {}, body: JSON.stringify(req.url.endsWith("/messages") ? { id: String(1566900000000000000n + BigInt(++n)), content: "" } : {}) };
    };
    const dc = new Discord(http, fakeClock(0), "t", "http://discord.test");
    const first = await sendOnce(dir, `discord:${T}`, discordText("A"), async () => dc.post(T, "A"));
    const editB = dc.edit(T, first.id, "B");
    // the second edit is under way before the first one answers
    const editC = dc.edit(T, first.id, "C");
    await Promise.resolve();
    releaseB();
    await Promise.all([editB, editC]);
    const c = await sendOnce(dir, `discord:${T}`, discordText(held ?? ""), async () => dc.post(T, held ?? ""), AFTER);
    expect({ held, repeat: c.duplicate }).toEqual({ held: "C", repeat: true });
  }));

// the Slack HTTP fake shared by the share tests: chat.postMessage answers the next ts, an upload goes through
const slackApi = (ts: { n: number }): Http => async (req) => {
  const method = req.url.split("/").pop();
  const body = method === "chat.postMessage" ? { ok: true, channel: "C1", ts: `${++ts.n}.000100` } : method === "files.getUploadURLExternal" ? { ok: true, upload_url: "http://slack.test/up", file_id: "F1" } : { ok: true };
  return { status: 200, headers: {}, body: JSON.stringify(body) };
};
const deck = [{ filename: "deck.pdf", length: 3, read: async () => new Uint8Array([1, 2, 3]) }];

// review 4 of #338: a share is not recorded at all (it names no ts), so it never takes the record from a text; the text
// before it, sent again across the share, is refused (--again posts), and nothing can post twice whatever the clock
test("a Slack file share is not the channel's last post: the text before it is refused once more, and --again posts it", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const slack = new Slack(slackApi({ n: 1700000100 }), fakeClock(1700000200_000), { token: "t" }, "http://slack.test/api");
    const text = { parts: { platform: "slack", where: "C1/" }, text: "\ubc30\ud3ec \ub05d\ub0ac\uc5b4" };
    const post = async () => ({ id: (await slack.post("C1", text.text)).ts });
    await sendOnce(dir, "slack:C1", text, post);
    await slack.upload("C1", deck);
    const again = await sendOnce(dir, "slack:C1", text, post, AFTER);
    const forced = await sendOnce(dir, "slack:C1", text, post, { ...AFTER, again: true });
    expect({ again: again.duplicate, forced: forced.duplicate }).toEqual({ again: true, forced: false });
  }));

// review 4 of #338: the host clock 30 s ahead of Slack's; upload, then text B; B after the window is still refused
test("with the host clock ahead of Slack's, a text posted right after a share stays the channel's last post", () =>
  withDir(async (dir) => {
    setPostLedger(dir);
    const ts = { n: 1700000100 };
    const slack = new Slack(slackApi(ts), fakeClock((ts.n + 30) * 1000), { token: "t" }, "http://slack.test/api");
    const b = { parts: { platform: "slack", where: "C1/" }, text: "\ub2e4\ub978 \uae00" };
    const post = async () => ({ id: (await slack.post("C1", b.text)).ts });
    await slack.upload("C1", deck);
    await sendOnce(dir, "slack:C1", b, post);
    const again = await sendOnce(dir, "slack:C1", b, post, AFTER);
    expect(again.duplicate).toBe(true);
  }));
