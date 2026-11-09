import { paneActivity } from "./aoe.ts";
import { autoturnTick } from "./autoturn.ts";
import { laneBackground } from "./background.ts";
import { laneDeathTick, laneSuspendTick } from "./lane-death.ts";
import { leadDownTick } from "./lead-down.ts";
import { leadInboxTick } from "./lead-inbox.ts";
import { leadLimitTick, limitResumeTick } from "./lead-limit.ts";
import { missedAnswersTick } from "./missed-answers.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";
import { omoPane, omoSession, sendVerified } from "./panes.ts";
import { pendingGoalTick } from "./pending-goal.ts";
import { checkDone } from "./done-signals.ts";
import { type FlowDeps, objectDone, reopenClaim } from "./done-flow-state.ts";
import { reopenedText, signalIo, windowMs } from "./done-flow-common.ts";
import { unpushedWork } from "./done-flow-worktrees.ts";
import { closeLane } from "./done-flow-close.ts";

export * from "./done-flow-state.ts";
export * from "./done-flow-worktrees.ts";
export { closeLessons, closeLane } from "./done-flow-close.ts";

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string[]> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return [await objectDone(deps, lane, blocked)];
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return [await objectDone(deps, lane, failing)];
  // the checks take seconds: a dori type that took the claim back meanwhile wins
  const fresh = await deps.registry.read(lane.key);
  if (fresh && statusOf(fresh) !== "done-claimed") return [];
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const note = `Done: ${evidence}`;
  // the claim's summary is read by closeLane itself; an explicit summary there would post even when the result is in the thread
  const result = await closeLane(deps, verified, note);
  if (!result.closed) {
    // a manual close got there first and finishes the lane: nothing to tell the lane
    const busy = result.lines.find((l) => l.startsWith("CLOSE_IN_PROGRESS "));
    if (busy) return [busy];
    const current = (await deps.registry.read(lane.key)) ?? verified;
    // no summary, or it did not go out: the lead gets the line, and the lane (still idle in its session) is told how to claim again
    const gate = result.lines.find((l) => l.startsWith("CLOSE_SUMMARY_MISSING ") || l.startsWith("CLOSE_SUMMARY_NOT_SENT "));
    if (gate) return [gate, await objectDone(deps, current, [`${gate.startsWith("CLOSE_SUMMARY_MISSING ") ? "no summary for the owner's thread" : "the summary did not reach the owner's thread"} (${gate.split(": ").slice(1).join(": ").slice(0, 300)}); claim again with dori claim-done ${lane.key} --evidence \"...\" --summary \"<2 to 5 plain lines in the owner's language: what changed, what is left, when it reaches where it is used>\"`])];
    return [await objectDone(deps, current, result.lines.filter((l) => l.startsWith("SIGNAL NOT")))];
  }
  return [...result.lines.filter((l) => l.startsWith("CLOSE_SUMMARY ") || l.startsWith("COST ") || l.startsWith("THREAD_MISSING ") || l.startsWith("THREAD_DONE_WARN ") || l.startsWith("THREAD_STATUS_WARN ")), `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`];
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
    if (lane.pane && omoPane(deps.config, lane.pane)) {
      const reopened = await claimTurn(deps, lane, lane.claim ?? claim);
      if (reopened) {
        out.push(reopened);
        continue;
      }
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(...(await settle(deps, (await deps.registry.read(lane.key)) ?? lane, claim.evidence)));
  }
  out.push(...(await pendingGoalTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN pending goal check: ${String(e).slice(0, 200)}`])));
  if (omoSession(deps.config)) {
    out.push(...(await blockedTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN blocked check: ${String(e).slice(0, 200)}`])));
    out.push(...(await autoturnTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN autoturn check: ${String(e).slice(0, 200)}`])));
    out.push(...(await missedAnswersTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN missed answer check: ${String(e).slice(0, 200)}`])));
    out.push(...(await leadDownTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lead down check: ${String(e).slice(0, 200)}`])));
    out.push(...(await laneDeathTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lane death check: ${String(e).slice(0, 200)}`])));
    out.push(...(await laneSuspendTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lane suspend check: ${String(e).slice(0, 200)}`])));
    out.push(...(await leadLimitTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lead limit check: ${String(e).slice(0, 200)}`])));
    out.push(...(await leadInboxTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lead inbox check: ${String(e).slice(0, 200)}`])));
    out.push(...(await limitResumeTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN limit resume check: ${String(e).slice(0, 200)}`])));
  }
  return out;
};

