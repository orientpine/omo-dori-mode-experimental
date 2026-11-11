import { type GoalAct, goalCommand, type GoalRead, liveSession } from "./goal.ts";
import { paneLife } from "./aoe.ts";
import type { DoriConfig } from "./config.ts";
import type { Question } from "./messenger/discord-cards.ts";
import { hasThread, type Lane, type Registry, statusOf, type ThreadPost, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { omoPane, sendVerified, submitToPane } from "./panes.ts";
import type { Submitted } from "./submit.ts";
import { replacementOf } from "./frozen.ts";
import { watchLog } from "./watch-log.ts";
import type { SignalIo } from "./done-signals.ts";
import { reopenedText, windowMs } from "./done-flow-common.ts";
import { appendRollover, outcomeLine, outcomeMissing, pendingStuck, readRollovers } from "./rollover.ts";
import { Reports } from "./reports.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  // sets a discord:<id> work thread to done and archives it (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly markThreadDone?: (ref: string) => Promise<unknown>;
  // posts in a discord:<id> work thread without changing its status mark (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly postInThread?: (ref: string, text: string) => Promise<unknown>;
  // ids of the question cards still open in a work thread (cli reads the card store for discord:<id> threads)
  readonly openCards?: (ref: string) => readonly string[];
  // the question cards the owner answered (cli reads the card store); the watch re-types an answer its session missed
  readonly answeredCards?: () => readonly Question[];
  // immutable versions from answers.jsonl, including cards since reopened or resolved
  readonly answerHistory?: () => readonly Question[];
  // asks the thread status queue for a status on a discord:<id> work thread; the queue keeps it working while a lane there
  // still works. Resolves with the queue's outcome (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly requestThreadStatus?: (ref: string, status: "working" | "waiting") => Promise<string>;
  // a discord:<id> thread marked standing (dori thread set <ref> standing, threads.json): the place a kind of work always
  // lives, so its last lane closing leaves it waiting instead of done and archived (cli reads threads.json)
  readonly standingThread?: (ref: string) => boolean;
  // a lane put on an existing discord:<id> thread (dori launch --thread, adopt, set-thread) works there now: asks the queue
  // for working (unarchived, 🔄) and puts its threads.json record back if a done mark dropped it. Resolves with the
  // queue's outcome (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly reopenThread?: (ref: string, title: string) => Promise<string>;
  // posts the lead's own runaway or pause alert to the pair channel (the other Dori's inbox) and the owner's channel as
  // this Dori's bot, without mentions; one LEAD_ALERT_POSTED / LEAD_ALERT_WARN line per channel (cli wires leadAlertPoster)
  readonly postLeadAlert?: (text: string) => Promise<readonly string[]>;
  // the inbox the listener writes, the owner's user id and his channel: dori watch reads which owner messages wait for the
  // lead (lead-limit.ts; cli wires DORI_DISCORD_INBOX, DORI_DISCORD_OWNER, DORI_DISCORD_CHANNEL)
  readonly ownerInbox?: { readonly path: string; readonly ownerId: string; readonly ownerChannel: string };
  // posts one line as this Dori's bot in a channel or thread of the owner's and returns the message id (cli wires it when
  // DORI_DISCORD_TOKEN is set)
  readonly postOwner?: ((channel: string, text: string) => Promise<string>) | undefined;
  // opens a work thread named for a lane in this Dori's own channel and returns its ref (dori launch --thread new; cli wires it
  // when DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL are set)
  readonly openThread?: (title: string) => Promise<string>;
  // ids of channels that are not threads (this Dori's channel, the pair channel, watched channels): refused as --thread
  readonly channels?: readonly string[];
  // the omo goal of a pane's session (goal.ts sessionGoal reads its goal file when unset); tests set it
  readonly readGoal?: ((pane: string) => Promise<GoalRead>) | undefined;
};

export class LaneStateError extends Error {}
// the goal command was typed or could not be, and its effect was not read back: the lane is left as it was (exit 3)
export class GoalUnverifiedError extends Error {}

