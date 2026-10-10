import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type DoriConfig, expandHome } from "./config.ts";
import { type FixAttempt, type Lane, statusOf } from "./registry.ts";
import { fixCount, fixTag } from "./same-fix.ts";

// dori signals: what earlier lanes in one area of work (a lane, a repo, a topic tag) tried and how it went, read from
// records only: the registry (fix attempts, done claims and their rejections, the outcome), the lead's session files
// (the lanes' [REPORT] lines and the lead's re-instructions) and the lanes log (freshness nudges). It is a signal for
// the lead before it re-instructs a lane, and for a new lane in the same area, so that a fix that failed is not tried again.

export type ClaimEvent = { readonly at: string; readonly kind: "claim" | "rejected"; readonly note: string };

// Done claims and the not-done answers to them. A not-done with no open claim (a lead parking the lane, "waiting on the
// owner") is not a rejection, and a second claim while the first is still open is the same claim.
export const claimEvents = (lane: Lane): ClaimEvent[] => {
  const out: ClaimEvent[] = [];
  let open = false;
  for (const h of lane.history ?? []) {
    const claim = h.status === "done-claimed" || (h.status === "paused" && h.note.startsWith("done claimed while paused"));
    if (claim) {
      if (!open) out.push({ at: h.at, kind: "claim", note: h.note });
      open = true;
    } else if (h.status === "verified-done") continue;
    else {
      if (h.status === "not-done" && open) out.push({ at: h.at, kind: "rejected", note: h.note });
      open = false;
    }
  }
  return out;
};

// the key's first word is always a tag: rl-e7 is in rl
export const tagsOf = (lane: Pick<Lane, "key" | "tags">): string[] => [...new Set([lane.key.split(/[-_.]/)[0] ?? lane.key, ...(lane.tags ?? [])])];

export type AreaQuery = { readonly lane?: string; readonly cwd?: string; readonly tags?: readonly string[] };

export const inArea = (lane: Lane, q: AreaQuery, home = homedir()): boolean =>
  (q.lane !== undefined && lane.key === q.lane) ||
  (q.cwd !== undefined && lane.cwd !== undefined && resolve(expandHome(lane.cwd, home)) === resolve(expandHome(q.cwd, home))) ||
  (q.tags !== undefined && tagsOf(lane).some((t) => q.tags?.includes(t)));

// a lane's [REPORT] line or a lead message typed into its pane
export type Mention = { readonly at: string; readonly via: "report" | "lead"; readonly text: string };

export type LogSources = {
  // folder of the lead's session files (scorecard.leadSessions); empty = no reports or re-sends
  readonly leadSessions: string;
  // the dori-lanes sweep log (scorecard.lanesLog), for freshness nudges
  readonly lanesLog: string;
  // regex for a lead message to a lane, {pane} = its pane (scorecard.leadSendPattern)
  readonly sendPattern: string;
};

export type LaneLogs = { readonly mentions: readonly Mention[]; readonly sends: number; readonly nudges: number };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

type Entry = { readonly type?: string; readonly timestamp?: string; readonly content?: unknown; readonly message?: { readonly role?: string; readonly content?: unknown } };