// a turn that ended counts as stopped only after it stays ended this long (a goal wake or the next step may follow)
export const IDLE_SETTLE_MS = 45_000;

// A claimed lane answers the claim's [LEAD] line and may get a goal wake, both within IDLE_SETTLE_MS of going idle. Once it
// stayed idle that long, a main turn running again (omo's busy mark) is new work: a text typed some other way than dori
// type, a background result. The claim is taken back and the lane told. A turn before that only restarts the idle clock.
const claimTurn = async (deps: FlowDeps, lane: Lane, claim: NonNullable<Lane["claim"]>): Promise<string | undefined> => {
  const pane = lane.pane ?? "";
  const act = (await paneActivity(deps.run, [pane])).get(pane);
  const now = deps.clock.now();
  if (act === "idle") {
    if (claim.idleAt === undefined) await deps.registry.patch(lane.key, { claim: { ...claim, idleAt: now } });
    return undefined;
  }
  if (act !== "busy" || claim.idleAt === undefined) return undefined;
  if (now - claim.idleAt < IDLE_SETTLE_MS) {
    await deps.registry.patch(lane.key, { claim: { ...claim, idleAt: undefined } });
    return undefined;
  }
  const why = `the lane ran a new turn after it sat idle since ${new Date(claim.idleAt).toISOString()}`;
  const line = await reopenClaim(deps, lane, why);
  await sendVerified(deps.run, deps.clock, deps.config, pane, reopenedText(lane.key, why));
  return line;
};

// LANE_BLOCKED once each time a working lane's agent stops for a human: aoe says waiting or error, an omo question is
// open, or the turn ended and stayed idle; never while the screen shows a running turn. An idle lane whose session still
// waits on background work it started (a detached eval cell, a background bash session or task, a monitor) is BG_WAITING
// instead, a quiet watch-log line, until that work ends or the lane has been idle for blockedWaitMin; work started more
// than blockedWaitMin before the lane went idle (a server or watcher left running) does not count. A job that runs
// longer than an hour is not a human block by itself: on 2026-11-02 pingpong-analytics' long bash_19 and bash_21 aged out of
// "started within the last hour" and the lane was LANE_BLOCKED idle three times while they ran.
export const blockedTick = async (deps: FlowDeps): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => l.pane && (statusOf(l) === "working" || statusOf(l) === "not-done"));
  const activity = await paneActivity(deps.run, lanes.map((l) => l.pane ?? ""));
  const now = deps.clock.now();
  const out: string[] = [];
  for (const lane of lanes) {
    const act = activity.get(lane.pane ?? "");
    const idleSince = act === "idle" ? (lane.idleSince ?? now) : undefined;
    let blocked = act === "waiting" || act === "error" || act === "question" ? act : idleSince !== undefined && now - idleSince >= IDLE_SETTLE_MS ? "idle" : undefined;
    let waitingOn: string | undefined;
    const waitMs = deps.config.blockedWaitMin * 60_000;
    if (blocked === "idle" && lane.blocked !== "idle" && idleSince !== undefined && now - idleSince < waitMs) {
      // an end that landed within the settle time may not have woken the lane yet; it counts once the lane stayed idle after it
      const jobs = await laneBackground(deps.run, deps.config.sessionsDir, lane.pane ?? "", lane.cwd ?? "", now - IDLE_SETTLE_MS, idleSince - waitMs).catch((e: unknown) => {
        out.push(`LANE_WATCH_WARN background check ${lane.key}: ${String(e).slice(0, 160)}`);
        return undefined;
      });
      if (jobs?.length) {
        blocked = undefined;
        waitingOn = jobs.map((j) => `${j.kind}:${j.id}`).join(",");
      }
    }
    if (blocked === lane.blocked && idleSince === lane.idleSince && waitingOn === lane.waitingOn) continue;
    await deps.registry.patch(lane.key, { blocked, idleSince, waitingOn });
    if (waitingOn && waitingOn !== lane.waitingOn) out.push(`BG_WAITING ${lane.key} ${waitingOn} ${lane.pane}`);
    if (blocked && blocked !== lane.blocked) out.push(`LANE_BLOCKED ${lane.key} ${blocked} ${lane.pane}`);
  }
  return out;
};
