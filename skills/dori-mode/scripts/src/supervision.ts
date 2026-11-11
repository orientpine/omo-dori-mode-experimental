// Lane caps (wall minutes, tokens, cost), hung calls and the cost record, after dori-superagent #61.
// Launched jsonl-v1 lanes use the #30 report journal; adopted and legacy lanes keep this fork's registry/freshness path.
// Every alert goes to the lead once per change. Nothing stops, closes or types into the lane.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CheckpointError, Checkpoints, takeLock } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { type Lane, statusOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import { type BudgetName, defaultSupervision, HUNG_MESSAGE, laneLimits, type SupervisionDeps, type SupervisionResult, type SupervisionSettings, type Usage, type UsageSnapshot, workingTimer } from "./supervision-observe.ts";

import { ACTIVITY_FILES, type Observation } from "./supervision-state.ts";

export * from "./supervision-observe.ts";

// Another close holds this lane's cost record; that close finishes the lane (pane, worktrees, registry).
export class CostRecordBusy extends Error {
  override readonly name = "CostRecordBusy";
}

export class Supervision {
  readonly checkpoints: Checkpoints; readonly journals: Reports;
  constructor(readonly deps: SupervisionDeps, readonly settings: SupervisionSettings = defaultSupervision()) {
    this.checkpoints = new Checkpoints(deps.stateDir); this.journals = new Reports(deps.stateDir);
  }

  private dir(key: string): string {
    return dirname(this.checkpoints.path(key));
  }

  private costPath(key: string): string {
    return join(this.dir(key), "cost.jsonl");
  }

