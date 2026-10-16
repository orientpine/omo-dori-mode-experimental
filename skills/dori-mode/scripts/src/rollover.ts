// Rollover = moving a lane to a new session (dori handover --lane). This module decides when to propose one, logs every
// proposal and rollover to <stateDir>/rollover-log.jsonl, and summarizes the log (dori rollover-stats) so the owner can
// set the automation parameters from what happened. A proposal never switches anything: the lead decides (--approved-by
// lead:<reason and signal>) and the owner is told afterwards; handover.autoRollover (off by default) is the only path that
// runs one without a person's decision.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Question } from "./messenger/discord-cards.ts";
import type { FixAttempt, Lane } from "./registry.ts";
import { type DoriConfig, fill } from "./config.ts";
import { parseWatchLine } from "./watch-log.ts";

// stuck: the highest rung of the stuck ladder the lane reached in its current session (rung 4 makes a rollover due);
// repeats: written by older versions (the most attempts of one same fix), still shown by rollover-stats
export type Signals = { readonly contextPct?: number; readonly compactions?: number; readonly ageH?: number; readonly stuck?: { readonly metric: string; readonly n: number; readonly rung: number }; readonly repeats?: number };

export type Step = { readonly step: string; readonly ms: number; readonly ok: boolean };
// one round of filling in what the new session's restatement left out: the items, how many old-log lines were quoted, the file
export type Supplement = { readonly round: number; readonly items: readonly { readonly kind: string; readonly text: string }[]; readonly evidence: number; readonly file: string };

export type Who = "lead" | "lane";

// who decided a rollover: the lead (lead:<reason>), the owner (an answered card or their message), or the automation key
export type DecidedBy = "lead" | "owner" | "auto";

// the one-line message to the owner after a rollover the lead decided: its message id, or why it could not be sent
export type OwnerReport = { readonly message?: string; readonly error?: string };

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
      readonly decidedBy?: DecidedBy;
      readonly reason?: string;
      readonly ownerReport?: OwnerReport;
      readonly proposedAt?: string;
      readonly approvalMin?: number;
      readonly signals: Signals;
      readonly steps: readonly Step[];
      readonly result: string;
      readonly reasons: readonly string[];
      // the subscription accounts of the old and new session ("" when the status line did not show one)
      readonly accounts?: { readonly from: string; readonly to: string };
      readonly supplementRounds?: number;
      readonly supplements?: readonly Supplement[];
    };

export type Limits = { readonly contextPct: number; readonly compactions: number; readonly ageH: number };

// Which thresholds the measured signals cross (a threshold of 0 is off).
export const crossed = (s: Signals, h: Limits): string[] => [
  ...(h.contextPct > 0 && s.contextPct !== undefined && s.contextPct >= h.contextPct ? [`context ${s.contextPct}% >= ${h.contextPct}%`] : []),
  ...(h.compactions > 0 && s.compactions !== undefined && s.compactions >= h.compactions ? [`compactions ${s.compactions} >= ${h.compactions}`] : []),
  ...(h.ageH > 0 && s.ageH !== undefined && s.ageH >= h.ageH ? [`age ${s.ageH.toFixed(1)} h >= ${h.ageH} h`] : []),
];

// The reasons a rollover is due: the measured thresholds crossed, and rung 4 of the stuck ladder.
export const dueReasons = (s: Signals, h: Limits): string[] => [...crossed(s, h), ...(s.stuck && s.stuck.rung >= 4 ? [`stuck rung 4 on ${JSON.stringify(s.stuck.metric)} (${s.stuck.n} attempts)`] : [])];

// The lane's current session began when it moved to its pane (a handover) or, before any move, when it opened.
export const sessionStart = (lane: Lane): string => lane.history?.findLast((h) => h.note.startsWith("pane moved") && h.note.includes(`-> ${lane.pane} `))?.at ?? lane.openedAt ?? "";

export const sessionFixes = (lane: Lane): FixAttempt[] => {
  const since = sessionStart(lane);
  return (lane.fixes ?? []).filter((f) => f.at >= since);
};

