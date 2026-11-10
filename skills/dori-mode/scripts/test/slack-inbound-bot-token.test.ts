import { expect, test } from "bun:test";
import { join } from "node:path";
import { type Http, type HttpResponse, MessengerError } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const METHODS = ["subscriptions.thread.getView", "client.counts"] as const;
const ok = (value: object): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, ...value }) });

// #180: exercise real Slack.call and disk ledger. Existing coverage has no token refusals or late poll failures.
// Removing the narrow refusal handler loses delivery; committing seenTs before counts loses retries after failure.
test("bot token refusals warn for each skipped method and deliver an own-thread reply once", async () => {
  const state = withState();
  const warned: string[] = [];
  const http: Http = async (req) => {
    const method = req.url.split("/").pop() ?? "";
    if (METHODS.some((m) => m === method)) return ok({ ok: false, error: "not_allowed_token_type" });
    const params = new URLSearchParams(String(req.body));
    if (method === "conversations.replies") {
      if (params.get("limit") === "1") return ok({ messages: [{ ts: "1.1", user: "U_DORI", text: "starting" }] });
      return ok({ messages: params.get("oldest") === "1.1" ? [{ ts: "2.1", user: "U_OWNER", text: "go ahead" }] : [] });
    }
    return ok({ channel: "C1", ts: "1.1" });
  };
  try {
    const ledger = new ThreadLedger(join(state.dir, "threads.json"));
    const slack = new Slack(http, fakeClock(0), { token: "xoxb-fake" }, undefined, ledger);
    await slack.post("C1", "starting");
    const options = { selfUserId: "U_DORI", warn: (m: string) => warned.push(m) };
    expect(await pollSlackInbound(slack, ledger, options)).toEqual([
      {
        source: "own-thread", channel: "C1", ts: "2.1", threadTs: "1.1", user: "U_OWNER", text: "go ahead",
        root: { channel: "C1", rootTs: "1.1", user: "U_DORI", text: "starting" }, recent: [],
      },
    ]);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("subscriptions.thread.getView: not_allowed_token_type");
    expect(warned[0]).toContain("skipping the threads view");
    expect(warned[1]).toContain("client.counts: not_allowed_token_type");
    expect(warned[1]).toContain("skipping the unread counts");
    expect(await ledger.list()).toEqual([{ channel: "C1", rootTs: "1.1", seenTs: "2.1" }]);
    expect(await pollSlackInbound(slack, ledger, options)).toEqual([]);
  } finally {
    state.done();
  }
});

class NetworkFailure extends Error {}
const failures = ["invalid_auth", "network", "http500"] as const;

for (const method of METHODS) {
  for (const failure of failures) {
    test(`${method} ${failure} rethrows without degradation or consuming watched replies`, async () => {
      const state = withState();
      const warned: string[] = [];
      const waited: number[] = [];
      const network = new NetworkFailure("offline");
      let attempts = 0;
      let failing = true;
      const http: Http = async (req) => {
        const called = req.url.split("/").pop() ?? "";
        if (called === method && failing) {
          attempts++;
          switch (failure) {
            case "invalid_auth": return ok({ ok: false, error: "invalid_auth" });
            case "network": throw network;
            case "http500": return { status: 500, headers: {}, body: "{}" };
          }
        }
        if (called === "subscriptions.thread.getView") {
          return ok({ threads: [{ root_msg: { channel: "C2" }, unread_replies: [{ ts: "4.1", thread_ts: "3.1", user: "U_TEAM", text: "view" }] }] });
        }
        // Accept both encodings here to isolate late failures from the independent form contract below.
        if (called === "conversations.replies") {
          const params = new URLSearchParams(String(req.body));
          const rootTs = params.get("ts");
          if (params.get("limit") === "1") return ok({ messages: [{ ts: rootTs, user: "U_OWNER", text: `root ${rootTs}` }] });
          return ok({ messages: params.get("channel") === "C2" ? [{ ts: "4.1", user: "U_TEAM", text: "view" }] : [{ ts: "2.1", user: "U_OWNER", text: "own" }] });
        }
        return ok({});
      };
      try {
        const file = join(state.dir, "threads.json");
        const ledger = new ThreadLedger(file);
        await ledger.record("C1", "1.1", "1.1");
        await ledger.record("C2", "3.1", "3.1");
        const slack = new Slack(http, { ...fakeClock(0), sleep: async (ms) => { waited.push(ms); } }, { token: "fake" });
        const options = { selfUserId: "U_DORI", warn: (m: string) => warned.push(m) };
        const error: unknown = await pollSlackInbound(slack, ledger, options).catch((e: unknown) => e);
        if (failure === "network") expect(error).toBe(network);
        else {
          expect(error).toBeInstanceOf(MessengerError);
          if (!(error instanceof MessengerError)) throw error;
          expect(error.status).toBe(failure === "http500" ? 500 : 200);
          expect(error.code).toBe(failure === "invalid_auth" ? "invalid_auth" : "");
        }
        expect(attempts).toBe(failure === "http500" ? 5 : 1);
        expect(waited).toEqual(failure === "http500" ? [1000, 2000, 4000, 8000] : []);
        expect(warned).toEqual([]);
        const unseen = [{ channel: "C1", rootTs: "1.1", seenTs: "1.1" }, { channel: "C2", rootTs: "3.1", seenTs: "3.1" }];
        expect(await ledger.list()).toEqual(unseen);
        expect(await new ThreadLedger(file).list()).toEqual(unseen);
        failing = false;
        expect((await pollSlackInbound(slack, ledger, options)).map((i) => `${i.source}:${i.channel}:${i.ts}`)).toEqual([
          "threads-view:C2:4.1", "own-thread:C1:2.1",
        ]);
      } finally {
        state.done();
      }
    });
  }
}

