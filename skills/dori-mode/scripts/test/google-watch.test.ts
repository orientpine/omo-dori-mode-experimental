import { expect, test } from "bun:test";
import { googleOptions, googleTick, parseStart, recurringStart, type GoogleState } from "../../setups/discord-aoe/google-watch.ts";
import type { Runner } from "../src/run.ts";

test("Google watcher environment overrides paths, account and polling window", () => {
  const options = googleOptions({ DORI_GOOGLE_ACCOUNT: "test@example.com", DORI_GOOGLE_EVENTS: "/scratch/events", DORI_GOOGLE_STATE: "/scratch/state", DORI_GOOGLE_INTERVAL_MS: "1234", DORI_GOOGLE_WINDOW_MIN: "17", DORI_GOOGLE_TIME_ZONE: "Asia/Seoul" });
  expect(options).toEqual({ account: "test@example.com", out: "/scratch/events", state: "/scratch/state", intervalMs: 1234, windowMin: 17, timeZone: "Asia/Seoul" });
});

test("Google watcher defaults preserve the two minute interval and 35 minute window", () => {
  const options = googleOptions({ DORI_STATE_DIR: "/scratch" });
  expect(options).toEqual({ account: "", out: "/scratch/google-events.jsonl", state: "/scratch/google-watch.state.json", intervalMs: 120000, windowMin: 35, timeZone: "UTC" });
});

test("Google watcher primes mail, emits new mail and calendar only once, and scopes every call", async () => {
  const calls: (readonly string[])[] = [];
  const rows: Record<string, unknown>[] = [];
  const state: GoogleState = { mail: [], cal: [], primed: false };
  let mail = [{ id: "old", subject: "existing" }];
  const runner: Runner = async (args) => {
    calls.push(args);
    return { code: 0, err: "", out: JSON.stringify({ items: args[1] === "mail" ? mail : [{ id: "event", summary: "meeting", start: "Oct 12, 1:10 AM" }] }) };
  };
  const options = googleOptions({ DORI_GOOGLE_ACCOUNT: "test@example.com", DORI_GOOGLE_WINDOW_MIN: "17" });
  const now = new Date("2026-10-12T01:00:00Z");
  await googleTick(options, state, runner, now, (r) => rows.push(r));
  mail = [...mail, { id: "new", subject: "new message" }];
  await googleTick(options, state, runner, now, (r) => rows.push(r));
  await googleTick(options, state, runner, now, (r) => rows.push(r));
  expect({
    rows: rows.map((r) => [r.kind, r.id, r.start_iso ?? r.subject]),
    state,
    accounts: calls.map((c) => c.slice(-2)),
    windows: calls.filter((c) => c[1] === "cal").map((c) => c[c.indexOf("--to") + 1]),
  }).toEqual({
    rows: [["calendar-soon", "event", "2026-10-12T01:10:00.000Z"], ["mail", "new", "new message"]],
    state: { mail: ["old", "new"], cal: ["event|2026-10-12T01:10:00.000Z"], primed: true },
    accounts: Array.from({ length: 6 }, () => ["--account", "test@example.com"]),
    windows: ["+17m", "+17m", "+17m"],
  });
});

test("recurring calendar events use the configured zone and exclude exception dates", () => {
  const first = new Date("2026-10-01T23:10:00Z");
  const now = new Date("2026-10-11T23:00:00Z");
  const until = new Date("2026-10-11T23:35:00Z");
  const event = { id: "e", start: "Oct 1, 11:10 PM" };
  const details = { start: event.start, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] };
  expect([
    recurringStart(event, details, first, now, until, "Asia/Seoul")?.toISOString(),
    recurringStart(event, details, first, now, until, "UTC"),
    recurringStart(event, { ...details, recurrence: [...details.recurrence, "EXDATE;VALUE=DATE:20261012"] }, first, now, until, "Asia/Seoul"),
    recurringStart(event, { ...details, recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] }, first, now, until, "UTC"),
  ]).toEqual(["2026-10-11T23:10:00.000Z", null, null, null]);
});

test("zele yearless calendar times resolve across New Year", () => {
  expect(parseStart("Jan 1, 12:10 AM", new Date("2026-12-31T23:50:00Z"))?.toISOString()).toBe("2027-01-01T00:10:00.000Z");
});

test("zele failure fails the tick instead of priming an empty account", async () => {
  await expect(googleTick(googleOptions({}), { mail: [], cal: [], primed: false }, async () => ({ code: 1, out: "", err: "offline" }), new Date("2026-10-12T01:00:00Z"), () => {})).rejects.toThrow("offline");
});
