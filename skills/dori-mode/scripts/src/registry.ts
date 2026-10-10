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
export type FixAttempt = { readonly at: string; readonly metric: string; readonly hypothesis: string; readonly via: "report" | "lead" };

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
  readonly blocked?: string;
  readonly idleSince?: number;
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
