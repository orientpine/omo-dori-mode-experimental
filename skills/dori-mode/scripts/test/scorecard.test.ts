import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { computeScorecard, dayWindow, formatScorecard, quantile } from "../src/scorecard.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const OWNER = "100000000000000009";
const usage = (cost: number, cacheRead = 0, context = 0) => ({ input: 1, output: 10, cacheRead: context, cacheWrite: 0, cost: { total: cost, cacheRead } });
const assistant = (ts: string, cost: number, extra: Record<string, unknown> = {}, content: unknown[] = []) =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", usage: usage(cost, Number(extra.cacheRead ?? 0), Number(extra.context ?? 0)), content } });
const send = (pane: string) => ({ type: "toolCall", arguments: { code: `await run(["tmux","send-keys","-t","=${pane}:","-l","--","[LEAD] try again"])` } });
const event = (ts: string, id: string) => JSON.stringify({ type: "custom_message", timestamp: ts, content: `inbox row id=${id}` });
const posted = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "toolResult", content: [{ type: "text", text }] } });

const lane = (key: string, history: Lane["history"], closedAt?: string): Lane => ({ key, title: key, thread: "none", pane: `aoe_${key}_0a1b2c3d`, brief: "/b.md", done: "merged a/b#1", openedAt: "2026-03-01T00:00:00Z", history, ...(closedAt ? { closedAt } : {}) });

const setup = () => {
  const sessions = join(state.dir, "sessions");
  const leadDir = join(sessions, "lead");
  mkdirSync(join(sessions, "work"), { recursive: true });
  mkdirSync(leadDir, { recursive: true });
  writeFileSync(join(sessions, "work", "a.jsonl"), [assistant("2026-03-01T10:00:00Z", 2), assistant("2026-03-01T23:59:59Z", 3), assistant("2026-03-02T00:00:00Z", 100), "not json"].join("\n"));
  writeFileSync(
    join(leadDir, "l.jsonl"),
    [
      event("2026-03-01T09:00:04Z", "900001"),
      assistant("2026-03-01T09:00:10Z", 1, { cacheRead: 0.75, context: 500_000 }, [send("aoe_busy_0a1b2c3d")]),
      posted("2026-03-01T09:00:20Z", "post ok 1"),
      event("2026-03-01T09:10:02Z", "900002"),
      assistant("2026-03-01T09:10:30Z", 3, { cacheRead: 2.25, context: 300_000 }, [send("aoe_busy_0a1b2c3d"), send("aoe_other_0a1b2c3d")]),
      posted("2026-03-01T09:11:00Z", "something else"),
      posted("2026-03-01T09:12:00Z", "post ok 2"),
    ].join("\n"),
  );
  const log = join(state.dir, "lanes.log");
  writeFileSync(log, ["2026-03-01T01:00:00Z freshness NUDGED busy 16 min silent", "2026-03-01T02:00:00Z freshness NUDGED busy 16 min silent", "2026-03-01T03:00:00Z freshness NUDGED quiet 16 min silent", "2026-02-28T03:00:00Z freshness NUDGED quiet 16 min silent", "2026-03-01T03:00:00Z watch LANE_BLOCKED busy idle x"].join("\n"));
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [
    JSON.stringify({ ts: "2026-03-01T09:00:00.000000+00:00", id: "900001", author_id: OWNER, content: "hi" }),
    JSON.stringify({ ts: "2026-03-01T09:10:00Z", id: "900002", author_id: OWNER, content: "and?" }),
    JSON.stringify({ ts: "2026-03-01T09:20:00Z", id: "900003", author_id: "someone-else", content: "x" }),
  ].join("\n"));
  const lanes: Lane[] = [
    lane("busy", [
      { at: "2026-03-01T04:00:00Z", status: "done-claimed", note: "claim" },
      { at: "2026-03-01T04:05:00Z", status: "not-done", note: "signal failed" },
      { at: "2026-03-01T05:00:00Z", status: "not-done", note: "WAITING owner" },
      { at: "2026-03-01T06:00:00Z", status: "done-claimed", note: "claim again" },
      { at: "2026-03-01T06:01:00Z", status: "done-claimed", note: "same claim, repeated" },
      { at: "2026-03-01T06:06:00Z", status: "verified-done", note: "live" },
      { at: "2026-03-01T06:06:01Z", status: "closed", note: "Done" },
    ], "2026-03-01T06:06:01Z"),
    lane("other", [{ at: "2026-02-28T22:00:00Z", status: "done-claimed", note: "yesterday" }, { at: "2026-03-01T01:00:00Z", status: "closed", note: "lead" }], "2026-03-01T01:00:00Z"),
    lane("quiet", [{ at: "2026-03-01T07:00:00Z", status: "not-done", note: "PAUSED by owner" }]),
  ];
  const settings = { ...defaultConfig().scorecard, lanesLog: log, leadSessions: leadDir, replyPattern: "post ok" };
  return { sessionsDir: sessions, lanes, settings, inbox, owner: OWNER };
};

