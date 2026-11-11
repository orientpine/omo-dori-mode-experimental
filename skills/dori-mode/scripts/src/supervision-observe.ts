import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paneTranscript } from "./panes.ts";
import type { Lane, LaneStatus } from "./registry.ts";
import type { ProgressState } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";

export const BUDGET_NAMES = ["wallMinutes", "tokens", "costUsd"] as const;
export type BudgetName = (typeof BUDGET_NAMES)[number];
// a number is a ceiling, null turns it off; an absent field leaves the one below it (defaults < lanes.<key> < the lane's own)
export type BudgetLimits = { readonly wallMinutes?: number | null; readonly tokens?: number | null; readonly costUsd?: number | null };
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
// session: the sessions the reading summed (no usageArgv)
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly session?: string;
  readonly final?: true;
};
export type SessionUsage = { readonly session: string; readonly tokens: number; readonly costUsd: number | null };

export type SupervisionSettings = {
  readonly defaults: BudgetLimits;
  readonly lanes: Readonly<Record<string, BudgetLimits>>;
  // minutes a Working/Running timer must grow from one start, and minutes with no report, checkpoint or file change (0: off)
  readonly hungAfterMinutes: number;
  readonly staleAfterMinutes: number;
  // argv printing {"tokens": N, "costUsd": N} cumulative for {key} {session} {cwd}; empty: the lane's omo transcript
  readonly usageArgv: readonly string[];
  // argv run once at close with {key} {session} {tokens} {costUsd} {at} {closeKey}; empty: none
  readonly recordCostArgv: readonly string[];
  readonly activityPaths: readonly string[];
  readonly gitActivity: boolean;
};

export const defaultSupervision = (): SupervisionSettings => ({
  defaults: { wallMinutes: null, tokens: null, costUsd: null },
  lanes: {},
  hungAfterMinutes: 20,
  staleAfterMinutes: 20,
  usageArgv: [],
  recordCostArgv: [],
  activityPaths: [],
  gitActivity: true,
});

const SETTING_NAMES = Object.keys(defaultSupervision());

const limitsProblem = (where: string, value: unknown): string | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object of ${BUDGET_NAMES.join(", ")}`;
  for (const [name, v] of Object.entries(value)) {
    if (!(BUDGET_NAMES as readonly string[]).includes(name)) return `${where}.${name} is not a ceiling (${BUDGET_NAMES.join(", ")})`;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${where}.${name} must be a number >= 0 or null, not ${JSON.stringify(v)}`;
  }
  return undefined;
};

