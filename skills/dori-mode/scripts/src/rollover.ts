// Rollover = moving a lane to a new session (dori handover --lane). This module decides when to propose one, logs every
// proposal and rollover to <stateDir>/rollover-log.jsonl, and summarizes the log (dori rollover-stats) so the owner can
// set the automation parameters from what happened. A proposal never switches anything; handover.autoRollover (off by
// default) is the only path that runs one without a person's approval.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Question } from "./messenger/discord-cards.ts";
import type { Lane } from "./registry.ts";
import { fixCount } from "./same-fix.ts";

// repeats: the most attempts of one fix (same metric and hypothesis, counted as dori fix-attempt counts them) in the
// lane's current session
export type Signals = { readonly contextPct?: number; readonly compactions?: number; readonly ageH?: number; readonly repeats?: number };

export type Step = { readonly step: string; readonly ms: number; readonly ok: boolean };

export type Who = "lead" | "lane";

export type RolloverEntry =
  | { readonly kind: "proposal"; readonly who: Who; readonly at: string; readonly key: string; readonly card?: string; readonly pane: string; readonly signals: Signals; readonly crossed: readonly string[]; readonly note?: string; readonly blockers: string }
  | {
      readonly kind: "rollover";
      readonly who: Who;
      readonly at: string;
      readonly key: string;
      readonly from: string;
      readonly to?: string;
      readonly approvedBy?: string;
      readonly proposedAt?: string;
      readonly approvalMin?: number;
      readonly signals: Signals;
      readonly steps: readonly Step[];
      readonly result: string;
      readonly reasons: readonly string[];
      // the subscription accounts of the old and new session ("" when the status line did not show one)
      readonly accounts?: { readonly from: string; readonly to: string };
    };

export type Limits = { readonly contextPct: number; readonly compactions: number; readonly ageH: number; readonly repeats?: number };

// Which thresholds the signals cross; a threshold of 0 is off.
export const crossed = (s: Signals, h: Limits): string[] => [
  ...(h.contextPct > 0 && s.contextPct !== undefined && s.contextPct >= h.contextPct ? [`context ${s.contextPct}% >= ${h.contextPct}%`] : []),
  ...(h.compactions > 0 && s.compactions !== undefined && s.compactions >= h.compactions ? [`compactions ${s.compactions} >= ${h.compactions}`] : []),
  ...(h.ageH > 0 && s.ageH !== undefined && s.ageH >= h.ageH ? [`age ${s.ageH.toFixed(1)} h >= ${h.ageH} h`] : []),
  ...((h.repeats ?? 0) > 0 && s.repeats !== undefined && s.repeats >= (h.repeats ?? 0) ? [`same fix ${s.repeats} times >= ${h.repeats}`] : []),
];

// The lane's current session began when it moved to its pane (a handover) or, before any move, when it opened.
export const repeatsOf = (lane: Lane): number => {
  const since = lane.history?.findLast((h) => h.note.startsWith("pane moved") && h.note.includes(`-> ${lane.pane} `))?.at ?? lane.openedAt ?? "";
  const fixes = (lane.fixes ?? []).filter((f) => f.at >= since);
  return Math.max(0, ...fixes.map((f) => fixCount(fixes, f.metric, f.hypothesis)));
};

export const AUTO_PREFIX = "auto:";

// What makes a rollover approved: a question card (Qn) the owner answered with its first option, a link to or the words
// of their message, or "auto:..." when the automation key for that side is on. Undefined when the reference holds.
export const approvalProblem = (ref: string | undefined, card: (id: string) => Question | undefined, autoOn: boolean): string | undefined => {
  const r = ref?.trim() ?? "";
  if (!r) return "no approval: pass --approved-by <the owner's answered card Qn, or their message link or words>";
  if (r.startsWith(AUTO_PREFIX)) return autoOn ? undefined : `${r} is an automatic approval, but the automation key is off (the owner turns it on)`;
  if (/^Q\d+$/i.test(r)) {
    const q = card(r.toUpperCase());
    if (!q) return `card ${r} not found`;
    if (q.status !== "answered") return `card ${q.id} is not answered yet`;
    if (q.answer !== q.options[0]) return `card ${q.id} was answered ${JSON.stringify(q.answer ?? "")}, not ${JSON.stringify(q.options[0] ?? "")}`;
    return undefined;
  }
  return r.length >= 3 ? undefined : `approval reference ${JSON.stringify(r)} is too short to point at anything`;
};