test("the scorecard counts the day's cost, verified closes, rejected claims, rework and reply times from the records", async () => {
  const d = await computeScorecard(setup(), dayWindow("2026-03-01", "UTC", 0));
  expect({ calls: d.calls, cost: d.cost }).toEqual({ calls: 4, cost: 9 });
  // a not-done that answers a claim is a rejection; parking a lane as not-done is not, and a repeated claim is one claim
  expect({ verified: d.verified, claims: d.claims, rejected: d.rejected }).toEqual({ verified: 2, claims: 2, rejected: 1 });
  expect(d.rework).toEqual([{ key: "busy", sends: 2, nudges: 2 }, { key: "other", sends: 1, nudges: 0 }, { key: "quiet", sends: 0, nudges: 1 }]);
  expect(d.reply).toEqual({ n: 2, median: 120, p90: 120 });
  expect(d.lead).toEqual({ cost: 4, cacheReadCost: 3, contextMedian: 500_001 });
});

test("the card is four lines and one more, with cost per verified completion next to the rejection rate", async () => {
  const d = await computeScorecard(setup(), dayWindow("2026-03-01", "UTC", 0));
  const ko = formatScorecard(d, "ko").split("\n");
  expect(ko).toHaveLength(6);
  expect(ko[0]).toBe("토큰 성적표 2026-03-01 00:00~24:00 (UTC)");
  expect(formatScorecard({ ...d, window: dayWindow("2026-03-01", "Asia/Seoul", 0) }, "ko", Date.parse("2026-03-01T05:30:00Z")).split("\n")[0]).toBe("토큰 성적표 2026-03-01 00:00~14:30 (Asia/Seoul)");
  expect(ko[1]).toBe("① 검증 완료당 비용 $4.50 (전체 $9.00, 호출 4회 ÷ 검증 완료 2개)");
  expect(ko[2]).toBe("② 완료 주장 거부율 50% (거부 1 / 주장 2)");
  expect(ko[4]).toBe("④ 첫 답글 중앙값 120.0초 · p90 120.0초 (소유자 메시지 2건)");
  expect(formatScorecard({ ...d, verified: 0, reply: null, lead: null }, "en").split("\n").slice(1)).toEqual([
    "① Cost per verified completion n/a (total $9.00 over 4 calls ÷ 0 verified)",
    "② Done-claim rejection rate 50% (1 rejected / 2 claims)",
    "③ Most rework: busy 4 (2 re-sends, 2 nudges), other 1 (1 re-sends, 0 nudges), quiet 1 (0 re-sends, 1 nudges)",
    "④ First reply: not configured (scorecard.leadSessions, inbox, DORI_DISCORD_OWNER)",
    "+ Lead context tax: not configured (scorecard.leadSessions)",
  ]);
});

test("a day is the calendar day in the configured time zone; yesterday and today follow the clock", () => {
  const seoul = dayWindow("2026-03-01", "Asia/Seoul", 0);
  expect([new Date(seoul.start).toISOString(), new Date(seoul.end).toISOString()]).toEqual(["2026-02-28T15:00:00.000Z", "2026-03-01T15:00:00.000Z"]);
  const now = Date.parse("2026-03-01T23:30:00Z");
  expect(dayWindow("yesterday", "Asia/Seoul", now).date).toBe("2026-03-01");
  expect(dayWindow("today", "UTC", now).date).toBe("2026-03-01");
  expect(() => dayWindow("March 1", "UTC", now)).toThrow("--date takes YYYY-MM-DD");
  expect(quantile([5, 1, 3], 0.5)).toBe(3);
});