// The supervision entry of a config file as written: a misspelt name or a bad ceiling is refused, never dropped, so a typo
// cannot turn a ceiling off (upstream b68a8be, d4a349b).
export const supervisionProblem = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "supervision must be an object";
  for (const [name, v] of Object.entries(raw)) {
    const where = `supervision.${name}`;
    if (!SETTING_NAMES.includes(name)) return `${where} is not a supervision setting (${SETTING_NAMES.join(", ")})`;
    if (name === "defaults") {
      const p = limitsProblem(where, v);
      if (p) return p;
    } else if (name === "lanes") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return `${where} must map lane keys to ceilings`;
      for (const [key, limits] of Object.entries(v)) {
        const p = limitsProblem(`${where}.${key}`, limits);
        if (p) return p;
      }
    } else if (name === "hungAfterMinutes" || name === "staleAfterMinutes") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${where} must be a number >= 0 (0: off), not ${JSON.stringify(v)}`;
    } else if (name === "gitActivity") {
      if (typeof v !== "boolean") return `${where} must be true or false`;
    } else if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return `${where} must be a list of strings`;
  }
  return undefined;
};

const defined = (limits: BudgetLimits | undefined): BudgetLimits =>
  Object.fromEntries(Object.entries(limits ?? {}).filter(([, v]) => v !== undefined)) as BudgetLimits;

// The ceilings in force for a lane: defaults, then supervision.lanes.<key>, then the lane's own (launch flags, dori caps).
export const laneLimits = (settings: SupervisionSettings, lane: Pick<Lane, "key" | "budget">): Required<{ [K in BudgetName]: number | null }> => ({
  wallMinutes: null, tokens: null, costUsd: null,
  ...defined(settings.defaults), ...defined(settings.lanes[lane.key]), ...defined(lane.budget),
}) as Required<{ [K in BudgetName]: number | null }>;

// Match only an explicit duration on a visible Working/Running line (omo: "── • Running bash (2m 5s • esc to interrupt)").
// step is the smallest unit shown, in seconds: "25m" is rounded to the minute, so two readings can place the same call's
// start up to a minute apart. Ported unchanged from upstream.
export const workingTimer = (screen: string): { kind: string; seconds: number; step: number } | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds = clock[3] === undefined ? Number(clock[1]) * 60 + Number(clock[2]) :
        Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length) return { kind, seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0), step: Math.min(...parts.map((match) => unit(match[2]))) };
  }
  return null;
};

// What an omo session spent since the lane opened: the assistant turns' usage.totalTokens and usage.cost.total. A turn
// without a cost leaves the cost unknown (null), never zero.
export const transcriptUsage = (text: string, since: string): { tokens: number; costUsd: number | null } => {
  let tokens = 0;
  let cost: number | null = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let e: { timestamp?: string; message?: { role?: string; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } };
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line being written
    }
    if (e.message?.role !== "assistant" || !e.message.usage || (e.timestamp ?? "") < since) continue;
    const t = e.message.usage.totalTokens;
    if (typeof t === "number" && Number.isFinite(t)) tokens += t;
    const c = e.message.usage.cost?.total;
    cost = cost !== null && typeof c === "number" && Number.isFinite(c) ? cost + c : null;
  }
  return { tokens, costUsd: cost };
};

// The default usage source: the omo transcripts of every session the lane had (lane.priorSessions, then lane.session),
// found by id anywhere under the sessions directory (ids are unique; a lane's sessions may sit under its written cwd, its
// real path, or the pane's own cwd for an adopted lane). A lane with no recorded session reads the transcript of the
// session in its pane. Unknown, never smaller: a session whose transcript is not found, or a move whose new session is
// not known yet (priorSessions but no session), makes the usage unknown.
export const laneSessionUsage = (run: Runner, sessionsDir: string) => async (lane: Lane): Promise<SessionUsage | null> => {
  const ids = [...new Set([...(lane.priorSessions ?? []), ...(lane.session ? [lane.session] : [])])];
  if (lane.priorSessions?.length && !lane.session) return null;
  if (ids.length) {
    const files = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      try {
        return readdirSync(join(sessionsDir, d.name)).filter((n) => n.endsWith(".jsonl")).map((n) => join(sessionsDir, d.name, n));
      } catch {
        return [];
      }
    });
    let tokens = 0;
    let costUsd: number | null = 0;
    for (const id of ids) {
      const file = files.find((f) => f.endsWith(`_${id}.jsonl`));
      if (!file) return null;
      const one = transcriptUsage(readFileSync(file, "utf8"), lane.openedAt);
      tokens += one.tokens;
      costUsd = costUsd === null || one.costUsd === null ? null : costUsd + one.costUsd;
    }
    return { session: ids.join(","), tokens, costUsd };
  }
  const path = lane.pane ? await paneTranscript(run, sessionsDir, lane.pane) : undefined;
  if (!path || !existsSync(path)) return null;
  return { session: path, ...transcriptUsage(readFileSync(path, "utf8"), lane.openedAt) };
};

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  // tells the lead; true once it arrived. False (or a throw) keeps the alert unsent, so the next sweep sends it again.
  readonly alert?: (lane: Lane, message: string) => boolean | Promise<boolean>;
  // the lane's current session usage when no usageArgv is set
  readonly sessionUsage?: (lane: Lane) => Promise<SessionUsage | null>;
};

export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state?: LaneStatus | ProgressState;
  // alerts new since the last sweep, and those of them the lead did not get (sent again next sweep)
  readonly alerts: readonly string[];
  readonly undelivered: readonly string[];
  readonly capped: readonly string[];
  readonly hung: boolean;
  readonly usage: UsageSnapshot | null;
  // set when the saved observation could not be read and the sweep started over
  readonly reset?: string;
};

export const HUNG_MESSAGE = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
