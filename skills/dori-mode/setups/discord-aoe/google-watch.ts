#!/usr/bin/env bun
// Read-only zele polling. --once performs one tick and exits; first tick primes mail without notifying.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envFilePath, loadEnvFile } from "../../scripts/src/config.ts";
import { run, type Runner } from "../../scripts/src/run.ts";

type Doc = Record<string, unknown>;
type Item = Doc & { readonly id: string };
export type GoogleState = { mail: string[]; cal: string[]; primed: boolean };
export type GoogleOptions = {
  readonly account: string;
  readonly out: string;
  readonly state: string;
  readonly intervalMs: number;
  readonly windowMin: number;
  readonly timeZone: string;
};
const doc = (value: unknown): Doc => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("zele returned no document");
  return Object.fromEntries(Object.entries(value));
};
const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Google interval/window must be positive");
  return n;
};
export const googleOptions = (env: Record<string, string | undefined>): GoogleOptions => {
  const out = env.DORI_GOOGLE_EVENTS || join(env.DORI_STATE_DIR || join(homedir(), ".dori", "state"), "google-events.jsonl");
  return {
    account: env.DORI_GOOGLE_ACCOUNT || "",
    out,
    state: env.DORI_GOOGLE_STATE || join(dirname(out), "google-watch.state.json"),
    intervalMs: positive(env.DORI_GOOGLE_INTERVAL_MS, 120_000),
    windowMin: positive(env.DORI_GOOGLE_WINDOW_MIN, 35),
    timeZone: env.DORI_GOOGLE_TIME_ZONE || "UTC",
  };
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS: Record<string, string> = { Sun: "SU", Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA" };
export const parseStart = (s: string, ref: Date): Date | null => {
  const m = /^(\w{3}) (\d{1,2}), (\d{1,2}):(\d{2}) (AM|PM)$/.exec(s);
  if (!m) return null;
  const month = MONTHS.findIndex((v) => v === m[1]);
  if (month < 0) return null;
  const hour = Number(m[3]) % 12 + (m[5] === "PM" ? 12 : 0);
  // zele omits the year; use the nearest occurrence around the reference, including New Year.
  const dates = [-1, 0, 1].map((offset) => new Date(Date.UTC(ref.getUTCFullYear() + offset, month, Number(m[2]), hour, Number(m[4]))));
  return dates.sort((a, b) => Math.abs(a.getTime() - ref.getTime()) - Math.abs(b.getTime() - ref.getTime()))[0] ?? null;
};
const localDay = (at: Date, timeZone: string): { day: string; ymd: string } => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
  return { day: WEEKDAYS[part("weekday")] ?? "", ymd: `${part("year")}${part("month")}${part("day")}` };
};
export const recurringStart = (e: Item, details: Doc, first: Date, now: Date, until: Date, timeZone: string): Date | null => {
  if (String(details.start ?? "") !== String(e.start ?? "")) return null;
  const rules = Array.isArray(details.recurrence) ? details.recurrence.map(String) : [];
  const rule = rules.find((r) => r.startsWith("RRULE:"));
  if (!rule) return null;
  const p = Object.fromEntries(rule.slice(6).split(";").map((kv) => kv.split("=")));
  if ((p.INTERVAL ?? "1") !== "1" || p.COUNT) return null;
  // Cover a window crossing midnight as well as the current UTC day.
  for (const day of [now, until]) {
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), first.getUTCHours(), first.getUTCMinutes()));
    if (at < now || at > until || at < first) continue;
    if (p.UNTIL && at.toISOString().replace(/[-:]/g, "").slice(0, 8) > String(p.UNTIL).slice(0, 8)) continue;
    const local = localDay(at, timeZone);
    if (rules.some((r) => r.startsWith("EXDATE") && r.includes(local.ymd))) continue;
    if (p.FREQ === "DAILY" || (p.FREQ === "WEEKLY" && String(p.BYDAY ?? localDay(first, timeZone).day).split(",").includes(local.day))) return at;
  }
  return null;
};
const fmtUtc = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;

export async function googleTick(options: GoogleOptions, state: GoogleState, runner: Runner, now: Date, emit: (row: Doc) => void): Promise<void> {
  const zele = async (args: string[]): Promise<Doc> => {
    const r = await runner(["zele", ...args, ...(options.account ? ["--account", options.account] : [])]);
    if (r.code !== 0) throw new Error(`zele ${args.slice(0, 2).join(" ")} failed: ${r.err.slice(0, 200)}`);
    return doc(Bun.YAML.parse(r.out));
  };
  const items = (d: Doc): Item[] => Array.isArray(d.items) ? d.items.flatMap((value: unknown) => {
    const item = doc(value);
    return typeof item.id === "string" ? [{ ...item, id: item.id }] : [];
  }) : [];
  for (const m of items(await zele(["mail", "list", "--filter", "is:unread", "--limit", "30"]))) {
    if (state.mail.includes(m.id)) continue;
    state.mail.push(m.id);
    if (state.primed) emit({ kind: "mail", id: m.id, from: m.from, subject: m.subject, snippet: String(m.snippet ?? "").slice(0, 200) });
  }
  state.mail = state.mail.slice(-500);
  const until = new Date(now.getTime() + options.windowMin * 60_000);
  for (const e of items(await zele(["cal", "events", "--all", "--from", now.toISOString(), "--to", `+${options.windowMin}m`, "--limit", "20"]))) {
    const first = parseStart(String(e.start ?? ""), now);
    if (!first) continue;
    const direct = first >= now && first <= until;
    const at = direct ? first : recurringStart(e, await zele(["cal", "get", e.id, ...(e.calendar ? ["--calendar", String(e.calendar)] : [])]), first, now, until, options.timeZone);
    if (!at) continue;
    const key = `${e.id}|${at.toISOString()}`;
    if (state.cal.includes(key)) continue;
    state.cal.push(key);
    emit({ kind: "calendar-soon", id: e.id, summary: e.summary, start: fmtUtc(at), start_iso: at.toISOString(), end: e.end, recurring: !direct });
  }
  state.cal = state.cal.slice(-500);
  state.primed = true;
}

if (import.meta.main) {
  await loadEnvFile(envFilePath());
  const options = googleOptions(process.env);
  const raw = existsSync(options.state) ? doc(JSON.parse(readFileSync(options.state, "utf8"))) : {};
  const state: GoogleState = {
    mail: Array.isArray(raw.mail) ? raw.mail.map(String) : [],
    cal: Array.isArray(raw.cal) ? raw.cal.map(String) : [],
    primed: raw.primed === true,
  };
  for (const file of [options.out, options.state]) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tick = async () => {
    await googleTick(options, state, run, new Date(), (row) => {
      appendFileSync(options.out, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
      chmodSync(options.out, 0o600);
    });
    writeFileSync(options.state, JSON.stringify(state), { mode: 0o600 });
    chmodSync(options.state, 0o600);
  };
  if (process.argv.includes("--once")) {
    await tick();
    console.log("GOOGLE_WATCH_ONCE");
  } else {
    console.log("GOOGLE_WATCH_READY");
    for (;;) {
      await tick().catch((e: unknown) => console.error(`GOOGLE_WATCH_FAIL ${e instanceof Error ? e.message : String(e)}`));
      await Bun.sleep(options.intervalMs);
    }
  }
}
