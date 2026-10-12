import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { type AutoSignals, type DoriConfig, expandHome } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { laneArea, loadTree, stuckStep, type Tree } from "./explore.ts";
import type { Lane } from "./registry.ts";
import { sessionStart } from "./rollover.ts";
import { iso, type Runner } from "./run.ts";
import { sessionDirFor } from "./session-id.ts";
import { watchLog } from "./watch-log.ts";

// Untagged repeat detection: the inferred half of the stuck ladder's count. The tagged half counts only fixes a lane tags
// "(fix: metric / hypothesis)" or the lead records with dori fix-attempt, and lanes rarely tag. This reads what a lane leaves
// anyway: its [REPORT] lines, the commits on its branch and its hypothesis-tree entries, and infers the same loop: a gate
// line (metric) fails, a new prescription or patch targets that metric, it fails again, another one targets it. Each
// "fail, then a new attempt on the same metric" is one cycle; a PASS of the metric ends the run of cycles (the direction
// changed: the gate was met). The stuck ladder (explore.ts stuckStep) takes the larger of the two counts.

export type EventSource = "report" | "commit" | "tree";
export type LaneEvent = { readonly at: string; readonly source: EventSource; readonly text: string };

export type Evidence = { readonly at: string; readonly source: EventSource; readonly role: "fail" | "attempt"; readonly text: string };
export type MetricRepeat = { readonly metric: string; readonly n: number; readonly lastAt: string; readonly evidence: readonly Evidence[] };

// verdicts are matched as written (FAIL, PASS, REJECTED: a test suite's "13 failed" is not a gate verdict); attempt and
// diagnosis words in any case
const re = (p: string): RegExp => new RegExp(p, "u");
const rei = (p: string): RegExp => new RegExp(p, "iu");
const MAX_ITEM = 40;

// "**0.259**" and "`x`" are emphasis, not text; spaces collapse so a metric name matches however a report wrapped it
export const normText = (s: string): string => s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const QUALIFIERS = new Set(["최대", "최소", "평균", "합", "합계", "총", "spec", "max", "min", "mean", "avg", "total", "share", "rate", "비율", "count", "수", "판", "the", "a", "of", "on", "per", "선", "전체", "관찰", "observed", "new", "새"]);
const NOT_METRICS = new Set(["pass", "fail", "failed", "line", "lines", "gate", "관문", "판정", "verdict", "결과", "result", "등록", "기준", "rule", "and", "또는", "그리고", "나머지", "전부", "모두", "all"]);

