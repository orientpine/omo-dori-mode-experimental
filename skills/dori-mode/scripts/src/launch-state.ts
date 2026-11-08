import { resolve } from "node:path";
import { forwardEnv, laneEnv } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, threadRefProblem } from "./registry.ts";
import { iso } from "./run.ts";
import { checkDone, doneSyntaxErrors } from "./done-signals.ts";
import { watchLog } from "./watch-log.ts";
import { checkedLedger, type Ledger, repoName } from "./directives.ts";
import { type LaunchInput, LaunchError } from "./launch-types.ts";
import { validateLaunch } from "./launch-gates.ts";
import { briefWithDone } from "./launch-footer.ts";

export const intentFields = (input: LaunchInput): Partial<Lane> => ({ ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}), ...(input.challengeBefore?.length ? { challengeBefore: input.challengeBefore } : {}), ...(input.useGpu ? { useGpu: true } : {}), ...(input.ui ? { ui: true } : {}) });


const EMPTY_LEDGER: Ledger = { entries: [], kinds: {}, minHits: 3, labels: [], standing: "", reviewed: [], fillers: [], files: [] };
// config directives.common and .local; a broken ledger stops the launch (it would let directives through unseen)
export const launchLedger = (deps: Pick<FlowDeps, "config">): Ledger => (deps.config.directives.common || deps.config.directives.local ? checkedLedger(deps.config) : EMPTY_LEDGER);

// The repo a lane works in (directive scope "repos"): its origin remote's name, else its directory's name.
export const laneRepo = async (deps: Pick<FlowDeps, "run">, cwd: string): Promise<string> => {
  const r = await deps.run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  return repoName(r.code === 0 ? r.out : "", cwd);
};

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: resolve(input.brief), done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

// A lane put on a thread works there: one left ✅ or 🔔 (or an old ⏸️), or archived (a lane closed in it before), is opened again and
// marked 🔄, as closeLane and dori resume decide it (a working lane makes its thread working, past an open card). The
// rename goes through the thread status queue, so Discord's rename limit parks it for the listener instead of failing.
// A thread already 🔄 and open is only read. Without a Discord token or a discord: ref nothing is done.
export const reopenLaneThread = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  if (!deps.reopenThread || !lane.thread.startsWith("discord:")) return undefined;
  const line = await deps.reopenThread(lane.thread, lane.title).then(
    (outcome) => `THREAD_REOPEN ${lane.key} ${lane.thread}: working requested: ${outcome}`,
    (e: unknown) => `THREAD_REOPEN_WARN ${lane.key} ${lane.thread}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
  );
  watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
  return line;
};

// Points an existing lane at another work thread, e.g. one made after the lane was launched; the lane works there now.
export const setThread = async (deps: FlowDeps, lane: Lane, ref: string): Promise<string> => {
  const problem = threadRefProblem(ref);
  if (problem) throw new LaunchError(problem);
  await deps.registry.patch(lane.key, { thread: ref });
  const reopened = await reopenLaneThread(deps, { ...lane, thread: ref });
  return [`THREAD_SET ${lane.key} ${lane.thread || "-"} -> ${ref}`, ...(reopened ? [reopened] : [])].join("\n");
};

// The lead changes an open lane's Done line when the plan changed after launch (the old signals can no longer read back
// live, though the work is done). The new line must parse like a launch's, the reason is required, and the new signals
// are read once now; every signal still has to read back live for dori close or the watcher to close the lane. The
// earlier line stays in the lane's doneChanges, the watch log gets a DONE_SET line, the brief's footer is updated and
// the lane is told.
export const setDone = async (deps: FlowDeps, lane: Lane, done: string, reason: string): Promise<string[]> => {
  const next = done.trim().replace(/^Done\s*=\s*/i, "");
  if (!reason.trim()) throw new LaunchError("--reason is required: why the Done line changed");
  const errors = doneSyntaxErrors(next);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  if (next === lane.done.trim()) throw new LaunchError(`lane ${lane.key} already has this Done line`);
  const checks = await checkDone(next, deps.run, { cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });
  const live = checks.filter((c) => c.ok).length;
  const at = iso(deps.clock);
  const change = { at, from: lane.done, to: next, reason: reason.trim(), live: live === checks.length };
  await deps.registry.patch(lane.key, { done: next, doneChanges: [...(lane.doneChanges ?? []), change] });
  watchLog(deps.config.watchLog, deps.clock, { source: "done-set", line: `DONE_SET ${lane.key} live ${live}/${checks.length}; reason: ${change.reason}; was: ${lane.done}; now: ${next}` });
  const out = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  try {
    await Bun.write(lane.brief, briefWithDone(await Bun.file(lane.brief).text(), next, change));
    out.push(`BRIEF_UPDATED ${lane.brief}`);
  } catch (e) {
    out.push(`DONE_SET_BRIEF_WARN ${lane.key} ${lane.brief}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
  if (lane.pane) {
    const text = `[LEAD] Done line changed for ${lane.key}: ${change.reason}. The new line is in your brief's Lane footer (${lane.brief}); the lane closes only when it reads back live.`;
    await sendVerified(deps.run, deps.clock, deps.config, lane.pane, text).then(
      (ok) => out.push(ok ? `LANE_TOLD ${lane.pane}` : `DONE_SET_NOT_SENT ${lane.key} ${lane.pane}: not submitted (see NOT_SUBMITTED in the watch log)`),
      (e: unknown) => out.push(`DONE_SET_NOT_SENT ${lane.key} ${lane.pane}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`),
    );
  }
  out.push(
    change.live
      ? `DONE_SET ${lane.key} live ${live}/${checks.length}: every new signal reads back live; dori close ${lane.key} closes it now`
      : `DONE_SET ${lane.key} live ${live}/${checks.length}: not every new signal reads back live yet; the lane closes once they do`,
  );
  return out;
};

// Marks whether a lane's sessions start without launchEnv. The running session keeps the environment it started with.
export const setGpu = async (deps: FlowDeps, lane: Lane, on: boolean): Promise<string> => {
  await deps.registry.patch(lane.key, { useGpu: on });
  return `GPU_SET ${lane.key} ${lane.useGpu ? "on" : "off"} -> ${on ? "on" : "off"}: applies from its next handover or restart; the running session keeps its environment`;
};

// env(1) arguments that restart a session the way dori opens it (setups/discord-aoe/self-restart.sh): NAME=VALUE for an
// open lane without --use-gpu, --unset=NAME for anything else (a GPU lane, the lead, a session no lane owns). Nothing
// when launchEnv is empty; otherwise its names go into tmux update-environment first.
export const launchEnvArgs = async (deps: FlowDeps, pane: string): Promise<string[]> => {
  const names = Object.keys(deps.config.launchEnv);
  if (!names.length) return [];
  const lane = (await deps.registry.list()).find((l) => l.pane === pane && l.status !== "closed");
  await forwardEnv(deps.run, names);
  // env(1) reads options only before the first NAME=VALUE (a later --unset=X would set a variable named "--unset")
  const env = Object.entries(laneEnv(deps.config.launchEnv, !lane || lane.useGpu));
  return [...env.filter(([, v]) => v === undefined).map(([name]) => `--unset=${name}`), ...env.flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${value}`]))];
};
