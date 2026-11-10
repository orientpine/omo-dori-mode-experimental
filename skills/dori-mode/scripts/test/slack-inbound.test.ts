import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { type Http, type HttpRequest, type HttpResponse, MessengerError } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const SELF = "U_DORI";
const state = withState();
afterEach(() => {});

type Workspace = { replies: Record<string, { ts: string; user?: string; text: string; bot_id?: string }[]>; view: unknown[]; counts: Record<string, unknown>; nextTs: number; rootError?: string };

const slackFake = (w: Workspace) => {
  const calls: string[] = [];
  const replyCalls: Record<string, unknown>[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.url.split("/").pop() ?? "";
    calls.push(method);
    const form = req.headers?.["Content-Type"]?.startsWith("application/x-www-form-urlencoded");
    if ((method === "conversations.replies" || method === "files.getUploadURLExternal") && !form) {
      return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: "invalid_arguments" }) };
    }
    const p: Record<string, unknown> = form ? Object.fromEntries(new URLSearchParams(String(req.body))) : JSON.parse(String(req.body ?? "{}"));
    const body = (b: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, ...(b as object) }) });
    if (method === "chat.postMessage") {
      const ts = `${w.nextTs++}.000100`;
      const root = typeof p["thread_ts"] === "string" ? p["thread_ts"] : ts;
      const thread = w.replies[`${p["channel"]}:${root}`] ?? []; w.replies[`${p["channel"]}:${root}`] = thread; thread.push({ ts, user: SELF, text: String(p["text"]) });
      return body({ channel: p["channel"], ts });
    }
    if (method === "conversations.replies") {
      replyCalls.push(p);
      if (w.rootError && p["limit"] === "1") return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: w.rootError }) };
      const all = w.replies[`${p["channel"]}:${p["ts"]}`] ?? [];
      const available = all.filter((m) => Number(m.ts) > Number(p["oldest"] ?? 0));
      const start = Number(p["cursor"] ?? 0);
      const limit = Number(p["limit"] ?? 1000);
      const messages = available.slice(start, start + limit);
      const nextCursor = start + limit < available.length ? String(start + limit) : "";
      return body({ messages, response_metadata: { next_cursor: nextCursor } });
    }
    if (method === "subscriptions.thread.getView") return body({ threads: w.view });
    if (method === "client.counts") return body(w.counts);
    return body({});
  };
  return { http, calls, replyCalls };
};

const setup = (name: string) => {
  const w: Workspace = { replies: {}, view: [], counts: { channels: [], ims: [], mpims: [] }, nextTs: 1000 };
  const { http, calls, replyCalls } = slackFake(w);
  const ledger = new ThreadLedger(join(state.dir, `${name}.json`));
  const slack = new Slack(http, fakeClock(0), { token: "t" }, "https://slack.test/api", ledger);
  return { w, slack, ledger, calls, replyCalls };
};

