import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Scorecard } from "./config.ts";
import { claimEvents } from "./lane-signals.ts";
import type { Lane } from "./registry.ts";

// The daily scorecard: what the day's tokens bought, read from records only (no model call).

export type DayWindow = { readonly date: string; readonly timeZone: string; readonly start: number; readonly end: number };

const offsetMs = (timeZone: string, at: number): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(at / 1000) * 1000;
};

const localMidnight = (y: number, m: number, d: number, timeZone: string): number => {
  const guess = Date.UTC(y, m - 1, d);
  return guess - offsetMs(timeZone, guess - offsetMs(timeZone, guess));
};

const localDate = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

export class ScorecardError extends Error {}

// date is YYYY-MM-DD, "today" or "yesterday", as a calendar day in timeZone
export const dayWindow = (date: string, timeZone: string, now: number): DayWindow => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ScorecardError(`unknown time zone ${timeZone}`);
  }
  const day = date === "today" ? localDate(now, timeZone) : date === "yesterday" ? localDate(now - 86_400_000, timeZone) : date;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new ScorecardError(`--date takes YYYY-MM-DD, today or yesterday, not ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return { date: day, timeZone, start: localMidnight(y, mo, d, timeZone), end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone) };
};

type Usage = { readonly input?: number; readonly cacheRead?: number; readonly cacheWrite?: number; readonly cost?: { readonly total?: number; readonly cacheRead?: number } };
type Entry = {
  readonly type?: string;
  readonly timestamp?: string;
  readonly content?: unknown;
  readonly message?: { readonly role?: string; readonly usage?: Usage; readonly content?: readonly { readonly type?: string; readonly text?: string; readonly arguments?: unknown }[] };
};

const parseLines = (text: string, keep: (line: string) => boolean): Entry[] =>
  text.split("\n").flatMap((l) => {
    if (!l || !keep(l)) return [];
    try {
      return [JSON.parse(l) as Entry];
    } catch {
      return [];
    }
  });

// jsonl files in dir (one level of subfolders for a sessions root) changed since start
const recentFiles = (dir: string, since: number, nested: boolean): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return [];
    if (st.isDirectory()) return nested ? recentFiles(p, since, false) : [];
    return n.endsWith(".jsonl") && st.mtimeMs >= since ? [p] : [];
  });
};

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso.replace(/(\.\d{3})\d+/, "$1")) : Number.NaN);

// nearest-rank quantile, the same rule the pilot measurement used
export const quantile = (values: readonly number[], p: number): number | null => {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))] ?? null;
};

export type ScorecardData = {
  readonly window: DayWindow;
  readonly calls: number;
  readonly cost: number;
  readonly verified: number;
  readonly claims: number;
  readonly rejected: number;
  readonly rework: readonly { readonly key: string; readonly sends: number; readonly nudges: number }[];
  readonly reply: { readonly n: number; readonly median: number | null; readonly p90: number | null } | null;
  readonly lead: { readonly cost: number; readonly cacheReadCost: number; readonly contextMedian: number | null } | null;
};

export type ScorecardSources = {
  readonly sessionsDir: string;
  readonly lanes: readonly Lane[];
  readonly settings: Scorecard;
  readonly inbox: string;
  readonly owner: string;
};

const readText = async (path: string): Promise<string | null> => {
  if (!path) return null;
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : null;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const computeScorecard = async (src: ScorecardSources, window: DayWindow): Promise<ScorecardData> => {
  const inDay = (t: number) => t >= window.start && t < window.end;
  const isAssistant = (e: Entry) => e.type === "message" && e.message?.role === "assistant" && inDay(ms(e.timestamp));

  let calls = 0;
  let cost = 0;
  for (const f of recentFiles(src.sessionsDir, window.start, true)) {
    for (const e of parseLines(await Bun.file(f).text(), (l) => l.includes('"usage"'))) {
      if (!isAssistant(e) || !e.message?.usage) continue;
      calls++;
      cost += e.message.usage.cost?.total ?? 0;
    }
  }

  let verified = 0;
  let claims = 0;
  let rejected = 0;
  for (const lane of src.lanes) {
    if (lane.closedAt && inDay(ms(lane.closedAt))) verified++;
    for (const e of claimEvents(lane)) {
      if (!inDay(ms(e.at))) continue;
      if (e.kind === "claim") claims++;
      else rejected++;
    }
  }

  const nudges = new Map<string, number>();
  for (const line of ((await readText(src.settings.lanesLog)) ?? "").split("\n")) {
    const m = /^(\S+) freshness NUDGED (\S+) /.exec(line);
    if (m?.[1] && m[2] && inDay(ms(m[1]))) nudges.set(m[2], (nudges.get(m[2]) ?? 0) + 1);
  }

  const leadFiles = src.settings.leadSessions ? recentFiles(src.settings.leadSessions, window.start, false) : [];
  const lead: Entry[] = [];
  for (const f of leadFiles) lead.push(...parseLines(await Bun.file(f).text(), (l) => !/"timestamp":"(\d{4}-\d\d-\d\d)/.test(l) || ms(/"timestamp":"([^"]+)"/.exec(l)?.[1]) >= window.start - 3_600_000));
  lead.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));

  const sendPatterns = src.lanes.flatMap((l) => (l.pane ? [{ key: l.key, re: new RegExp(src.settings.leadSendPattern.replaceAll("{pane}", escape(l.pane)), "g") }] : []));
  const sends = new Map<string, number>();
  let leadCost = 0;
  let cacheReadCost = 0;
  const context: number[] = [];
  for (const e of lead) {
    if (!isAssistant(e)) continue;
    const u = e.message?.usage;
    if (u) {
      leadCost += u.cost?.total ?? 0;
      cacheReadCost += u.cost?.cacheRead ?? 0;
      context.push((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    }
    for (const c of e.message?.content ?? []) {
      if (c.type !== "toolCall") continue;
      const args = JSON.stringify(c.arguments ?? "");
      for (const p of sendPatterns) {
        const n = args.match(p.re)?.length ?? 0;
        if (n) sends.set(p.key, (sends.get(p.key) ?? 0) + n);
      }
    }
  }

  const rework = [...new Set([...sends.keys(), ...nudges.keys()])]
    .map((key) => ({ key, sends: sends.get(key) ?? 0, nudges: nudges.get(key) ?? 0 }))
    .sort((a, b) => b.sends + b.nudges - (a.sends + a.nudges) || a.key.localeCompare(b.key))
    .slice(0, 3);

  let reply: ScorecardData["reply"] = null;
  const inboxText = await readText(src.inbox);
  if (leadFiles.length && inboxText !== null && src.owner) {
    const owned = parseLines(inboxText, (l) => l.includes(src.owner)) as unknown as { id?: string; ts?: string; author_id?: string }[];
    const asked = new Map(owned.filter((m) => m.author_id === src.owner && m.id && inDay(ms(m.ts))).map((m) => [m.id ?? "", ms(m.ts)]));
    const replied = new RegExp(src.settings.replyPattern, "m");
    const waits: number[] = [];
    for (let i = 0; i < lead.length; i++) {
      const e = lead[i];
      if (e?.type !== "custom_message" || typeof e.content !== "string") continue;
      const id = [...asked.keys()].find((k) => (e.content as string).includes(k));
      if (!id) continue;
      const sentAt = asked.get(id) ?? 0;
      asked.delete(id);
      for (let j = i + 1; j < Math.min(lead.length, i + 400); j++) {
        const r = lead[j];
        if (r?.type !== "message" || r.message?.role !== "toolResult") continue;
        if (replied.test((r.message.content ?? []).map((c) => c.text ?? "").join("\n"))) {
          waits.push((ms(r.timestamp) - sentAt) / 1000);
          break;
        }
      }
    }
    reply = { n: waits.length, median: quantile(waits, 0.5), p90: quantile(waits, 0.9) };
  }

  return {
    window,
    calls,
    cost,
    verified,
    claims,
    rejected,
    rework,
    reply,
    lead: leadFiles.length ? { cost: leadCost, cacheReadCost, contextMedian: quantile(context, 0.5) } : null,
  };
};

// Keeps the card as a record the lead and lanes read (dori signals, the lead's notes) instead of a post to the owner:
// <dir>/<date>.json with the numbers and latest.md with the card. Files of days older than keepDays are removed.
export const saveScorecard = async (dir: string, d: ScorecardData, text: string, keepDays: number): Promise<string> => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${d.window.date}.json`);
  await Bun.write(file, JSON.stringify({ ...d, text }, null, 1));
  await Bun.write(join(dir, "latest.md"), `${text}\n`);
  const oldest = new Date(Date.parse(`${d.window.date}T00:00:00Z`) - keepDays * 86_400_000).toISOString().slice(0, 10);
  for (const n of readdirSync(dir)) {
    const day = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1];
    if (day && day < oldest) rmSync(join(dir, n));
  }
  return file;
};