// While a session is being replaced it must not talk to the owner: the new one may already answer. dori send, ask and
// thread refuse from a pane with a live quiet mark; the mark expires on its own, so a crashed handover cannot gag a pane.
export const quietFile = (stateDir: string, pane: string): string => join(stateDir, "handover", "quiet", `${pane.replace(/[^\w.-]/g, "_")}.json`);

export const setQuiet = (stateDir: string, pane: string, until: number, why: string): void => {
  mkdirSync(join(stateDir, "handover", "quiet"), { recursive: true });
  writeFileSync(quietFile(stateDir, pane), JSON.stringify({ pane, until: new Date(until).toISOString(), why }));
};

export const clearQuiet = (stateDir: string, pane: string): void => rmSync(quietFile(stateDir, pane), { force: true });

export const quietReason = (stateDir: string, pane: string, now: number): string | undefined => {
  if (!pane) return undefined;
  try {
    const q = JSON.parse(readFileSync(quietFile(stateDir, pane), "utf8")) as { until?: string; why?: string };
    return q.until && Date.parse(q.until) > now ? `HANDOVER_QUIET ${pane}: ${q.why ?? "a handover is moving this session"} (until ${q.until}); the new session talks to the owner now` : undefined;
  } catch {
    return undefined;
  }
};

const COMPACTION = '"type":"compaction"';
// Session logs grow to tens of MB; a long-running sweep keeps where it stopped per file and reads only what was added.
const scanned = new Map<string, { offset: number; count: number }>();

export const compactionsIn = (file: string): number => {
  const size = statSync(file).size;
  let { offset, count } = scanned.get(file) ?? { offset: 0, count: 0 };
  if (size < offset) ({ offset, count } = { offset: 0, count: 0 });
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    let rest = "";
    for (let read = 0; offset + read < size; ) {
      const n = readSync(fd, buf, 0, buf.length, offset + read);
      if (n <= 0) break;
      read += n;
      const text = rest + buf.toString("utf8", 0, n);
      const cut = text.lastIndexOf("\n");
      const whole = cut >= 0 ? text.slice(0, cut + 1) : "";
      rest = cut >= 0 ? text.slice(cut + 1) : text;
      for (const line of whole.split("\n")) if (line.startsWith('{"type":"compaction"') || (line.includes(COMPACTION) && line.indexOf(COMPACTION) < 12)) count++;
    }
    offset = size - Buffer.byteLength(rest);
  } finally {
    closeSync(fd);
  }
  scanned.set(file, { offset, count });
  return count;
};

const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;