// Existing upload tests explicitly request form encoding and never cover automatic selection or nullish values.
// A regression selecting JSON or stringifying absent fields violates the API wire contract, at real Slack.call.
test.each(["conversations.replies", "files.getUploadURLExternal"])("%s automatically uses UTF-8 form encoding and omits absent fields", async (method) => {
  const requests: { readonly type: string | undefined; readonly body: string }[] = [];
  const http: Http = async (req) => {
    requests.push({ type: req.headers?.["Content-Type"], body: String(req.body) });
    return ok({});
  };
  await new Slack(http, fakeClock(0), { token: "fake" }).call(method, { filename: "한 글 &+=?%.png", channel: "C+&", length: 3, missing: undefined, empty: null });
  expect(requests).toEqual([{
    type: "application/x-www-form-urlencoded; charset=utf-8",
    body: new URLSearchParams({ filename: "한 글 &+=?%.png", channel: "C+&", length: "3" }).toString(),
  }]);
  expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({ filename: "한 글 &+=?%.png", channel: "C+&", length: "3" });
});

// JSON APIs must retain nested data; blindly applying form encoding would corrupt a message or upload completion.
test.each(["chat.postMessage", "files.completeUploadExternal"])("%s keeps UTF-8 JSON and unchanged structured parameters", async (method) => {
  const seen: { readonly type: string | undefined; readonly body: string }[] = [];
  const http: Http = async (req) => {
    seen.push({ type: req.headers?.["Content-Type"], body: String(req.body) });
    return ok({});
  };
  const params = { text: "한 글 &+=?%", files: [{ id: "F1", title: "보고" }], empty: null };
  await new Slack(http, fakeClock(0), { token: "fake" }).call(method, params);
  expect(seen).toEqual([{ type: "application/json; charset=utf-8", body: JSON.stringify(params) }]);
});

// Explicit form and retry arguments are a fork contract, absent from upstream's simpler call signature.
test("explicit form compatibility retains a caller supplied one attempt retry policy", async () => {
  const seen: string[] = [];
  const waited: number[] = [];
  const http: Http = async (req) => {
    seen.push(String(req.headers?.["Content-Type"]));
    expect(Object.fromEntries(new URLSearchParams(String(req.body)))).toEqual({ text: "한 &+" });
    return { status: 500, headers: {}, body: "{}" };
  };
  const slack = new Slack(http, { ...fakeClock(0), sleep: async (ms) => { waited.push(ms); } }, { token: "fake" });
  const error: unknown = await slack.call("legacy.form", { text: "한 &+", nil: null }, { attempts: 1, baseMs: 0, maxMs: 0 }, true).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MessengerError);
  expect(seen).toEqual(["application/x-www-form-urlencoded; charset=utf-8"]);
  expect(waited).toEqual([]);
});