  private readings(key: string): UsageSnapshot[] {
    const path = this.costPath(key);
    if (!existsSync(path)) return [];
    // A line torn by a crash mid-append is skipped, not fatal: the readings are a record, and one bad line must not stop
    // every later sweep and the close from reading the rest.
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try {
        const v = JSON.parse(l) as UsageSnapshot;
        return v && typeof v === "object" && v.key ? [v] : [];
      } catch {
        return [];
      }
    });
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    // after a line torn by a crash (no newline at the end) the reading starts its own line
    const torn = existsSync(path) && statSync(path).size > 0 && !readFileSync(path, "utf8").endsWith("\n");
    appendFileSync(path, `${torn ? "\n" : ""}${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  // Cumulative usage: the usageArgv hook's reading, else the lane's current omo session plus the last reading of each
  // earlier session of this lane (a handover moves it to a new transcript). Unknown stays null, never 0.
  private async usage(lane: Lane, now: number, persist: boolean): Promise<UsageSnapshot> {
    const at = new Date(now).toISOString();
    if (this.settings.usageArgv.length) {
      let usage: Usage = { tokens: null, costUsd: null };
      const result = await this.deps.run(fill(this.settings.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }), { ...(lane.cwd ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 });
      if (result.code === 0) {
        try {
          const value: unknown = JSON.parse(result.out);
          const metric = (name: "tokens" | "costUsd"): number | null => {
            const n = typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : null;
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
          };
          usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      const snapshot: UsageSnapshot = { key: lane.key, at, ...usage };
      if (persist) this.record(snapshot);
      return snapshot;
    }
    const current = await (this.deps.sessionUsage?.(lane) ?? Promise.resolve(null));
    const snapshot: UsageSnapshot = { key: lane.key, at, tokens: current?.tokens ?? null, costUsd: current?.costUsd ?? null, ...(current ? { session: current.session } : {}) };
    const last = this.readings(lane.key).at(-1);
    if (persist && current && !(last && last.tokens === snapshot.tokens && last.costUsd === snapshot.costUsd && last.session === snapshot.session)) this.record(snapshot);
    return snapshot;
  }

  private async activity(lane: Lane): Promise<string> {
    // the paths configured by hand: always looked at, and through a symlink (a latest.log pointing at a growing log)
    const explicit = new Set([...this.settings.activityPaths, ...(lane.activityPaths ?? [])].map((path) => resolve(lane.cwd ?? ".", path)));
    const paths = new Set<string>();
    const changes: string[] = [];
    // git prints the changed paths relative to the repository's top, not to the lane's cwd (a lane in a subdirectory)
    const top = this.settings.gitActivity && lane.cwd ? (await this.deps.run(["git", "-C", lane.cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 })) : undefined;
    if (lane.cwd && top?.code === 0 && top.out.trim()) {
      const result = await this.deps.run(["git", "-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeoutMs: 10_000, preserveOutput: true });
      if (result.code === 0) {
        // git prints real paths: compare them with the cwd's real path (a symlinked cwd), else every change looks outside it
        let cwdReal = resolve(lane.cwd);
        try {
          cwdReal = realpathSync(lane.cwd);
        } catch {
          // a cwd that is gone keeps its written path
        }
        const entries = result.out.split("\0");
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (!entry) continue;
          const path = resolve(top.out.trim(), entry.slice(3));
          const rel = relative(cwdReal, path);
          // Dependency churn and paths outside the lane's cwd are not the lane's progress.
          if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.split("/").includes("node_modules")) {
            paths.add(path);
            changes.push(entry);
          }
          if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
        }
      }
    }
    // every untracked file is listed (a file written inside an untracked directory is progress); at most ACTIVITY_FILES
    // are looked at, so a huge untracked tree does not make each sweep slow
    const files = [...[...explicit].sort(), ...[...paths].filter((path) => !explicit.has(path)).sort()].slice(0, ACTIVITY_FILES).map((path) => {
      try {
        const stat = lstatSync(path);
        const own = [path, stat.mtimeMs, stat.ctimeMs, stat.size];
        if (!explicit.has(path) || !stat.isSymbolicLink()) return own;
        // the link's own metadata (a retarget counts) and its target's (writes through the link count); a dangling link is null
        const target = statSync(path, { throwIfNoEntry: false });
        return [...own, target ? [target.mtimeMs, target.ctimeMs, target.size] : null];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [path, null];
      }
    });
    return JSON.stringify({ report: lane.reportProtocol === "jsonl-v1" ? this.journals.read(lane.key)?.lastReport ?? null : lane.lastReport ?? null, checkpoint: this.checkpoints.read(lane.key).at(-1) ?? null, files, changes: changes.sort() });
  }

  // One look at a working lane: its ceilings, a hung call on its screen. Each alert reaches the lead once per change.
  async sweep(lane: Lane, screen: string): Promise<SupervisionResult> {
    // a lane told "not done" keeps working, so it is supervised like a working one; paused and finished lanes are not
    if (!["working", "not-done"].includes(statusOf(lane)) || !lane.pane) return { enabled: false, alerts: [], undelivered: [], capped: [], hung: false, usage: null };
    const now = this.deps.clock.now();
    const path = join(this.dir(lane.key), "supervision.json");
    // The observation is a cache of the last sweep: one that cannot be read (a crash mid-write, an edit) is started over,
    // and said once, instead of turning this lane's supervision off for good.
    let previous: Observation | null = null;
    let reset: string | undefined;
    if (existsSync(path)) {
      try {
        previous = JSON.parse(readFileSync(path, "utf8")) as Observation;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        reset = `${path} could not be read (${error.message}); this lane's supervision started over`;
      }
    }
    const activity = await this.activity(lane);
    const timer = workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const limits = laneLimits(this.settings, lane);
    const wantsUsage = typeof limits.tokens === "number" || typeof limits.costUsd === "number" || this.settings.usageArgv.length > 0;
    const usage = wantsUsage ? await this.usage(lane, now, true) : null;
    const capped: string[] = [];
    const exceeds = (name: BudgetName, actual: number | null): void => {
      const ceiling = limits[name];
      if (typeof ceiling === "number" && actual !== null && actual >= ceiling) capped.push(`${name} ceiling reached (${ceiling})`);
    };
    exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
    exceeds("tokens", usage?.tokens ?? null);
    exceeds("costUsd", usage?.costUsd ?? null);
    const hungAfter = this.settings.hungAfterMinutes;
    const hung = hungAfter > 0 && previous !== null && timer !== null && previous.timer !== null &&
      timer.kind === previous.timerKind && timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
      // computed origin by up to one unit, plus sweep jitter.
      Math.abs((now - timer.seconds * 1000) - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
      timer.seconds >= hungAfter * 60 &&
      now - activeAt >= this.settings.staleAfterMinutes * 60_000;
    const unavailable = (["tokens", "costUsd"] as const)
      .filter((name) => typeof limits[name] === "number" && (usage?.[name] ?? null) === null)
      .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
    const progress = lane.reportProtocol === "jsonl-v1" ? this.journals.read(lane.key) : null;
    const terminal = progress?.state === "done" || progress?.state === "halted";
    // caps and a hung call are told apart, each once: a lane already told about its cap that then hangs is told that too
    const alerts = terminal ? [] : [...capped, ...(hung ? [HUNG_MESSAGE] : []), ...unavailable];
    const fresh = alerts.filter((message) => !previous?.alerts.includes(message));
    if (lane.reportProtocol === "jsonl-v1") {
      const blocker = capped.join("; ");
      if (!terminal && capped.length && progress?.lastReport?.text !== blocker) this.journals.report(lane.key, "blocker", blocker, now);
      else if (!terminal && hung && (!progress || progress.state === "running")) this.journals.append({ type: "activity", key: lane.key, at: new Date(now).toISOString(), state: "stalled", text: HUNG_MESSAGE });
      else if (!alerts.length && progress?.state === "stalled" && previous !== null && activity !== previous.activity) this.journals.append({ type: "activity", key: lane.key, at: new Date(now).toISOString(), state: "running", text: "Fresh report, checkpoint, or file activity observed" });
    }
    // Deliver before saving, so only alerts that reached the lead count as sent; a failed one is sent again next sweep.
    const undelivered: string[] = [];
    for (const message of fresh) {
      try {
        if ((await this.deps.alert?.(lane, message)) === false) undelivered.push(message);
      } catch {
        undelivered.push(message);
      }
    }
    const observation: Observation = { at: now, timer: timer?.seconds ?? null, timerKind: timer?.kind ?? null, activity: lane.reportProtocol === "jsonl-v1" ? await this.activity(lane) : activity, activeAt, alerts: alerts.filter((m) => !undelivered.includes(m)) };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, path);
    return { enabled: true, state: lane.reportProtocol === "jsonl-v1" ? this.journals.read(lane.key)?.state ?? "running" : statusOf(lane), alerts: fresh, undelivered, capped, hung, usage, ...(reset ? { reset } : {}) };
  }

  // The lane's last usage reading at close. A close that already recorded its final reading (a retried or second close)
  // returns it and runs no hook, so a cost ledger gets each lane once; {closeKey} is the same on every attempt.
  // Two closes at once (the watcher and a manual close) take turns on a lock per lane; the second finds the first's final
  // reading and runs no hook.
  // A close that finds the lock taken throws CostRecordBusy: the other close owns the lane's teardown from here.
  async close(lane: Lane): Promise<UsageSnapshot> {
    mkdirSync(this.dir(lane.key), { recursive: true });
    let release: () => void;
    try {
      release = takeLock(join(this.dir(lane.key), "cost.lock"), this.deps.clock.now(), "cost record", lane.key);
    } catch (error) {
      // takeLock throws CheckpointError only when another holder has the lock; any other error is a real failure
      if (error instanceof CheckpointError) throw new CostRecordBusy(error.message);
      throw error;
    }
    try {
      return await this.closeLocked(lane);
    } finally {
      release();
    }
  }

  private async closeLocked(lane: Lane): Promise<UsageSnapshot> {
    const recorded = this.readings(lane.key).findLast((entry) => entry.final === true);
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now(), false);
    if (this.settings.recordCostArgv.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(fill(this.settings.recordCostArgv, {
        key: lane.key, session: lane.session ?? "", tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
        costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd), at: snapshot.at, closeKey: `${lane.key}@${lane.openedAt}`,
      }), { ...(lane.cwd ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 });
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err || result.out || `exit ${result.code}`}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