// Compactions so far and hours since the session's log began, for the omo session id in a session directory.
export const sessionSignals = (sessionDir: string, session: string, now: number): Pick<Signals, "compactions" | "ageH"> => {
  if (!session) return {};
  let name: string | undefined;
  try {
    name = readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`));
  } catch {
    return {};
  }
  const m = name ? SESSION_FILE.exec(name) : null;
  if (!name || !m) return {};
  const started = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  return { compactions: compactionsIn(join(sessionDir, name)), ageH: Math.round(((now - started) / 3_600_000) * 10) / 10 };
};

export const rolloverLog = (stateDir: string): string => join(stateDir, "rollover-log.jsonl");

export const appendRollover = (stateDir: string, entry: RolloverEntry): void => {
  const file = rolloverLog(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

export const readRollovers = (stateDir: string): RolloverEntry[] => {
  const file = rolloverLog(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as RolloverEntry] : [];
    } catch {
      return [];
    }
  });
};

export const lastProposal = (entries: readonly RolloverEntry[], key: string): Extract<RolloverEntry, { kind: "proposal" }> | undefined =>
  entries.findLast((e): e is Extract<RolloverEntry, { kind: "proposal" }> => e.kind === "proposal" && e.key === key);

// Watch-log kinds that show a lane going wrong: silence (NUDGED, NO-REPORT), repeated fixes, drift, lost input.
export const QUALITY_KINDS = ["NUDGED", "NO-REPORT", "SAME_FIX_3", "STUCK", "INTENT_DRIFT", "NOT_SUBMITTED", "LANE_BLOCKED"] as const;

type Counts = Record<string, number>;

const countsIn = (lines: readonly string[], key: string, from: number, to: number): Counts => {
  const out: Counts = {};
  for (const line of lines) {
    const m = /^(\S+)\s+\S+\s+(\S+)\s+(\S+)/.exec(line);
    if (!m?.[1] || m[3] !== key) continue;
    const at = Date.parse(m[1]);
    const kind = QUALITY_KINDS.find((k) => k === m[2]);
    if (kind && at >= from && at < to) out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
};

const fmtCounts = (c: Counts): string => Object.entries(c).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
const median = (xs: readonly number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};
const fmtSignals = (s: Signals): string => [s.contextPct !== undefined ? `context ${s.contextPct}%` : "", s.compactions !== undefined ? `compactions ${s.compactions}` : "", s.ageH !== undefined ? `age ${s.ageH} h` : ""].filter(Boolean).join(", ") || "no signals";

// The summary the owner sets automation parameters from: how often a proposal came and at which signal values, how long
// approval took, how each rollover went step by step, and the lane's quality signals in windowH hours before and after.
export const rolloverStats = (entries: readonly RolloverEntry[], watchLines: readonly string[], now: number, windowH = 24): string[] => {
  const proposals = entries.filter((e) => e.kind === "proposal");
  const rolls = entries.filter((e): e is Extract<RolloverEntry, { kind: "rollover" }> => e.kind === "rollover");
  const byResult: Counts = {};
  for (const r of rolls) byResult[r.result] = (byResult[r.result] ?? 0) + 1;
  const approval = median(rolls.flatMap((r) => (r.approvalMin !== undefined ? [r.approvalMin] : [])));
  const out = [`ROLLOVER_STATS proposals=${proposals.length} rollovers=${rolls.length} (${fmtCounts(byResult)}) approval_median_min=${approval ?? "-"} window=${windowH}h`];
  const stepNames = [...new Set(rolls.flatMap((r) => r.steps.map((s) => s.step)))];
  if (stepNames.length) out.push(`ROLLOVER_STEPS ${stepNames.map((n) => `${n} median ${Math.round((median(rolls.flatMap((r) => r.steps.filter((s) => s.step === n).map((s) => s.ms))) ?? 0) / 1000)}s fail ${rolls.filter((r) => r.steps.some((s) => s.step === n && !s.ok)).length}`).join("; ")}`);
  for (const p of proposals) out.push(`PROPOSAL ${p.who} ${p.key}${p.card ? ` card ${p.card}` : ""} ${p.at} ${fmtSignals(p.signals)} crossed: ${p.crossed.join(", ") || "-"}${p.blockers ? `; blockers: ${p.blockers}` : ""}`);
  for (const r of rolls) {
    const at = Date.parse(r.at);
    const span = windowH * 3_600_000;
    const afterH = Math.round((Math.min(now, at + span) - at) / 360_000) / 10;
    out.push(`ROLLOVER ${r.who} ${r.key} ${r.at} ${r.result} ${r.from} -> ${r.to ?? "-"} ${fmtSignals(r.signals)}; approval ${r.approvalMin ?? "-"} min (by ${r.approvedBy ?? "-"}); steps ${r.steps.map((s) => `${s.step} ${Math.round(s.ms / 1000)}s${s.ok ? "" : " FAIL"}`).join(", ") || "-"}${r.reasons.length ? `; reasons: ${r.reasons.join("; ")}` : ""}${r.accounts && r.accounts.from !== r.accounts.to ? `; account ${r.accounts.from || "?"} -> ${r.accounts.to || "?"}` : ""}`);
    out.push(`QUALITY ${r.key} ${r.at} before ${windowH}h: ${fmtCounts(countsIn(watchLines, r.key, at - span, at))} | after ${afterH}h: ${fmtCounts(countsIn(watchLines, r.key, at, at + span))}`);
  }
  return out;
};
