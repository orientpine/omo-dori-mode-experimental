import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

// A lane's work thread: <adapter>:<id>, or "none" for a lane without one. Discord ids are numeric snowflakes.
export const NO_THREAD = "none";

export const threadRefProblem = (ref: string): string | undefined => {
  const m = /^([a-z][a-z0-9_-]*):(.*)$/.exec(ref);
  if (!m) return `thread "${ref}" is not <adapter>:<id>`;
  const [, adapter, id = ""] = m;
  if (!id) return `thread "${ref}" has an empty id`;
  if (/\s/.test(id)) return `thread "${ref}" has whitespace in its id`;
  if (adapter === "discord" && !/^\d{5,25}$/.test(id)) return `thread "${ref}" is not a Discord thread id (digits only)`;
  return undefined;
};

// true when the lane has a thread that a threadDone hook can act on
export const hasThread = (lane: Lane): boolean => typeof lane.thread === "string" && lane.thread !== NO_THREAD && threadRefProblem(lane.thread) === undefined;

// "paused": the lead parked the lane (e.g. it waits on the owner); no sweep nudges, posts for, or flags it until resumed.
export type LaneStatus = "working" | "done-claimed" | "verified-done" | "not-done" | "paused" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };
// one fix attempt on a failing metric, from a tagged [REPORT] or from the lead (dori fix-attempt)
// improved: the attempt before this one moved the metric, so the stuck count (dori fix-attempt --improved) starts again here
export type FixAttempt = { readonly at: string; readonly metric: string; readonly hypothesis: string; readonly via: "report" | "lead"; readonly improved?: boolean };
// a review of a lane's plan by another model family (dori challenge); file holds the review
export type ChallengeRecord = { readonly at: string; readonly model: string; readonly plan: string; readonly file: string };
// one dori fork-explore run: its saved result table
export type ExplorationRecord = { readonly at: string; readonly metric: string; readonly branches: number; readonly file: string };
// the last ulw research text sent to the lane: sentAt (ms) and probe (its start) find it in the lane's session log;
// result is set once the check decided (RESEARCH_STARTED or RESEARCH_NOT_STARTED)
// signal: the failed attempts on that metric when it was sent (the stuck count at rung 3)
export type ResearchSent = { readonly at: string; readonly sentAt: number; readonly probe: string; readonly metric: string; readonly signal: number; readonly result?: "started" | "not-started" };
// the rung one metric (or "@context", the owner check) reached on the stuck ladder, at count n, in the session of pane;
// report: for "@context", the report the last finding rested on (one report moves the rung once)
export type StuckMark = { readonly rung: number; readonly n: number; readonly at: string; readonly pane?: string; readonly report?: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  // topic tags (dori launch --tag); the key's first word (rl in rl-e7) is always a tag too
  readonly tags?: readonly string[];
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly pausedFrom?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  readonly lastReport?: string;
  readonly fixes?: readonly FixAttempt[];
  // the owner's goal in their own words (dori launch --goal), and the lane's latest stated direction (dori intent-check)
  readonly goal?: string;
  readonly direction?: { readonly at: string; readonly text: string; readonly next?: string };
  // big steps this lane must put through dori challenge first (dori launch --challenge-before)
  readonly challengeBefore?: readonly string[];
  // the lane's sessions start without config launchEnv (dori launch|adopt --use-gpu, dori set-gpu): launch, handover, restart
  readonly useGpu?: boolean;
  readonly challenges?: readonly ChallengeRecord[];
  readonly explorations?: readonly ExplorationRecord[];
  readonly research?: ResearchSent;
  readonly blocked?: string;
  readonly idleSince?: number;
  // the last ROLLOVER_DUE freshness gave for a measured threshold (context, compactions, age): one per pane, so a lane's new
  // session can get its own (auto: written by older versions, not read)
  readonly rolloverDue?: { readonly pane: string; readonly at: string; readonly crossed: readonly string[]; readonly auto?: boolean };
  // untagged repeats freshness inferred in the current session: cycles per metric (the inferred half of the stuck count) and
  // when the reports last showed each metric PASS (the tagged half counts only attempts after that), and the count at the
  // last --improved of a metric (baseline: only cycles after it count)
  // cycles: when each counted cycle's attempt was made, per metric, so the ladder sees what the lane did after them
  readonly inferred?: { readonly at: string; readonly counts: Readonly<Record<string, number>>; readonly cycles?: Readonly<Record<string, readonly string[]>>; readonly passedAt?: Readonly<Record<string, string>>; readonly baseline?: Readonly<Record<string, number>>; readonly lastEventAt?: string };
  // the stuck ladder: the rung each metric reached, so each rung change alerts once
  readonly stuck?: Readonly<Record<string, StuckMark>>;
  // the last dori owner-check: when, up to which report, how many today, by which reviewer, what it found (finding: the first
  // finding, for the re-read the lead may send)
  readonly ownerCheck?: { readonly at: string; readonly lastReportAt: string; readonly day: string; readonly today: number; readonly model: string; readonly kinds: readonly string[]; readonly finding?: string; readonly rereadAt?: string };
  readonly receipt?: unknown;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? ((await f.json()) as Lane) : null;
  }

  // temp file + rename so a concurrent reader never sees a half-written lane
  async write(lane: Lane): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }

  // Sweeps change only their own fields: merge them onto the lane as it is now, so a claim or an objection written
  // by another process since the sweep read the lane is kept.
  async patch(key: string, fields: Partial<Lane>): Promise<void> {
    const fresh = await this.read(key);
    if (fresh) await this.write({ ...fresh, ...fields });
  }

  async list(): Promise<Lane[]> {
    mkdirSync(this.dir, { recursive: true });
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) lanes.push((await Bun.file(join(this.dir, f)).json()) as Lane);
    return lanes;
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}