// The lead's messages to a lane, as the lead's tool calls typed them: the text from [LEAD] up to the end of the string.
const leadTexts = (code: string, pane: string): string[] =>
  [...code.matchAll(new RegExp(`${escape(pane)}[^\\[]{0,80}(\\[LEAD\\][\\s\\S]{0,600})`, "g"))].map((m) => (m[1] ?? "").split(/["'`]\s*[,)\]]/)[0] ?? "");

// Reads the logs once for many lanes. Session files not written to since `since` are skipped.
export const readLaneLogs = async (lanes: readonly Lane[], src: LogSources, since = 0): Promise<Map<string, LaneLogs>> => {
  const acc = new Map(lanes.map((l) => [l.key, { mentions: new Map<string, Mention>(), sends: 0, nudges: 0 }]));
  const reportRe = lanes.map((l) => ({ key: l.key, re: new RegExp(`\\[REPORT\\] ${escape(l.key)} \\| (?:milestone|blocker|question|done) \\| (?!<)([^\\n]+)`, "g") }));
  const panes = lanes.flatMap((l) => (l.pane ? [{ key: l.key, pane: l.pane, send: new RegExp(src.sendPattern.replaceAll("{pane}", escape(l.pane)), "g") }] : []));
  let files: string[] = [];
  try {
    files = src.leadSessions ? readdirSync(src.leadSessions).filter((n) => n.endsWith(".jsonl")).map((n) => join(src.leadSessions, n)) : [];
  } catch {
    files = [];
  }
  for (const f of files) {
    if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < since) continue;
    for (const line of (await Bun.file(f).text()).split("\n")) {
      const report = line.includes("[REPORT] ");
      const toPane = panes.filter((p) => line.includes(p.pane));
      if (!report && !toPane.length) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      const at = e.timestamp ?? "";
      if (e.message?.role === "assistant") {
        // the lead's own tool calls: messages it typed into a lane's pane (its quoted brief template is not a report)
        for (const c of Array.isArray(e.message.content) ? (e.message.content as { type?: string; arguments?: unknown }[]) : []) {
          if (c.type !== "toolCall") continue;
          const args = JSON.stringify(c.arguments ?? "");
          for (const p of toPane) {
            const n = args.match(p.send)?.length ?? 0;
            if (!n) continue;
            const a = acc.get(p.key);
            if (!a) continue;
            a.sends += n;
            for (const s of strings(c.arguments)) for (const t of leadTexts(s, p.pane)) if (t.trim() && !a.mentions.has(t)) a.mentions.set(t, { at, via: "lead", text: t });
          }
        }
        continue;
      }
      if (!report) continue;
      const text = strings(e.message?.content ?? e.content).join("\n");
      for (const r of reportRe) {
        const a = acc.get(r.key);
        if (!a) continue;
        for (const m of text.matchAll(r.re)) {
          const t = (m[1] ?? "").trim();
          if (t && !a.mentions.has(t)) a.mentions.set(t, { at, via: "report", text: t });
        }
      }
    }
  }
  let log = "";
  try {
    log = src.lanesLog ? await Bun.file(src.lanesLog).text() : "";
  } catch {
    log = "";
  }
  for (const line of log.split("\n")) {
    const m = /^\S+ freshness NUDGED (\S+) /.exec(line);
    const a = m?.[1] ? acc.get(m[1]) : undefined;
    if (a) a.nudges++;
  }
  return new Map([...acc].map(([k, a]) => [k, { mentions: [...a.mentions.values()].sort((x, y) => x.at.localeCompare(y.at)), sends: a.sends, nudges: a.nudges }]));
};

const MAX_ATTEMPT = 20;

export type NumberedAttempt = { readonly n: number; readonly first: Mention; readonly last: Mention };

export type LaneSignals = {
  readonly lane: Lane;
  readonly outcome: string;
  readonly fixes: readonly FixAttempt[];
  readonly claims: number;
  readonly rejections: readonly ClaimEvent[];
  readonly sends: number;
  readonly nudges: number;
  readonly attempts: readonly NumberedAttempt[];
  readonly rootCause?: Mention;
  readonly warnings: readonly string[];
};

const outcomeOf = (lane: Lane): string => {
  const s = statusOf(lane);
  if (s === "closed") return lane.history?.some((h) => h.status === "verified-done") ? "closed, verified" : "closed by the lead";
  return s === "working" ? "open" : s;
};

export const laneSignals = (lane: Lane, logs: LaneLogs | undefined, cfg: Pick<DoriConfig, "signals" | "sameFix">): LaneSignals => {
  const mentions = logs?.mentions ?? [];
  // tagged reports the freshness sweep missed (it reads only the latest report); the registry wins when it has them
  const registryFixes = lane.fixes ?? [];
  const minedFixes = registryFixes.some((f) => f.via === "report")
    ? []
    : mentions.flatMap((m) => {
        const tag = m.via === "report" ? fixTag(m.text) : undefined;
        return tag ? [{ at: m.at, ...tag, via: "report" as const }] : [];
      });
  const fixes = [...registryFixes, ...minedFixes].sort((a, b) => a.at.localeCompare(b.at));
  const attemptRe = new RegExp(cfg.signals.attemptPattern, "gi");
  const rootRe = new RegExp(cfg.signals.rootCausePattern, "i");
  const byN = new Map<number, { first: Mention; last: Mention }>();
  let rootCause: Mention | undefined;
  for (const m of mentions) {
    // a message about the root cause ("stop adjusting, no adjustment 5") is not an attempt
    if (rootRe.test(m.text)) {
      if (byN.size && !rootCause) rootCause = m;
      continue;
    }
    for (const hit of m.text.matchAll(attemptRe)) {
      const n = Number(hit[1]);
      // "adjustment 50 iter" is a count of something else; nobody patches one metric 20 times
      if (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPT) continue;
      // the words around the number, not the head of a long report
      const at = hit.index ?? 0;
      const excerpt: Mention = { ...m, text: `${at > 60 ? "…" : ""}${m.text.slice(Math.max(0, at - 60), at + 200)}` };
      const seen = byN.get(n);
      // the latest mention before the root-cause switch is the attempt's result
      if (!seen) byN.set(n, { first: excerpt, last: excerpt });
      else if (!rootCause) byN.set(n, { first: seen.first, last: excerpt });
    }
  }
  const attempts = [...byN].map(([n, v]) => ({ n, ...v })).sort((a, b) => a.n - b.n);
  const events = claimEvents(lane);
  const rejections = events.filter((e) => e.kind === "rejected");
  const after = cfg.sameFix.after;
  const warnings: string[] = [];
  const pairs = new Map<string, FixAttempt>();
  for (const f of fixes) pairs.set(`${f.metric}\u0000${f.hypothesis}`, f);
  for (const f of pairs.values()) {
    const n = fixCount(fixes, f.metric, f.hypothesis);
    if (n >= after) warnings.push(`SAME_FIX ${lane.key} "${f.metric}" / "${f.hypothesis}" tried ${n} times: stop patching, find the root cause`);
  }
  for (const metric of new Set(fixes.map((f) => f.metric))) {
    const on = fixes.filter((f) => f.metric === metric);
    const hyps = new Set(on.map((f) => f.hypothesis)).size;
    if (hyps > 1 && on.length >= after) warnings.push(`REPEAT ${lane.key} "${metric}": ${on.length} fix attempts over ${hyps} hypotheses`);
  }
  const top = attempts.at(-1)?.n ?? 0;
  if (top >= after && !rootCause) warnings.push(`REPEAT ${lane.key} numbered attempts 1-${top} and no switch to a root-cause hunt`);
  if (rejections.length >= 2) warnings.push(`REJECTED ${lane.key} ${rejections.length} done claims rejected (last: ${clip(rejections.at(-1)?.note ?? "", 120)})`);
  return { lane, outcome: outcomeOf(lane), fixes, claims: events.length - rejections.length, rejections, sends: logs?.sends ?? 0, nudges: logs?.nudges ?? 0, attempts, ...(rootCause ? { rootCause } : {}), warnings };
};

export const hasSignals = (s: LaneSignals): boolean => s.fixes.length > 0 || s.attempts.length > 0 || s.rejections.length > 0 || s.sends + s.nudges > 0 || s.outcome === "not-done";

const clip = (s: string, n: number): string => {
  const t = s.replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const when = (iso: string): string => iso.slice(5, 16).replace("T", " ");

const mention = (m: Mention, n: number): string => `${when(m.at)} ${m.via}: ${clip(m.text, n)}`;

const hypotheses = (fixes: readonly FixAttempt[]): string[] =>
  [...new Set(fixes.map((f) => f.metric))].map((metric) => {
    const on = fixes.filter((f) => f.metric === metric);
    const hyps = [...new Set(on.map((f) => f.hypothesis))].map((h) => `${h} x${fixCount(on, metric, h)}`);
    return `"${metric}": ${hyps.join(", ")}`;
  });

export type AreaStats = { readonly lanes: number; readonly claims: number; readonly rejected: number; readonly rework: number };

export const areaStats = (list: readonly LaneSignals[]): AreaStats => {
  const claims = list.reduce((s, l) => s + l.claims, 0);
  const rejected = list.reduce((s, l) => s + l.rejections.length, 0);
  const rework = list.length ? list.reduce((s, l) => s + l.sends + l.nudges, 0) / list.length : 0;
  return { lanes: list.length, claims, rejected, rework };
};

export const formatStats = (a: AreaStats): string =>
  `${a.lanes} lane${a.lanes === 1 ? "" : "s"}, done claims rejected ${a.rejected}/${a.claims}${a.claims ? ` (${Math.round((a.rejected / a.claims) * 100)}%)` : ""}, rework ${a.rework.toFixed(1)} lead re-sends + nudges per lane`;

// One line per lane, for the lead's status view.
export const oneLine = (s: LaneSignals): string => {
  const parts = [
    ...(s.fixes.length ? [`fixes ${s.fixes.length}`] : []),
    ...(s.attempts.length ? [`attempts 1-${s.attempts.at(-1)?.n}${s.rootCause ? " then root cause" : ""}`] : []),
    `rejected ${s.rejections.length}/${s.claims + s.rejections.length ? s.claims : 0}`,
    `re-sends ${s.sends}`,
    `nudges ${s.nudges}`,
    ...(s.warnings.length ? [`${s.warnings.length} warning${s.warnings.length === 1 ? "" : "s"}`] : []),
  ];
  return `SIGNALS ${s.lane.key} [${s.outcome}] ${parts.join(", ")}`;
};

// The full record of one lane: numbered attempts with their first and latest mention, the root-cause switch, fixes by
// metric with their hypotheses, rejected claims with reasons, warnings.
export const formatLane = (s: LaneSignals, width = 150): string[] => {
  const head = `${s.lane.key} [${s.outcome}] ${s.lane.title}${s.lane.cwd ? ` · cwd ${s.lane.cwd.replace(homedir(), "~")}` : ""} · tags ${tagsOf(s.lane).join(",")} · re-sends ${s.sends} · nudges ${s.nudges}`;
  const out = [head];
  if (s.attempts.length) {
    out.push(`  numbered fix attempts (from [REPORT] lines and lead messages):`);
    for (const a of s.attempts) out.push(`    #${a.n} ${mention(a.first, width)}${a.last !== a.first ? `\n       latest ${mention(a.last, width)}` : ""}`);
  }
  if (s.rootCause) out.push(`  root-cause switch: ${mention(s.rootCause, width)}`);
  else if (s.attempts.length) out.push("  root-cause switch: none found");
  if (s.fixes.length) out.push(`  tagged fixes (metric: hypothesis xN): ${hypotheses(s.fixes).join("; ")}`);
  if (s.rejections.length) out.push(`  done claims: ${s.claims}, rejected ${s.rejections.length}: ${s.rejections.map((r) => `${when(r.at)} ${clip(r.note, 100)}`).join(" | ")}`);
  for (const w of s.warnings) out.push(`  WARN ${w}`);
  if (!s.attempts.length && !s.fixes.length && !s.rejections.length) out.push("  no fix attempts, tagged fixes or rejected claims on record");
  return out;
};

export const formatSignals = (label: string, list: readonly LaneSignals[]): string =>
  [`SIGNALS ${label}: ${formatStats(areaStats(list))}`, ...list.flatMap((s) => formatLane(s))].join("\n");

// The "Past signals" section dori launch adds to a new lane's brief: a few lines per earlier lane in the same area.
export const pastSignalsSection = (label: string, list: readonly LaneSignals[], limit: number): string | undefined => {
  // the lanes with the most failure on record first (a lane with one re-send says little), newest first among equals
  const weight = (s: LaneSignals) => 5 * (s.warnings.length + s.rejections.length) + 3 * (s.attempts.length + s.fixes.length) + (s.rootCause ? 3 : 0) + (s.sends + s.nudges) / 10;
  const shown = list.filter(hasSignals).sort((a, b) => weight(b) - weight(a)).slice(0, limit);
  if (!shown.length) return undefined;
  const lines = [
    "",
    "## Past signals (written by dori launch)",
    `Earlier lanes in this area (${label}): what they tried and how it went. Do not repeat a fix that already failed; after two failed patches on one metric, look for the root cause instead. \`dori signals --lane <key>\` shows the full record.`,
    `- Area: ${formatStats(areaStats(list))}.`,
  ];
  for (const s of shown) {
    const bits = [
      ...(s.attempts.length ? [`attempts 1-${s.attempts.at(-1)?.n} (latest: ${clip((s.attempts.at(-1)?.first ?? s.attempts[0]?.first)?.text ?? "", 90)})`] : []),
      ...(s.rootCause ? [`then a root-cause hunt (${clip(s.rootCause.text, 90)})`] : []),
      ...(s.fixes.length ? [`fixes ${hypotheses(s.fixes).join("; ")}`] : []),
      ...(s.rejections.length ? [`${s.rejections.length} done claim(s) rejected (${clip(s.rejections.at(-1)?.note ?? "", 90)})`] : []),
      `${s.sends} re-sends, ${s.nudges} nudges`,
    ];
    lines.push(`- ${s.lane.key} (${s.outcome}): ${bits.join("; ")}`);
    for (const w of s.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
};

// For dori fix-attempt, before it records: every hypothesis already tried on this metric in the area, by lane.
export const priorFixLines = (list: readonly LaneSignals[], key: string, metric: string): string[] => {
  const lines = list.flatMap((s) => {
    const on = s.fixes.filter((f) => f.metric === metric);
    return on.length ? [`PRIOR_FIX ${s.lane.key} ${hypotheses(on).join("; ")}`] : [];
  });
  if (!lines.length) lines.push(`PRIOR_FIX none on "${metric}" in this area`);
  const self = list.find((s) => s.lane.key === key);
  if (self?.attempts.length) lines.push(`PRIOR_ATTEMPTS ${key} numbered attempts 1-${self.attempts.at(-1)?.n}, root-cause switch: ${self.rootCause ? when(self.rootCause.at) : "none"}`);
  return lines;
};

export const logSources = (config: DoriConfig): LogSources => ({ leadSessions: config.scorecard.leadSessions, lanesLog: config.scorecard.lanesLog, sendPattern: config.scorecard.leadSendPattern });

// Signals for the lanes in an area, newest first. Session files older than the oldest lane are not read.
export const areaSignals = async (lanes: readonly Lane[], q: AreaQuery, config: DoriConfig): Promise<LaneSignals[]> => {
  const picked = lanes.filter((l) => inArea(l, q)).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  if (!picked.length) return [];
  const since = Math.min(...picked.map((l) => Date.parse(l.openedAt) || 0));
  const logs = await readLaneLogs(picked, logSources(config), since);
  return picked.map((l) => laneSignals(l, logs.get(l.key), config));
};

export const areaLabel = (q: AreaQuery): string =>
  [q.lane ? `lane ${q.lane}` : "", q.cwd ? `cwd ${q.cwd.replace(homedir(), "~")}` : "", q.tags?.length ? `tag ${q.tags.join(",")}` : ""].filter(Boolean).join(" / ");