// A lane's result reaches its thread once. Lanes post it themselves (their briefs ask for a short line in the owner's
// thread) and the close posted the claim's summary there too, the same result twice within a minute (owner 2026-10-21
// 07:19 KST "지금 왜 두번씩 답변하는지"; 11 lanes on 2026-10-20, e.g. jev-recall-filter and cyto-ocr-merge). So dori send and
// dori thread record what a lane's own session posts in its work thread, and the newest such post made up to
// RESULT_POST_MS before the claim is taken as the result: the close then posts no summary.
export const RESULT_POST_MS = 30 * 60_000;
const KEEP_POSTS = 5;
const POST_TEXT = 120;

// Records a post made from pane in thread (a Discord id) on the open lane of that pane, when the thread is its work thread;
// returns the lane's key, or undefined when the post is not a lane's post in its own thread.
export const recordThreadPost = async (registry: Registry, pane: string, thread: string, id: string, text: string, at: string): Promise<string | undefined> => {
  if (!pane) return undefined;
  const lane = await registry.byPane(pane);
  if (!lane || lane.thread !== `discord:${thread}`) return undefined;
  const post: ThreadPost = { id, at, text: text.trim().slice(0, POST_TEXT) };
  await registry.patch(lane.key, { threadPosts: [...(lane.threadPosts ?? []), post].slice(-KEEP_POSTS) });
  return lane.key;
};

const resultPost = (lane: Lane, now: number): ThreadPost | undefined => lane.threadPosts?.findLast((p) => now - Date.parse(p.at) <= RESULT_POST_MS);

// rolloverOutcome: a lane moved to a new session for being stuck (rung 4) says in one line what it did differently after
// the move; resolved false when the move did not solve it (the lane is done another way)
export type ClaimOptions = { readonly posted?: string | undefined; readonly postSummary?: boolean; readonly rolloverOutcome?: { readonly line: string; readonly resolved: boolean } };

// The outcome of the lane's stuck rollover, kept in the rollover log next to it once the claim is recorded:
// ROLLOVER_OUTCOME_MISSING when the lane owes one and gave none (nothing is recorded), else what the claim output adds.
const claimOutcome = (deps: FlowDeps, lane: Lane, at: string, given: ClaimOptions["rolloverOutcome"]): { readonly missing?: string; readonly write: () => string } => {
  const pending = pendingStuck(readRollovers(deps.config.stateDir), lane.key);
  const line = given ? outcomeLine(given.line) : "";
  if (!pending) return { write: () => (line ? `\nROLLOVER_OUTCOME_SKIPPED ${lane.key}: no stuck rollover of this lane waits for a line` : "") };
  if (!line) return { missing: outcomeMissing(lane.key, pending), write: () => "" };
  const resolved = given?.resolved !== false;
  return {
    write: () => {
      appendRollover(deps.config.stateDir, { kind: "outcome", at, key: lane.key, rolloverAt: pending.at, resolved, line, by: "claim-done" });
      return `\nROLLOVER_OUTCOME ${lane.key} ${resolved ? "resolved" : "not resolved"} (rollover ${pending.at}): ${line}`;
    },
  };
};

// summary: what the owner's thread gets when the lane closes (dori claim-done --summary), kept with the claim; posted: the
// lane's result already in its thread (opts.posted, else its own post there in the last RESULT_POST_MS), so the close posts
// no summary; opts.postSummary: that post was not the result, post the summary anyway
export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string, summary?: string, opts: ClaimOptions = {}): Promise<string> => {
  const at = iso(deps.clock);
  const posted = opts.postSummary || !hasThread(lane) ? undefined : (opts.posted ?? resultPost(lane, deps.clock.now())?.id);
  const claim = { at, evidence, emitted: false, ...(summary?.trim() ? { summary: summary.trim() } : {}), ...(posted ? { posted } : {}) };
  const outcome = claimOutcome(deps, lane, at, opts.rolloverOutcome);
  if (outcome.missing) return outcome.missing;
  const postedLine = posted ? `\nRESULT_ALREADY_POSTED ${lane.key} ${posted}: the close posts no summary in the thread (the lane's result is there); --post-summary posts it anyway` : "";
  // A paused lane waits on a human, so its claim is recorded and announced but never closes it on a timer.
  if (statusOf(lane) === "paused") {
    await deps.registry.write({ ...lane, claim, history: [...(lane.history ?? []), { at, status: "paused", note: `done claimed while paused: ${evidence}` }] });
    if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] done claim recorded for ${lane.key}, but the lane is paused, so it does not close automatically; the lead decides. Stay idle until then.`);
    return `LANE_DONE_CLAIMED_PAUSED ${lane.key} ${lane.pane ?? "-"} ${evidence}${postedLine}${outcome.write()}`;
  }
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim }));
  const outcomeNote = outcome.write();
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}${postedLine}${outcomeNote}`;
};

