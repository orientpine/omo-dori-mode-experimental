import { existsSync } from "node:fs";
import { closeAoeSession } from "./aoe.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow-state.ts";
import { signalIo } from "./done-flow-common.ts";
import { discoverWorktrees } from "./done-flow-worktrees.ts";
import { hasThread, type Lane, sessionOf, statusOf, withStatus } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { closeSession } from "./sessions.ts";
import { omoPane } from "./panes.ts";
import { checkDone } from "./done-signals.ts";
import { gateMissing } from "./merge-gate.ts";
import { ownerSummary } from "./close-summary.ts";
import { CostRecordBusy, laneSessionUsage, Supervision } from "./supervision.ts";
import { Lessons, type LessonInput } from "./lessons.ts";
import { isRepeat } from "./send-dedupe.ts";

// note goes into the lane's record. A lane with a work thread closes only with a summary for the owner (summary, else the
// claim's, else one a model writes from the lane's notes; close-summary.ts), posted there before the thread is marked done
// and archived: no summary is CLOSE_SUMMARY_MISSING, a post that did not go out is CLOSE_SUMMARY_NOT_SENT, and either way
// nothing is changed and the lane stays open. When the lane's result is already in the thread (posted, else the claim's
// posted) and no summary is given here, none is posted: CLOSE_SUMMARY_SKIPPED, and the thread is marked as usual.
// dori close --lesson TEXT, given any number of times: each lesson is one record (src/lessons.ts keeps one evidence per
// rule), so the n-th --evidence goes with the n-th --lesson; one --evidence serves them all, none means the Done line. Any
// other count cannot be paired and comes back as the reason, for the close to refuse before it does anything.
export const closeLessons = (rules: readonly string[], evidence: readonly string[], done: string): Pick<LessonInput, "rule" | "evidence">[] | string => {
  if (!rules.length) return [];
  if (evidence.length > 1 && evidence.length !== rules.length) return `${rules.length} --lesson and ${evidence.length} --evidence: give one --evidence per --lesson, one for all, or none (the Done line)`;
  return rules.map((rule, i) => ({ rule, evidence: evidence.length > 1 ? evidence[i]! : (evidence[0] ?? done) }));
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string, summary?: string, posted?: string, lessons: readonly Pick<LessonInput, "rule" | "evidence">[] = []): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const ungated = await gateMissing(deps, lane.done);
  if (ungated.length) return { closed: false, lines: [...lines, ...ungated, `REFUSED ${lane.key}: a PR of a gated repo was not merged through dori merge`] };
  let threadText = "";
  const already = summary?.trim() || !hasThread(lane) ? undefined : (posted ?? lane.claim?.posted);
  if (already) lines.push(`CLOSE_SUMMARY_SKIPPED ${lane.key}: its result is already in the thread (${already}); no second post`);
  else if (hasThread(lane)) {
    const s = await ownerSummary(deps, lane, summary ?? lane.claim?.summary);
    if (!s.text) return { closed: false, lines: [...lines, `CLOSE_SUMMARY_MISSING ${lane.key}: ${s.why ?? "no summary"}`] };
    threadText = s.text;
    lines.push(`CLOSE_SUMMARY ${lane.key} from ${s.source}`);
  }
  const notSent = (why: string) => ({ closed: false, lines: [...lines, `CLOSE_SUMMARY_NOT_SENT ${lane.key} ${lane.thread}: ${why.slice(0, 200)}`] });
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);
  const cleanup: string[] = [];
  const warnings: string[] = [];
  const hook = deps.config.hooks.threadDone;
  // A thread another open lane or an open question card still uses stays as it is: this lane's result is posted as a
  // reply, and the thread is not marked done, renamed or archived. The last lane to close it marks it done.
  const sharing = hasThread(lane) ? (await deps.registry.open()).filter((l) => l.key !== lane.key && l.thread === lane.thread).map((l) => l.key) : [];
  const cards = hasThread(lane) ? (deps.openCards?.(lane.thread) ?? []) : [];
  const standing = hasThread(lane) && lane.thread.startsWith("discord:") && Boolean(deps.standingThread?.(lane.thread));
  const holders = [
    ...(sharing.length ? [`open lane ${sharing.join(", ")} uses it too`] : []),
    ...(cards.length ? [`open card ${cards.join(", ")}`] : []),
    ...(standing ? ["standing thread"] : []),
  ];
  if (already) {
    if (holders.length) cleanup.push(`thread left open: ${holders.join("; ")}; result already posted (${already})`);
    else if (deps.markThreadDone && lane.thread.startsWith("discord:")) cleanup.push(`result already posted (${already})`);
    else {
      // without a Discord token only the threadDone hook marks a thread done, and it posts a text: posting nothing wins
      warnings.push(`THREAD_DONE_WARN ${lane.key} ${lane.thread}: result already posted (${already}) and no Discord token to mark the thread done without a post; mark it by hand`);
      cleanup.push(`result already posted (${already}); thread not marked done`);
    }
  } else if (holders.length) {
    const text = `${lane.title}: ${threadText}`;
    const reply = deps.config.hooks.threadReply;
    if (deps.postInThread && lane.thread.startsWith("discord:")) {
      // straight to Discord, so a waiting (or any) mark stays; the reply hook would mark the thread working
      const why = await deps.postInThread(lane.thread, text).then(() => "", errText);
      if (why) return notSent(why);
      cleanup.push(`thread left open: ${holders.join("; ")}; summary posted`);
    } else if (reply) {
      // the closing lane is still open while its hook runs: DORI_CLOSING_LANE tells dori thread reply not to count it as working
      const r = await deps.run(fill(reply, { thread: lane.thread, text, key: lane.key }), { env: { DORI_CLOSING_LANE: lane.key } });
      // the summary already the thread's last post (dori thread reply: SEND_DUPLICATE, exit 3) is there: not a failure
      if (isRepeat(r)) {
        cleanup.push(`thread left open: ${holders.join("; ")}; summary already the thread's last post`);
      } else if (r.code !== 0) return notSent(`reply hook failed: ${r.err}`);
      else cleanup.push(`thread left open: ${holders.join("; ")}; summary posted`);
    } else return notSent("no Discord token and no threadReply hook: nothing can post in the thread");
  } else if (deps.postInThread && deps.markThreadDone && hasThread(lane) && lane.thread.startsWith("discord:")) {
    // straight to Discord, then the done mark and the archive below; the threadDone hook would post a second time
    const why = await deps.postInThread(lane.thread, threadText).then(() => "", errText);
    if (why) return notSent(why);
    cleanup.push("summary posted");
  } else if (hook && hasThread(lane)) {
    // the closing lane is still open while its hook runs: DORI_CLOSING_LANE tells dori thread done not to count it as a user
    const r = await deps.run(fill(hook, { thread: lane.thread, text: threadText, key: lane.key }), { env: { DORI_CLOSING_LANE: lane.key } });
    if (r.code !== 0) return notSent(`thread hook failed: ${r.err}`);
    cleanup.push("summary posted, thread marked done");
  } else if (hasThread(lane)) {
    return notSent("no Discord token and no threadDone hook: nothing can post in the thread");
  } else if (hook) {
    // a missing or broken thread ref would leave the work thread open without a word; say so
    warnings.push(`THREAD_MISSING ${lane.key} thread=${JSON.stringify(lane.thread ?? null)}; threadDone not run, close the thread by hand or set it with dori set-thread first`);
    cleanup.push("thread missing: threadDone not run");
  }
  if (deps.markThreadDone && !holders.length && hasThread(lane) && lane.thread.startsWith("discord:")) {
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
  // the lane's cost, recorded once (src/supervision.ts close), after every point that can still refuse the close: a refused
  // close leaves the lane working, and its later close takes the reading then. A reading or hook that fails is printed and
  // never keeps a verified lane open.
  try {
    const cost = await new Supervision({ stateDir: deps.config.stateDir, run: deps.run, clock: deps.clock, sessionUsage: laneSessionUsage(deps.run, deps.config.sessionsDir) }, deps.config.supervision).close(lane);
    lines.push(`COST ${lane.key} tokens=${cost.tokens ?? "unknown"} costUsd=${cost.costUsd ?? "unknown"}`);
  } catch (e) {
    // Another close (the watcher and a manual close at once) is taking the lane's reading, maybe through its live pane:
    // this one tears nothing down, so that reading is not lost and the other close finishes the lane.
    if (e instanceof CostRecordBusy) return { closed: false, lines: [...lines, ...warnings, `CLOSE_IN_PROGRESS ${lane.key}: ${e.message}; the other close finishes the lane`] };
    lines.push(`COST ${lane.key} not recorded: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  // an aoe session or a herdr pane is closed by its own backend (the pane id says which; a herdr pane's tab goes only when
  // the pane is all it holds); a lane of another herdr agent keeps the tab/pane close it had
  if (lane.pane && omoPane(deps.config, lane.pane)) {
    cleanup.push(await closeAoeSession(deps.run, lane.pane));
  } else if (sessionOf(lane)) cleanup.push(await closeSession(runtimesOf(deps.run, deps.config), sessionOf(lane)!));
  const root = lane.cwd ?? deps.config.defaultCwd;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  // dori close --lesson (dori-superagent #65): kept only after the close is recorded, and a failure to keep it is a warning
  // that never undoes or blocks the close. Each lesson is kept on its own: one that cannot be kept costs only itself.
  for (const lesson of lessons) {
    try {
      lines.push(`LESSON ${new Lessons(deps.config.stateDir).add({ ...lesson, lane: lane.key, cwd: root }, deps.clock.now()).id}`);
    } catch (e) {
      warnings.push(`LESSON_WARNING ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Only now, with this lane recorded closed, is it no longer working there. The thread turns waiting when what is left
  // waits on the owner: an open card or a paused lane. A lane still working keeps it working, and a done-claimed one is
  // still ours (the lead decides), so then the mark is left alone. Read again here, since a card answered during the
  // cleanup gives the thread back to work.
  const left = holders.length ? (await deps.registry.open()).filter((l) => l.key !== lane.key && l.thread === lane.thread) : [];
  const ownersTurn = holders.length && left.every((l) => statusOf(l) === "paused") && (left.length > 0 || standing || (deps.openCards?.(lane.thread) ?? []).length > 0);
  if (ownersTurn && deps.requestThreadStatus && lane.thread.startsWith("discord:")) {
    const status = await deps.requestThreadStatus(lane.thread, "waiting").then(
      (outcome) => `waiting requested: ${outcome}`,
      (e: unknown) => `waiting not requested: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    );
    cleanup.push(status);
    // a rate-limited rename is kept and applied later by the listener; say that the mark has not moved yet
    if (!/: (applied|unchanged)$/.test(status)) warnings.push(`THREAD_STATUS_WARN ${lane.key} ${lane.thread}: ${status}`);
    await deps.registry.patch(lane.key, { receipt });
  }
  return { closed: true, lines: [...lines, ...warnings, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};
