import { existsSync } from "node:fs";

import { closeAoeSession, paneActivity } from "./aoe.ts";
import { type DoriConfig, fill } from "./config.ts";
import { hasThread, type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { sendVerified } from "./panes.ts";
import { checkDone, type SignalIo } from "./signals.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  // sets a discord:<id> work thread to done and archives it (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly markThreadDone?: (ref: string) => Promise<void>;
};

export class LaneStateError extends Error {}

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const at = iso(deps.clock);
  // A paused lane waits on a human, so its claim is recorded and announced but never closes it on a timer.
  if (statusOf(lane) === "paused") {
    await deps.registry.write({ ...lane, claim: { at, evidence, emitted: false }, history: [...(lane.history ?? []), { at, status: "paused", note: `done claimed while paused: ${evidence}` }] });
    if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, `[LEAD] done claim recorded for ${lane.key}, but the lane is paused, so it does not close automatically; the lead decides. Stay idle until then.`);
    return `LANE_DONE_CLAIMED_PAUSED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
  }
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }));
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

const pausedAt = (lane: Lane): string => lane.history?.findLast((h) => h.status === "paused" && h.note.startsWith("PAUSED:"))?.at ?? "";

// Parks a lane that waits on the owner: freshness, LANE_BLOCKED and dead-pane alerts skip it until it is resumed.
export const pauseLane = async (deps: FlowDeps, lane: Lane, reason: string): Promise<string> => {
  const from = statusOf(lane);
  if (from !== "working" && from !== "not-done") throw new LaneStateError(`lane ${lane.key} is ${from}; only a working or not-done lane can be paused`);
  await deps.registry.write(withStatus(lane, "paused", `PAUSED: ${reason}`, iso(deps.clock), { pausedFrom: from, blocked: undefined, idleSince: undefined }));
  return `LANE_PAUSED ${lane.key} (was ${from}) ${reason}`;
};

// Back to the status it had before the pause; the silence clock restarts now, so the first nudge comes a full interval later.
export const resumeLane = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (statusOf(lane) !== "paused") throw new LaneStateError(`lane ${lane.key} is ${statusOf(lane)}, not paused`);
  const to = lane.pausedFrom ?? "working";
  const { pausedFrom: _, ...rest } = lane;
  await deps.registry.write(withStatus(rest, to, "RESUMED", iso(deps.clock), { lastReplyAt: deps.clock.now() }));
  const out = [`LANE_RESUMED ${lane.key} ${to}`];
  if (lane.claim && lane.claim.at >= pausedAt(lane)) out.push(`NOTE ${lane.key} claimed done while paused (${lane.claim.evidence}); close it with dori close ${lane.key}, or object with dori object-done`);
  return out;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])) {
    if (!exists(wt)) continue;
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const cleanup: string[] = [];
  const warnings: string[] = [];
  const hook = deps.config.hooks.threadDone;
  if (hook && hasThread(lane)) {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  } else if (hook) {
    // a missing or broken thread ref would leave the work thread open without a word; say so
    warnings.push(`THREAD_MISSING ${lane.key} thread=${JSON.stringify(lane.thread ?? null)}; threadDone not run, close the thread by hand or set it with dori set-thread first`);
    cleanup.push("thread missing: threadDone not run");
  }
  if (deps.markThreadDone && hasThread(lane) && lane.thread.startsWith("discord:")) {
    const sharing = (await deps.registry.open()).filter((l) => l.key !== lane.key && l.thread === lane.thread).map((l) => l.key);
    if (sharing.length) cleanup.push(`thread left open: open lane ${sharing.join(", ")} uses it too`);
    else {
      try {
        await deps.markThreadDone(lane.thread);
        cleanup.push("thread set done and archived");
      } catch (e) {
        // the lane is finished either way; a thread that could not be renamed is the lead's to fix by hand
        const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        warnings.push(`THREAD_DONE_WARN ${lane.key} ${lane.thread}: ${why}`);
        cleanup.push(`thread not set done: ${why}`);
      }
    }
  }
  if (deps.config.backend === "aoe") {
    if (lane.pane) cleanup.push(await closeAoeSession(deps.run, lane.pane));
  } else if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  const root = lane.cwd ?? deps.config.defaultCwd;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, ...warnings, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string[]> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return [await objectDone(deps, lane, blocked)];
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return [await objectDone(deps, lane, failing)];
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const result = await closeLane(deps, verified, `Done: ${evidence}`);
  if (!result.closed) return [await objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, result.lines.filter((l) => l.startsWith("SIGNAL NOT")))];
  return [...result.lines.filter((l) => l.startsWith("THREAD_MISSING ") || l.startsWith("THREAD_DONE_WARN ")), `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`];
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (statusOf(listed) === "paused" && listed.claim && !listed.claim.emitted) {
      out.push(`LANE_DONE_CLAIMED_PAUSED ${listed.key} ${listed.pane ?? "-"} ${listed.claim.evidence}`);
      await deps.registry.patch(listed.key, { claim: { ...listed.claim, emitted: true } });
      continue;
    }
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = { ...lane, claim: { ...claim, emitted: true } };
      await deps.registry.write(lane);
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(...(await settle(deps, lane, claim.evidence)));
  }
  if (deps.config.backend === "aoe") out.push(...(await blockedTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN blocked check: ${String(e).slice(0, 200)}`])));
  return out;
};

// a turn that ended counts as stopped only after it stays ended this long (a goal wake or the next step may follow)
export const IDLE_SETTLE_MS = 45_000;

// LANE_BLOCKED once each time a working lane's agent stops for a human: aoe says waiting or error, an omo question is
// open, or the turn ended and stayed idle; never while the screen shows a running turn.
export const blockedTick = async (deps: FlowDeps): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => l.pane && (statusOf(l) === "working" || statusOf(l) === "not-done"));
  const activity = await paneActivity(deps.run, lanes.map((l) => l.pane ?? ""));
  const now = deps.clock.now();
  const out: string[] = [];
  for (const lane of lanes) {
    const act = activity.get(lane.pane ?? "");
    const idleSince = act === "idle" ? (lane.idleSince ?? now) : undefined;
    const blocked = act === "waiting" || act === "error" || act === "question" ? act : idleSince !== undefined && now - idleSince >= IDLE_SETTLE_MS ? "idle" : undefined;
    if (blocked === lane.blocked && idleSince === lane.idleSince) continue;
    await deps.registry.patch(lane.key, { blocked, idleSince });
    if (blocked && blocked !== lane.blocked) out.push(`LANE_BLOCKED ${lane.key} ${blocked} ${lane.pane}`);
  }
  return out;
};