// After a rollover the lead decided (lead:<reason>): one line to the owner, and its message id (or why it failed) for the log.
// A failure is ROLLOVER_OWNER_REPORT_MISSING in the watch log, so the lead tells the owner by hand.
export const reportToOwner = async (deps: { readonly reportOwner?: (thread: string | null, text: string) => Promise<string>; readonly config: Pick<DoriConfig, "handover">  }, key: string, thread: string | null, values: { readonly who: string; readonly from: string; readonly to: string; readonly reason: string }, emit: (line: string) => void): Promise<OwnerReport> => {
  const text = fill([deps.config.handover.reportText], values)[0] ?? deps.config.handover.reportText;
  try {
    if (!deps.reportOwner) throw new Error("no messenger to reach the owner");
    const message = await deps.reportOwner(thread, text);
    emit(`ROLLOVER_OWNER_REPORTED ${key} message ${message}`);
    return { message };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    emit(`ROLLOVER_OWNER_REPORT_MISSING ${key}: ${error}; tell the owner yourself: ${text}`);
    return { error };
  }
};

export const AUTO_PREFIX = "auto:";
export const LEAD_PREFIX = "lead:";

// a lead's approval names the signal it acts on (a STUCK rung, an owner-check finding, a measured threshold)
// whole tokens only: "age" in "message" or 단 in 단계 is no signal (challenge, grok-4.7)
const SIGNAL_WORD = /(?<![\w])(?:STUCK|rung ?4|OWNER_CHECK|VIOLATION|CONTRADICTION|GOAL_LOSS|ROLLOVER_DUE|SAME_FIX_3|fixated|context \d+ ?%|compactions? \d+|\d+ compactions?|age \d+(?:\.\d+)? ?h)(?![\w])|막힘 ?4 ?단|맥락 (?:이상|단)|압축 \d+/i;

// the thresholds of one side, from handover.lane* or handover.lead*
export const limitsFor = (who: Who, h: DoriConfig["handover"]): Limits =>
  who === "lane" ? { contextPct: h.laneContextPct, compactions: h.laneCompactions, ageH: h.laneAgeH } : { contextPct: h.leadContextPct, compactions: h.leadCompactions, ageH: h.leadAgeH };

// the reason the owner reads after an automatic rollover: what the session crossed when it moved
export const autoReason = (who: Who, signals: Signals, h: DoriConfig["handover"]): string => `automatic (handover.autoRollover${who === "lane" ? "Lanes" : "Lead"}): ${dueReasons(signals, limitsFor(who, h)).join(", ") || "a threshold was crossed"}`;

export const decidedBy = (ref: string): DecidedBy => (ref.startsWith(LEAD_PREFIX) ? "lead" : ref.startsWith(AUTO_PREFIX) ? "auto" : "owner");

// A new session (lane or lead) does nothing but re-arm monitors and ack the probe until it gets this line: before it the
// handover may still roll back, and work done by a session that is then closed would be lost or done twice.
export const COMMITTED = "HANDOVER_COMMITTED";

const DISCORD_LINK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+$/;