// The metric a gate item names: its leading words, up to the first number, comparison or bracket ("교착 58(벽 2/한계 56)" is
// 교착, "spec 침투 최대 0.169" is 침투, "over-trench 2" is over-trench). Qualifiers (최대, max, spec, 판 ...) are dropped.
export const metricName = (item: string, conditions: readonly string[] = []): string | undefined => {
  const m = /^[\s(*\-–—:>|·,;]*([\p{L}][\p{L}\p{M}' -]*?)\s*(?=[\d(<>≤≥=~.:%/_]|$)/u.exec(item.replace(/[*`]/g, ""));
  const head = m?.[1] ?? "";
  // an identifier (model_1625, GPU-13) or a short acronym (qa, cpu) names a thing, not a gate line
  const rest = item.replace(/[*`]/g, "").slice((m?.index ?? 0) + (m?.[0].length ?? 0));
  if (/^[_-]\d/.test(rest) || /[_-]$/.test(head)) return undefined;
  const words = head.toLowerCase().split(/\s+/).filter((w) => w && !QUALIFIERS.has(w));
  // a condition the report breaks results down by (양토 1.0, seed 101) names a cell, not a gate line
  if (words[0] && conditions.some((c) => c.toLowerCase() === words[0])) return undefined;
  const name = words.join(" ").replace(/^[-_']+|[-_']+$/g, "");
  // a gate line is named in a few words (교착, 도랑 위 덤프, dump success); longer is prose around a verdict
  if (words.length > 3 || name.length > 24) return undefined;
  if (name.length < 2 || /^[a-z]{1,3}$/.test(name) || NOT_METRICS.has(name) || words.every((w) => NOT_METRICS.has(w))) return undefined;
  return name;
};

const SPLIT = /[·,;|]/;
// the words right before a value name it; leading ids (model_993, e7st1i, F1) before them are not part of the name
const nameTail = (s: string): string => (s.split(/[:：]/).at(-1) ?? "").replace(/^\s*(?:\S*[\d_]\S*\s+)+/u, "");
// "FAIL 교착 145 — 덤프 0.837 ...": a dash or an arrow ends the list of failed lines
const SEGMENT = /\n|(?<=[.!?。])\s+(?=[A-Z가-힣(*])|\s[—–-]\s|\s?→\s?/u;

// The metrics a text says failed: "교착 554 FAIL(≤2)" (the item that holds the verdict) and "FAIL 도랑 위 덤프 1·교착 58"
// or "FAIL: 교착 136, 깊음 0" (the items after a bare FAIL that carry no verdict of their own).
export const failedMetrics = (text: string, cfg: Pick<AutoSignals, "failPattern" | "passPattern" | "conditionWords">): string[] => {
  const fail = re(cfg.failPattern);
  const pass = re(cfg.passPattern);
  const out = new Set<string>();
  for (const segment of text.split(SEGMENT)) {
    const items = segment.split(SPLIT);
    let listOpen = false;
    for (const raw of items) {
      const item = raw.replace(/[*`]/g, "");
      const hits = [...item.matchAll(new RegExp(cfg.failPattern, "gu"))];
      const m = hits.at(-1);
      if (m) {
        // "교착 554 FAIL": the item carries its measured value; in "model_498 F1: 교착 487 FAIL" or "불합격 3/8: 덤프 성공
        // 0.68 FAIL" the name follows the colon or the verdict before it
        let from = 0;
        let named: string | undefined;
        for (const h of hits) {
          const tail = nameTail(item.slice(from, h.index));
          const n = /\d/.test(tail) ? metricName(tail, cfg.conditionWords) : undefined;
          if (n) out.add(n);
          named ??= n;
          from = (h.index ?? 0) + h[0].length;
        }
        const after = item.slice(from).replace(/^\s*\d*\s*[:：]?\s*/, "");
        // a bare "FAIL:" or "FAIL 2:" or "FAIL 교착 145" opens a list of failed lines
        const next = metricName(after, cfg.conditionWords);
        if (next && !pass.test(after)) out.add(next);
        listOpen = !named || after.trim().length > 0 || /[:：]\s*$/.test(item);
        continue;
      }
      if (listOpen) {
        // a gate item is short ("교착 58"); prose or a PASS ends the list
        if (pass.test(item) || item.trim().length > MAX_ITEM) {
          listOpen = false;
          continue;
        }
        const named = /\d/.test(item) ? metricName(item, cfg.conditionWords) : undefined;
        if (named) out.add(named);
      }
    }
  }
  return [...out];
};

const SENTENCE = /\n|(?<=[.!?。])\s+/u;
// "T-reward not launched", "조정 5 없음", "보상 조정 중단": a clause that says an attempt is not made; 안 is the word "not"
// ("학습 안 띄움"), not the end of 방안/처방안 ("처방안 한 장 확정" is a prescription)
const NEGATED = /(?<![\p{L}])안 |않|없음|없이|중단|보류|대신|아니라|\bnot\b|\bno\b|\bnever\b|\bwithout\b|\bstop(?:ped)?\b|\binstead\b/iu;
const CLAUSE = /[,;·|()[\]{}]|\s[—–-]\s|→|=>|\n|(?<=[.!?。])\s+/u;
const SENTENCE_WIDE = /\n|(?<=[.!?。])\s+|\s[—–]\s|;/u;

export const passedMetrics = (text: string, cfg: Pick<AutoSignals, "failPattern" | "passPattern" | "conditionWords">): string[] => {
  const fail = re(cfg.failPattern);
  const pass = re(cfg.passPattern);
  const out = new Set<string>();
  for (const raw of text.split(/\n|[·,;|]|\s[—–-]\s/)) {
    const item = raw.replace(/[*`]/g, "");
    const m = pass.exec(item);
    if (!m || fail.test(item)) continue;
    const named = metricName(nameTail(item.slice(0, m.index)), cfg.conditionWords);
    if (named) out.add(named);
  }
  return [...out];
};

// canonical name for a metric: an alias group's first name when any of its names is the metric or inside it
export const canonical = (metric: string, aliases: AutoSignals["aliases"]): string => {
  const m = normText(metric);
  for (const [name, list] of Object.entries(aliases)) for (const v of [name, ...list]) if (m === normText(v) || m.includes(normText(v))) return normText(name);
  return m;
};

const mentions = (text: string, metric: string, aliases: AutoSignals["aliases"]): boolean => {
  const t = normText(text);
  const names = [metric, ...(aliases[metric] ?? Object.entries(aliases).find(([k]) => normText(k) === metric)?.[1] ?? [])];
  return names.some((n) => {
    const v = normText(n);
    // a Latin name matches as a word (over-trench, not "overtrenching"); Korean has particles glued on, so a substring
    return /^[\p{Script=Latin}\d _'-]+$/u.test(v) ? new RegExp(`(?<![\\p{L}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(t) : t.includes(v);
  });
};

const clipLine = (s: string, n = 160): string => {
  const t = s.replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// passes: when each metric last passed (its count started again there)
export type RepeatState = { readonly counts: ReadonlyMap<string, MetricRepeat>; readonly vocab: ReadonlySet<string>; readonly passes: ReadonlyMap<string, string> };

// Walks the events in time order and counts, per metric, the cycles "failed, then a new attempt targets it". A new attempt
// is an event that matches inferAttemptPattern (a prescription, adjustment, patch, fix/feat commit, a new run) and is not only
// a diagnosis (diagnosticPattern, unless it also names a prescription); an event that reports a metric failing is never
// also an attempt on it. Attempts on one metric closer than repeatGapMin to the last counted one are the same attempt
// told twice (a commit and the report about it). A PASS of the metric starts its count again.
export const inferRepeats = (events: readonly LaneEvent[], cfg: AutoSignals, onCycle?: (r: MetricRepeat, e: LaneEvent) => void): RepeatState => {
  const verdict = re(cfg.verdictPattern);
  const attempt = rei(cfg.inferAttemptPattern);
  const strong = rei(cfg.prescriptionPattern);
  const diag = rei(cfg.diagnosticPattern);
  const disc = rei(cfg.discriminationPattern);
  const vocab = new Set<string>(Object.keys(cfg.aliases).map(normText));
  const failedSince = new Map<string, Evidence>();
  const counts = new Map<string, MetricRepeat>();
  const passes = new Map<string, string>();
  const gap = cfg.repeatGapMin * 60_000;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const text = e.text;
    const failedHere = new Set(failedMetrics(text, cfg).map((m) => canonical(m, cfg.aliases)));
    for (const m of failedHere) vocab.add(m);
    // a prescription-level verdict ("REJECTED", "기각", "판정 불가") fails every known metric its sentence names
    for (const s of text.split(SENTENCE)) if (verdict.test(s)) for (const m of vocab) if (mentions(s, m, cfg.aliases)) failedHere.add(m);
    const passedHere = new Set(passedMetrics(text, cfg).map((m) => canonical(m, cfg.aliases)));
    for (const m of passedHere) {
      if (failedHere.has(m)) continue;
      counts.delete(m);
      failedSince.delete(m);
      passes.set(m, e.at);
    }
    for (const m of failedHere) if (!failedSince.has(m)) failedSince.set(m, { at: e.at, source: e.source, role: "fail", text: clipLine(text) });
    // an attempt targets a metric when one clause holds both the attempt word and the metric ("조정 4 = 평균 행동 교착 진입
    // 벌점"), not when the metric is only context elsewhere in the report ("model_795, 씨앗 200~223 ... 시작"); the clause
    // must not itself be a verdict or say the attempt is not made. A failure first seen in this very event is not consumed by
// it: an eval report that states a FAIL and plans the next step is not yet a new attempt (challenge, grok-4.7).
    const fail = re(cfg.failPattern);
    const acts = text.split(cfg.targetScope === "sentence" ? SENTENCE_WIDE : CLAUSE).filter((c) => attempt.test(c) && !NEGATED.test(c) && !fail.test(c) && !verdict.test(c) && (strong.test(c) || !diag.test(c)));
    // a report or tree entry that tells hypotheses apart (dori tree H.., 가설 판별, a falsified or supported entry) and makes
    // no new attempt itself changed the next action: its result ruled a prescription out or sent the lane on a root-cause
    // hunt, so the next attempt on the failed lines is not a repeat. One that states its discrimination result and in the
    // same report prescribes again on the line did not change the action; it is an attempt like any other (hr35-e7 정지
    // loop, 2026-10-11: "판별 결과: ... 둘 다 기각" next to "처방안 한 장 확정").
    if (!acts.length) {
      if (disc.test(text) || (e.source === "tree" && /\s기각|\s->\s/.test(text))) failedSince.clear();
      continue;
    }
    for (const [m, failEv] of failedSince) {
      if (failEv.at === e.at || !acts.some((c) => mentions(c, m, cfg.aliases))) continue;
      const prev = counts.get(m);
      if (prev && Date.parse(e.at) - Date.parse(prev.lastAt) < gap) continue;
      const next: MetricRepeat = { metric: m, n: (prev?.n ?? 0) + 1, lastAt: e.at, evidence: [...(prev?.evidence ?? []), failEv, { at: e.at, source: e.source, role: "attempt", text: clipLine(text) }] };
      counts.set(m, next);
      failedSince.delete(m);
      onCycle?.(next, e);
    }
  }
  return { counts, vocab, passes };
};

export const suspects = (state: RepeatState, after: number): MetricRepeat[] => [...state.counts.values()].filter((r) => r.n >= after).sort((a, b) => b.n - a.n);

export const maxInferred = (state: RepeatState): number => Math.max(0, ...[...state.counts.values()].map((r) => r.n));

// dori repeat-check's line for one metric (an analysis printout; the alert is the stuck ladder's STUCK line)
export const inferredLine = (key: string, r: MetricRepeat, tagged: number): string =>
  `INFERRED ${key} ${JSON.stringify(r.metric)} ${r.n} (from untagged reports/commits/tree; tagged ${tagged}): the same gate line re-targeted after failing ${r.n} times. last: ${clipLine(r.evidence.at(-1)?.text ?? "", 140)}`;

export const evidenceLines = (r: MetricRepeat): string[] => r.evidence.map((e) => `  ${e.at.slice(0, 16).replace("T", " ")} ${e.source} ${e.role}: ${e.text}`);

// ---- reading what a lane left ----

type Entry = { readonly type?: string; readonly timestamp?: string; readonly content?: unknown; readonly message?: { readonly role?: string; readonly content?: unknown } };

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// one report told twice (the lane's typing and the lead's copy, or a template still holding ${kst()}) is one report
export const reportKey = (text: string): string => text.replace(/\$\{[^}]*\}|\{kst\(\)\}/g, "").replace(/\d{1,2}:\d\d(?::\d\d)? ?KST/g, "").replace(/^[^\p{L}\p{N}]*(?:진행|progress)[^\p{L}\p{N}]*/iu, "").replace(/\s+/g, " ").trim().slice(0, 200);

export type ReportLine = { readonly at: string; readonly text: string };

// Where a report can be: text the session received (a lane's report typed into the lead, a lead copy), or a tool call that
// sends one (send-keys, send-text, dori type). A report template quoted in a goal, a brief or a note is not a report.
const SENDS = /send-keys|send-text|\bdori\b["',\s\\]+type\b/;
const reportStrings = (e: Entry): string[] => {
  const c = e.message?.content;
  if (e.message?.role === "user") return strings(c);
  if (e.message?.role !== "assistant" || !Array.isArray(c)) return [];
  return (c as { type?: string; arguments?: unknown }[]).flatMap((b) => (b?.type === "toolCall" && SENDS.test(JSON.stringify(b.arguments ?? {})) ? strings(b.arguments) : []));
};

// [REPORT] <key> lines in session files (the lane's own tool calls that typed them, and the lead's copy), oldest first.
// Files not written since `since` are skipped.
export const readReports = async (files: readonly string[], key: string, since = 0): Promise<ReportLine[]> => {
  const grammar = new RegExp(`\\[REPORT\\] ${escape(key)} \\| (?:milestone|blocker|question|done) \\| (?!<)([^\\n"]{1,2000})`, "g");
  const seen = new Map<string, ReportLine>();
  for (const f of files) {
    if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < since) continue;
    for (const line of (await Bun.file(f).text()).split("\n")) {
      if (!line.includes(`[REPORT] ${key} |`)) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      const at = e.timestamp ?? "";
      if (Date.parse(at) < since) continue;
      for (const s of reportStrings(e)) {
        for (const m of s.matchAll(grammar)) {
          const text = (m[1] ?? "").replace(/\\n/g, " ").trim();
          // a template quoted in a goal or a brief ("| done | ...` is sent ...") is not a report
          if (!text || text.includes("${") || /^(?:\.\.\.|…)/.test(text)) continue;
          const k = reportKey(text);
          const old = seen.get(k);
          if (!old || old.at > at) seen.set(k, { at, text });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
};

// The lead's messages typed into a lane ([LEAD] ...), as the lane's session saw them, oldest first.
export const readLeadRelays = async (files: readonly string[], since = 0): Promise<ReportLine[]> => {
  const out: ReportLine[] = [];
  for (const f of files) {
    if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < since) continue;
    for (const line of (await Bun.file(f).text()).split("\n")) {
      if (!line.includes("[LEAD]")) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (e.message?.role !== "user" || Date.parse(e.timestamp ?? "") < since) continue;
      // the message's own text parts only (strings() would also pick up each part's "type": "text")
      const c = e.message.content;
      const text = (typeof c === "string" ? c : Array.isArray(c) ? (c as { text?: unknown }[]).flatMap((p) => (typeof p?.text === "string" ? [p.text] : [])).join("\n") : "").trim();
      if (text.startsWith("[LEAD]")) out.push({ at: e.timestamp ?? "", text: text.split(/\n<omo-|\n<system-reminder/)[0]?.trim() ?? text });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
};

const jsonl = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  } catch {
    return [];
  }
};

// the lane's own session files (its cwd's session folder) and the lead's (scorecard.leadSessions)
export const laneSessionFiles = (config: Pick<DoriConfig, "sessionsDir" | "defaultCwd" | "scorecard">, lane: Pick<Lane, "cwd">): string[] => {
  const cwd = resolve(expandHome(lane.cwd ?? config.defaultCwd));
  return [...new Set([...jsonl(sessionDirFor(config.sessionsDir, cwd)), ...(config.scorecard.leadSessions ? jsonl(config.scorecard.leadSessions) : [])])];
};

// commit subjects on the lane's branches since `since` (each dir: its checked-out branch)
export const readCommits = async (run: Runner, dirs: readonly string[], since: string): Promise<LaneEvent[]> => {
  const out = new Map<string, LaneEvent>();
  for (const d of dirs) {
    const r = await run(["git", "-C", d, "log", `--since=${since}`, "--no-merges", "--format=%H%x09%cI%x09%s"]);
    if (r.code !== 0) continue;
    for (const line of r.out.split("\n")) {
      const [sha, at, subject] = line.split("\t");
      if (sha && at && subject) out.set(sha, { at: new Date(at).toISOString(), source: "commit", text: subject });
    }
  }
  return [...out.values()];
};

export const treeEvents = (tree: Tree, key: string, since: string): LaneEvent[] =>
  tree.nodes.filter((n) => n.lane === key && n.at >= since).map((n) => ({ at: n.at, source: "tree" as const, text: `${n.text}${n.metric ? ` [${n.metric}]` : ""}${n.status === "falsified" ? " 기각" : ""}${n.result ? ` -> ${n.result}` : ""}` }));

export const repoDirs = (lane: Pick<Lane, "worktrees" | "cwd">, extra: readonly string[] = []): string[] => [...new Set([...extra, ...(lane.worktrees ?? []), ...(lane.cwd ? [expandHome(lane.cwd)] : [])])];

export type LaneScan = { readonly events: readonly LaneEvent[]; readonly reports: number; readonly commits: number; readonly tree: number };

// Everything the lane left since `since`: its reports, the commits on its branches and its tree entries.
export const laneEvents = async (deps: FlowDeps, lane: Lane, opts: { readonly since: string; readonly until?: string; readonly repos?: readonly string[]; readonly files?: readonly string[] }): Promise<LaneScan> => {
  const sinceMs = Date.parse(opts.since) || 0;
  const until = opts.until ?? "9999";
  const reports = (await readReports(opts.files ?? laneSessionFiles(deps.config, lane), lane.key, sinceMs)).filter((r) => r.at <= until);
  const commits = (await readCommits(deps.run, repoDirs(lane, opts.repos), opts.since)).filter((c) => c.at <= until);
  const tree = treeEvents(await loadTree(deps.config.stateDir, laneArea(lane, deps.config)), lane.key, opts.since).filter((t) => t.at <= until);
  return { events: [...reports.map((r) => ({ at: r.at, source: "report" as const, text: r.text })), ...commits, ...tree], reports: reports.length, commits: commits.length, tree: tree.length };
};

export type RepeatTick = { readonly lines: readonly string[]; readonly inferred: number };

// the full fail/attempt chain behind each grown count, appended to <stateDir>/auto-signals/<key>.md
export const evidenceFile = (stateDir: string, key: string): string => join(stateDir, "auto-signals", `${key}.md`);

// On a new report (freshness): the untagged repeats in the lane's current session. The counts and the last PASS of each
// metric are kept on the lane; every metric whose count changed takes one step of the stuck ladder, which writes the STUCK
// line when its rung goes up (rung 3, research and a challenge, may type into the lane). Returns those lines and the
// largest count.

export const repeatTick = async (deps: FlowDeps, lane: Lane, files?: readonly string[]): Promise<RepeatTick> => {
  const cfg = deps.config.autoSignals;
  const scan = await laneEvents(deps, lane, { since: sessionStart(lane), ...(files ? { files } : {}) });
  const lastAt = lane.inferred?.lastEventAt;
  const state = inferRepeats(scan.events, cfg);
  const before = lane.inferred?.counts ?? {};
  const counts = Object.fromEntries([...state.counts.values()].map((r) => [r.metric, r.n]));
  const passedAt = Object.fromEntries(state.passes);
  const newest = scan.events.reduce((m, e) => (e.at > m ? e.at : m), lastAt ?? "");
  // a metric whose count changed or that passed again takes a ladder step (a PASS lowers a tagged-only metric's rung too)
  const passedNow = Object.keys(passedAt).filter((m) => passedAt[m] !== lane.inferred?.passedAt?.[m]);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(counts), ...passedNow])].filter((m) => (before[m] ?? 0) !== (counts[m] ?? 0) || passedNow.includes(m));
  // a PASS started the count again from 0, so an --improved baseline from before it no longer applies
  const baseline = Object.fromEntries(Object.entries(lane.inferred?.baseline ?? {}).filter(([m]) => !passedNow.includes(m)));
  if (changed.length || newest !== (lastAt ?? "")) await deps.registry.patch(lane.key, { inferred: { at: iso(deps.clock), counts, passedAt, ...(Object.keys(baseline).length ? { baseline } : {}), ...(newest ? { lastEventAt: newest } : {}) } });
  const file = evidenceFile(deps.config.stateDir, lane.key);
  const lines: string[] = [];
  for (const m of changed) {
    const r = state.counts.get(m);
    if (r && r.n > (before[m] ?? 0)) {
      mkdirSync(join(deps.config.stateDir, "auto-signals"), { recursive: true });
      appendFileSync(file, [`## ${iso(deps.clock)} ${JSON.stringify(r.metric)} ${r.n}`, ...evidenceLines(r), ""].join("\n"));
    }
    lines.push(...(await stuckStep(deps, lane.key, m)));
  }
  return { lines, inferred: maxInferred(state) };
};