// The lead often gives a lane new work right after it claimed done (the owner's feedback on its result). On 2026-10-31
// Moodori's dori-promo claimed at 07:16:55Z, the lead typed two new instructions into it at 07:19 and 07:22 (both
// SUBMITTED), the lane started on them, and the watch closed it at 07:22:29Z in the middle of that work: five minutes after
// the claim without an objection. The claim is now taken back when the lead types into the lane (dori type) or the lane
// runs a new turn after it sat idle: the lane is working again, without a timer, until it claims again.
export const reopenClaim = async (deps: FlowDeps, lane: Lane, why: string): Promise<string> => {
  const at = iso(deps.clock);
  if (lane.reportProtocol === "jsonl-v1") new Reports(deps.config.stateDir).append({ type: "activity", key: lane.key, at, state: "running", text: `REOPENED: ${why}` });
  await deps.registry.write(withStatus(lane, "working", `REOPENED: ${why}`, at, { claim: undefined, idleSince: undefined, blocked: undefined, lastReplyAt: deps.clock.now() }));
  return `LANE_CLAIM_REOPENED ${lane.key} ${lane.pane ?? "-"} ${why}`;
};

// Who closed a closed lane: the watch closes a claim it settled (verified-done just before closed), else dori close did.
export const closerOf = (lane: Lane): string => {
  const h = lane.history ?? [];
  const i = h.findLastIndex((e) => e.status === "closed");
  return h[i - 1]?.status === "verified-done" ? "the watch (automatic close after the done claim)" : "dori close (the lead)";
};

// dori type: a text the lead types into a lane. Into a done-claimed lane it is new work, so the claim is taken back first
// (LANE_CLAIM_REOPENED in the watch log, then the lane is told after the text). Into the pane of a closed lane nothing is
// typed: NOT_SUBMITTED <pane> LANE_IS_CLOSED <key> with when and who closed it, instead of the screen check's "no ❯
// prompt", which the lead read as a busy lane for 30 minutes (Moodori 2026-10-31 07:23Z). A gone or dead pane is named the
// same way by the screen check (PANE_GONE / PANE_DEAD).
export const typeIntoPane = async (deps: FlowDeps, pane: string, text: string): Promise<Submitted & { readonly pane: string; readonly notes: readonly string[] }> => {
  const log = (line: string) => watchLog(deps.config.watchLog, deps.clock, { source: "type", line });
  const notes: string[] = [];
  // a pane a handover froze forwards its text to the session that replaced it (submitToPane): no lane check here
  const forwarded = replacementOf(deps.config.stateDir, pane) !== undefined;
  const lane = forwarded ? null : await deps.registry.byPane(pane);
  if (!lane && !forwarded) {
    const closed = (await deps.registry.list()).filter((l) => l.pane === pane && statusOf(l) === "closed").sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? "")).at(-1);
    if (closed) {
      const gone = omoPane(deps.config, pane) && !(await paneLife(deps.run, pane)).live ? "; its pane is gone" : "";
      const reason = `LANE_IS_CLOSED ${closed.key} closed at ${closed.closedAt} by ${closerOf(closed)}${gone}: nothing was typed; no lane reads this pane, launch a new lane (dori launch) for new work`;
      log(`NOT_SUBMITTED ${pane} ${reason}`);
      return { status: "NOT_SUBMITTED", reason, pane, notes };
    }
  }
  const why = "the lead typed a new instruction into the lane (dori type)";
  if (lane && statusOf(lane) === "done-claimed") {
    const line = await reopenClaim(deps, lane, why);
    log(line);
    notes.push(line);
  }
  const r = await submitToPane(deps.run, deps.clock, deps.config, pane, text);
  if (notes.length && lane?.pane && r.status === "SUBMITTED") await sendVerified(deps.run, deps.clock, deps.config, r.pane, reopenedText(lane.key, why));
  return { ...r, notes };
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  if (lane.reportProtocol === "jsonl-v1") new Reports(deps.config.stateDir).append({ type: "activity", key: lane.key, at, state: "running", text: `NOT_DONE: ${reasons.join("; ")}` });
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