const usd = (x: number) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const sec = (x: number | null) => (x === null ? "-" : x.toFixed(1));

// Four lines and one more. Cost per verified completion and the claim rejection rate always come together: either alone
// can be gamed (stop early to save tokens, or use weaker checks to pass).
export const formatScorecard = (d: ScorecardData, language: "en" | "ko", now = Number.POSITIVE_INFINITY): string => {
  const ko = language === "ko";
  const w = d.window;
  const lines: string[] = [];
  // the head says which hours were counted: the whole local day, or up to now for a day still running
  const until = now < w.end ? new Intl.DateTimeFormat("en-GB", { timeZone: w.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now)) : "24:00";
  const range = `${w.date} 00:00~${until} (${w.timeZone})`;
  lines.push(ko ? `토큰 성적표 ${range}` : `Token scorecard ${range}`);
  const per = d.verified ? usd(d.cost / d.verified) : ko ? "없음" : "n/a";
  lines.push(ko ? `① 검증 완료당 비용 ${per} (전체 ${usd(d.cost)}, 호출 ${d.calls}회 ÷ 검증 완료 ${d.verified}개)` : `① Cost per verified completion ${per} (total ${usd(d.cost)} over ${d.calls} calls ÷ ${d.verified} verified)`);
  lines.push(ko ? `② 완료 주장 거부율 ${pct(d.rejected, d.claims)}% (거부 ${d.rejected} / 주장 ${d.claims})` : `② Done-claim rejection rate ${pct(d.rejected, d.claims)}% (${d.rejected} rejected / ${d.claims} claims)`);
  const rw = d.rework.map((r) => (ko ? `${r.key} ${r.sends + r.nudges} (재지시 ${r.sends}·독촉 ${r.nudges})` : `${r.key} ${r.sends + r.nudges} (${r.sends} re-sends, ${r.nudges} nudges)`));
  lines.push(ko ? `③ 재작업 상위 lane: ${rw.join(", ") || "없음"}` : `③ Most rework: ${rw.join(", ") || "none"}`);
  lines.push(
    d.reply
      ? ko
        ? `④ 첫 답글 중앙값 ${sec(d.reply.median)}초 · p90 ${sec(d.reply.p90)}초 (소유자 메시지 ${d.reply.n}건)`
        : `④ First reply median ${sec(d.reply.median)} s, p90 ${sec(d.reply.p90)} s (${d.reply.n} owner messages)`
      : ko
        ? "④ 첫 답글: 설정 없음 (scorecard.leadSessions, inbox, DORI_DISCORD_OWNER)"
        : "④ First reply: not configured (scorecard.leadSessions, inbox, DORI_DISCORD_OWNER)",
  );
  const ctx = d.lead?.contextMedian ?? null;
  const ctxText = ctx === null ? "-" : ko ? `${(ctx / 10_000).toFixed(1)}만` : `${Math.round(ctx / 1000)}k`;
  lines.push(
    d.lead
      ? ko
        ? `+ 리드 컨텍스트 세금: 리드 ${usd(d.lead.cost)} 중 캐시 읽기 ${usd(d.lead.cacheReadCost)} (${pct(d.lead.cacheReadCost, d.lead.cost)}%), 컨텍스트 중앙값 ${ctxText} 토큰`
        : `+ Lead context tax: cache reads ${usd(d.lead.cacheReadCost)} of the lead's ${usd(d.lead.cost)} (${pct(d.lead.cacheReadCost, d.lead.cost)}%), median context ${ctxText} tokens`
      : ko
        ? "+ 리드 컨텍스트 세금: 설정 없음 (scorecard.leadSessions)"
        : "+ Lead context tax: not configured (scorecard.leadSessions)",
  );
  return lines.join("\n");
};