test("a guest's untagged reply in a thread the Dori started through a raw API call is still picked up", async () => {
  const { w, slack, ledger } = setup("raw-root");
  const root = (await slack.call("chat.postMessage", { channel: "C1", text: "Kicking off the release checklist" })) as { ts: string };
  w.replies[`C1:${root.ts}`]?.push({ ts: "2000.000100", user: "U_GUEST", text: "the staging deploy is red" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got).toEqual([{
    source: "own-thread", channel: "C1", ts: "2000.000100", threadTs: root.ts, user: "U_GUEST", text: "the staging deploy is red",
    root: { channel: "C1", rootTs: root.ts, user: SELF, text: "Kicking off the release checklist" }, recent: [],
  }]);
  expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
});

test("a watched reply carries a root older than seenTs and skips the Dori's own current messages", async () => {
  const { w, slack, ledger } = setup("reply");
  w.replies["C2:500.000100"] = [{ ts: "500.000100", user: "U_OWNER", text: "can you check this?" }];
  await slack.post("C2", "on it", "500.000100");
  w.replies["C2:500.000100"]?.push({ ts: "3000.000100", user: "U_OWNER", text: "thanks, also the logs" }, { ts: "3001.000100", bot_id: "B1", user: "U_BOT", text: "automated" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => [g.source, g.ts, g.user])).toEqual([["own-thread", "3000.000100", "U_OWNER"]]);
  expect(got[0]?.root).toEqual({ channel: "C2", rootTs: "500.000100", user: "U_OWNER", text: "can you check this?" });
  expect(got[0]?.recent).toEqual([{ ts: "1000.000100", user: SELF, text: "on it" }]);
});

test("unread replies from the threads view carry their root and recent first lines", async () => {
  const { w, slack, ledger } = setup("view");
  w.view = [{ root_msg: { channel: "C3", ts: "10.1", user: "U_OWNER" }, unread_replies: [{ ts: "11.1", thread_ts: "10.1", user: "U_TEAM", text: "ping" }, { ts: "12.1", thread_ts: "10.1", user: SELF, text: "mine" }] }];
  w.replies["C3:10.1"] = [
    { ts: "10.1", user: "U_OWNER", text: "root question" },
    { ts: "10.5", user: "U_HELPER", text: "context first line\ncontext second line" },
    { ts: "11.1", user: "U_TEAM", text: "ping" },
    { ts: "12.1", user: SELF, text: "mine" },
  ];
  w.counts = { channels: [{ id: "C9", has_unreads: true, mention_count: 0 }, { id: "C8", has_unreads: true, mention_count: 2 }], ims: [{ id: "D1", has_unreads: true, mention_count: 1 }], mpims: [] };
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got.map((g) => `${g.source}:${g.channel}:${g.ts}`)).toEqual(["threads-view:C3:11.1", "unread:D1:", "unread:C8:"]);
  expect(got[0]?.root).toEqual({ channel: "C3", rootTs: "10.1", user: "U_OWNER", text: "root question" });
  expect(got[0]?.recent).toEqual([{ ts: "10.5", user: "U_HELPER", text: "context first line" }]);
});

test("a thread beyond one page yields its last three replies as recent context", async () => {
  const { w, slack, ledger } = setup("pages");
  const root = await slack.post("C4", "root for a long thread");
  const replies = w.replies[`C4:${root.ts}`];
  for (let i = 1; i <= 50; i++) replies?.push({ ts: `${1000 + i}.000100`, user: SELF, text: `prior ${i}\nnot part of the first line` });
  replies?.push({ ts: "3000.000100", user: "U_OWNER", text: "current after the second page" });
  const got = await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  expect(got).toHaveLength(1);
  expect(got[0]?.recent).toEqual([48, 49, 50].map((i) => ({ ts: `${1000 + i}.000100`, user: SELF, text: `prior ${i}` })));
});

test("a root is read once across both sources and repeated polls", async () => {
  const { w, slack, ledger, replyCalls } = setup("root-cache");
  const root = await slack.post("C5", "root for cache");
  w.replies[`C5:${root.ts}`]?.push({ ts: "2000.000100", user: "U_OWNER", text: "current" });
  w.view = [{ root_msg: { channel: "C5", ts: root.ts }, unread_replies: [{ ts: "2000.000100", thread_ts: root.ts, user: "U_OWNER", text: "current" }] }];
  await pollSlackInbound(slack, ledger, { selfUserId: SELF });
  w.view = [];
  expect(await pollSlackInbound(slack, ledger, { selfUserId: SELF })).toEqual([]);
  expect(replyCalls.filter((p) => p["limit"] === "1")).toHaveLength(1);
});

test("a failed root lookup propagates and leaves seenTs unchanged", async () => {
  const { w, slack, ledger } = setup("root-failure");
  const root = await slack.post("C6", "root whose lookup fails");
  w.rootError = "thread_not_found";
  const error: unknown = await pollSlackInbound(slack, ledger, { selfUserId: SELF }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MessengerError);
  if (!(error instanceof MessengerError)) throw error;
  expect(error.code).toBe("thread_not_found");
  expect(await ledger.list()).toEqual([{ channel: "C6", rootTs: root.ts, seenTs: root.ts }]);
});

test("the thread ledger survives a restart: a new process still watches threads posted before it", async () => {
  const a = setup("restart");
  const root = (await a.slack.post("C4", "starting the migration")).ts;
  const fresh = new ThreadLedger(join(state.dir, "restart.json"));
  expect((await fresh.list()).map((t) => `${t.channel}:${t.rootTs}`)).toEqual([`C4:${root}`]);
});