// What makes a rollover approved: the lead's decision "lead:<reason and the signal behind it>" (the owner decided the lead
// rolls over and is told afterwards: canReport says the handover can post that message), a question card (Qn) the owner
// answered with its first option, a link to the owner's Discord message, or "auto:..." when the automation key for that
// side is on. A card counts only when it was posted as a rollover proposal for this key and for the session it runs in now
// (the rollover log says so), so a yes on another lane's card, on any other question, or on a card about an earlier session
// moves nothing. Undefined when the reference holds.
export const approvalProblem = (ref: string | undefined, card: (id: string) => Question | undefined, auto: { readonly on: boolean; readonly key: string }, key: string, pane: string, proposals: readonly RolloverEntry[], canReport = false): string | undefined => {
  const r = ref?.trim() ?? "";
  if (!r) return `no approval: pass --approved-by "${LEAD_PREFIX}<your reason and the signal behind it>" (or the owner's answered rollover card Qn, or the link to their Discord message)`;
  if (r.startsWith(LEAD_PREFIX)) {
    const why = r.slice(LEAD_PREFIX.length).trim();
    if (why.length < 8 || !SIGNAL_WORD.test(why)) return `${JSON.stringify(r)} does not say the reason and the signal behind it: --approved-by "${LEAD_PREFIX}<reason>, <signal: STUCK rung 4 on X, OWNER_CHECK GOAL_LOSS twice, context 85%>"`;
    return canReport ? undefined : "a lead's rollover needs a way to tell the owner afterwards: set DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL (or give the lane a discord:<id> thread)";
  }
  if (r.startsWith(AUTO_PREFIX)) {
    if (r !== `${AUTO_PREFIX}${auto.key}`) return `${r} is not the automatic approval of this side; only ${AUTO_PREFIX}${auto.key} is`;
    if (!auto.on) return `${r} is an automatic approval, but the automation key is off (the owner turns it on)`;
    // an automatic rollover tells the owner afterwards too
    return canReport ? undefined : "an automatic rollover needs a way to tell the owner afterwards: set DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL (or give the lane a discord:<id> thread)";
  }
  if (/^Q\d+$/i.test(r)) {
    const q = card(r.toUpperCase());
    if (!q) return `card ${r} not found`;
    const p = proposals.findLast((e): e is Extract<RolloverEntry, { kind: "proposal" }> => e.kind === "proposal" && e.card === q.id);
    if (!p || p.key !== key) return `card ${q.id} is not a rollover proposal for ${key}; post one with dori rollover-propose ${key}`;
    if (p.pane !== pane) return `card ${q.id} was about ${p.pane}, not the session ${key} runs in now (${pane}); post a new one with dori rollover-propose ${key}`;
    if (q.status !== "answered") return `card ${q.id} is not answered yet`;
    if (q.answer !== q.options[0]) return `card ${q.id} was answered ${JSON.stringify(q.answer ?? "")}, not ${JSON.stringify(q.options[0] ?? "")}`;
    return undefined;
  }
  return DISCORD_LINK.test(r) ? undefined : `approval reference ${JSON.stringify(r)} is neither an answered rollover card Qn nor a link to the owner's Discord message`;
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

// Watch-log kinds that show a lane going wrong: silence (NUDGED, NO-REPORT), a stuck rung, an owner-check finding, lost
// input, a blocked pane. SAME_FIX_3, REPEAT_SUSPECT and INTENT_DRIFT are the names older versions wrote; they still count.
export const QUALITY_KINDS = ["NUDGED", "NO-REPORT", "STUCK", "OWNER_CHECK", "NOT_SUBMITTED", "LANE_BLOCKED", "SAME_FIX_3", "REPEAT_SUSPECT", "INTENT_DRIFT"] as const;

type Counts = Record<string, number>;

const countsIn = (lines: readonly string[], key: string, from: number, to: number): Counts => {
  const out: Counts = {};
  for (const line of lines) {
    const w = parseWatchLine(line);
    if (!w || w.key !== key) continue;
    const at = Date.parse(w.at);
    const kind = QUALITY_KINDS.find((k) => k === w.kind);
    // an owner check that found nothing is not a quality signal
    if (kind === "OWNER_CHECK" && w.detail.startsWith("OK")) continue;
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
const fmtSignals = (s: Signals): string => [s.contextPct !== undefined ? `context ${s.contextPct}%` : "", s.compactions !== undefined ? `compactions ${s.compactions}` : "", s.ageH !== undefined ? `age ${s.ageH} h` : "", s.stuck ? `stuck rung ${s.stuck.rung} on ${JSON.stringify(s.stuck.metric)} (${s.stuck.n}x)` : "", s.repeats !== undefined ? `same fix ${s.repeats}x` : ""].filter(Boolean).join(", ") || "no signals";
const fmtDecision = (r: Extract<RolloverEntry, { kind: "rollover" }>): string =>
  r.decidedBy === "lead" ? `; decided by the lead${r.reason ? ` (${r.reason})` : ""}, owner told: ${r.ownerReport?.message ?? `MISSING (${r.ownerReport?.error ?? "no report"})`}` : "";

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
    out.push(`ROLLOVER ${r.who} ${r.key} ${r.at} ${r.result} ${r.from} -> ${r.to ?? "-"} ${fmtSignals(r.signals)}; approval ${r.approvalMin ?? "-"} min (by ${r.approvedBy ?? "-"})${fmtDecision(r)}; steps ${r.steps.map((s) => `${s.step} ${Math.round(s.ms / 1000)}s${s.ok ? "" : " FAIL"}`).join(", ") || "-"}${r.reasons.length ? `; reasons: ${r.reasons.join("; ")}` : ""}${r.accounts && r.accounts.from !== r.accounts.to ? `; account ${r.accounts.from || "?"} -> ${r.accounts.to || "?"}` : ""}${r.supplementRounds ? `; supplements ${r.supplementRounds} (${(r.supplements ?? []).map((s) => s.items.length).join("+")} items)` : ""}`);
    out.push(`QUALITY ${r.key} ${r.at} before ${windowH}h: ${fmtCounts(countsIn(watchLines, r.key, at - span, at))} | after ${afterH}h: ${fmtCounts(countsIn(watchLines, r.key, at, at + span))}`);
  }
  return out;
};