const pausedAt = (lane: Lane): string => lane.history?.findLast((h) => h.status === "paused" && h.note.startsWith("PAUSED:"))?.at ?? "";

// Parks a lane that waits on the owner: freshness, LANE_BLOCKED and dead-pane alerts skip it until it is resumed, and the
// omo goal of its session is paused first, read back, so it starts no turn on its own (goal.ts). A live session whose
// goal pause is not read back leaves the lane as it was (GoalUnverifiedError, PAUSE_UNVERIFIED).
export const pauseLane = async (deps: FlowDeps, lane: Lane, reason: string): Promise<string[]> => {
  const from = statusOf(lane);
  if (from !== "working" && from !== "not-done") throw new LaneStateError(`lane ${lane.key} is ${from}; only a working or not-done lane can be paused`);
  const goal = await goalLine(deps, lane, "pause");
  await deps.registry.write(withStatus(lane, "paused", `PAUSED: ${reason}`, iso(deps.clock), { pausedFrom: from, pausedGoal: goal?.changed || undefined, blocked: undefined, idleSince: undefined, waitingOn: undefined }));
  return [`LANE_PAUSED ${lane.key} (was ${from}) ${reason}`, ...(goal ? [goal.line] : [])];
};

// The goal step of pause and resume, for a lane with a pane dori drives omo in (panes.ts omoPane; another herdr agent's pane is left as before): its GOAL_* line and
// whether the goal was changed; undefined when there is nothing to do.
const goalLine = async (deps: FlowDeps, lane: Lane, act: GoalAct): Promise<{ readonly line: string; readonly changed: boolean } | undefined> => {
  const pane = lane.pane;
  if (!pane || !omoPane(deps.config, pane)) return undefined;
  const head = act === "pause" ? "PAUSE_UNVERIFIED" : "RESUME_UNVERIFIED";
  const dead = await liveSession(deps, pane);
  if (dead) return { line: `GOAL_SKIPPED ${lane.key} ${pane}: no live session (${dead}), nothing to ${act}`, changed: false };
  const r = await goalCommand(deps, pane, act);
  switch (r.outcome) {
    case "confirmed":
      return { line: `GOAL_${act === "pause" ? "PAUSED" : "RESUMED"} ${lane.key} ${pane}: ${r.detail}`, changed: true };
    case "no-goal":
    case "not-active":
      return { line: `GOAL_SKIPPED ${lane.key} ${pane}: ${r.detail}`, changed: false };
    case "unconfirmed":
    case "failed":
      throw new GoalUnverifiedError(`${head} ${lane.key} ${pane}: ${r.detail}; lane left ${statusOf(lane)}`);
  }
};

// Back to the status it had before the pause; the silence clock restarts now, so the first nudge comes a full interval later.
export const resumeLane = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (statusOf(lane) !== "paused") throw new LaneStateError(`lane ${lane.key} is ${statusOf(lane)}, not paused`);
  const to = lane.pausedFrom ?? "working";
  // only a goal this pause paused is resumed: one the agent or the owner paused stays paused
  const goal = lane.pausedGoal ? await goalLine(deps, lane, "resume") : undefined;
  const { pausedFrom: _, pausedGoal: __, ...rest } = lane;
  await deps.registry.write(withStatus(rest, to, "RESUMED", iso(deps.clock), { lastReplyAt: deps.clock.now() }));
  const out = [`LANE_RESUMED ${lane.key} ${to}`, ...(goal ? [goal.line] : [])];
  // a thread left 🔔 while this lane was paused (its last working lane closed) is worked in again
  if (deps.requestThreadStatus && hasThread(lane) && lane.thread.startsWith("discord:")) {
    await deps.requestThreadStatus(lane.thread, "working").catch((e: unknown) => out.push(`THREAD_STATUS_WARN ${lane.key} ${lane.thread}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`));
  }
  if (lane.claim && lane.claim.at >= pausedAt(lane)) out.push(`NOTE ${lane.key} claimed done while paused (${lane.claim.evidence}); close it with dori close ${lane.key}, or object with dori object-done`);
  return out;
};
