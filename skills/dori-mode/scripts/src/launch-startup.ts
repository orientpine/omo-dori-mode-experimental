import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { agentPath, AoeError, envMismatch, inputLine, openAoeSession } from "./aoe.ts";
import { openHerdrSession } from "./herdr.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { agentGone, firstTurnRuns, GOAL_WAIT, goalReader, lastLines, noGoalWhy } from "./pending-goal.ts";
import { AGENT, argvSessionId, descendants, ended, hasSessionSelector, procTable, sessionDirFor, shellPidOf } from "./session-id.ts";
import { isOmoExecutable } from "./executable.ts";
import { leadReplies } from "./lead-limit.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { join } from "node:path";
import { LaunchFailed } from "./launch-types.ts";
import { splitModel } from "./lane-handover.ts";
import { withThinking } from "./lane-model.ts";
import { startupFailure } from "./launch-screen.ts";

// whether the newest model reply in the lane's own session (the exact id from its command line, under the cwd or its real
// path) is from this launch (at or after since) and ended without an error; no id, no transcript or no such reply is none
const modelAnswered = (sessionsDir: string, cwd: string, session: string, since: number): boolean => {
  if (!session) return false;
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  for (const dir of new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])) {
    try {
      const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
      if (!name) continue;
      const last = leadReplies(readFileSync(join(dir, name), "utf8")).at(-1);
      return last !== undefined && last.at >= since && last.error === undefined;
    } catch {}
  }
  return false;
};

export const failureOf = (deps: FlowDeps, screen: string, cwd: string, session: string, since: number): string | undefined =>
  startupFailure(screen, modelAnswered(deps.config.sessionsDir, cwd, session, since));

// A running agent is not yet a good start: a lane that never sets its goal does its first turn and stops, and the lead
// found the quiet lane long after a STARTUP_OK (dori-superagent issue #50 reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/issues/50; upstream PR #51 reads herdr's screen, this reads omo's
// goal store, the file `dori pause`/`dori resume` confirm with, of the session id the lane's agent runs under, read from
// its command line: aoe's own --session-id, or the one launch gave a herdr omo; goal.ts laneGoal). Launch reads it
// briefly and never waits out a first turn (pending-goal.ts has the measurement): right after the 20 s check a goal is
// STARTUP_OK; a first turn still on (its turn running, or the agent waiting on a background job of its own) is
// STARTUP_PENDING_GOAL (exit 0; the lane is marked and dori watch finishes the judgement); three idle reads 10 s apart
// with no goal are STARTUP_NO_GOAL (exit 3); an agent that ends or shows a startup failure is STARTUP_ERROR.
// prompted: the clock when the agent got its prompt. STARTUP_NO_GOAL gives the time read from the clock, since sleeps and
// screen reads run long on a loaded host (dori-superagent PR #83 (MIT): https://github.com/sisyphuslabs/dori-superagent/pull/83).
// The goal record holds at any pane width; omo cuts its "Pursuing goal" footer to the pane's ("Pur..." at ~31 columns),
// so no footer is read for the goal (dori-superagent PR #123 (MIT): https://github.com/sisyphuslabs/dori-superagent/pull/123).
export const startupGoal = async (deps: FlowDeps, key: string, pane: string, cwd: string, session: string, launchedAt: number, prompted: number): Promise<string | undefined> => {
  // no session id in the agent's command line (aoe did not pin one, or an agentCommand that is not omo): which session is
  // the lane's is not known, and guessing it could read another session's goal
  if (!deps.readGoal && !session) return `STARTUP_UNCONFIRMED ${key} ${pane}: the agent runs but its command line names no session id, so its goal cannot be read; last lines: ${lastLines(await readScreen(deps.run, deps.config.backend, pane, 40))}`;
  const read = goalReader(deps, cwd, session);
  for (let idle = 1; ; idle++) {
    // a goal is no good news from an agent that already ended, so the agent is read before its goal, every time
    const gone = await agentGone(deps, pane);
    if (gone) return `STARTUP_ERROR ${key} ${pane}: ${gone}`;
    const goal = await read(pane);
    if (typeof goal === "object") return undefined;
    const screen = await readScreen(deps.run, deps.config.backend, pane, 40);
    const bad = failureOf(deps, screen, cwd, session, launchedAt);
    if (bad) return `STARTUP_ERROR ${key} ${pane}: ${bad}`;
    if (await firstTurnRuns(deps, pane, cwd, session, screen)) {
      await deps.registry.patch(key, { pendingGoal: { idle: 0, at: deps.clock.now() } });
      return `STARTUP_PENDING_GOAL ${key} ${pane}: its first turn is still on and has set no goal yet; dori watch says LANE_NO_GOAL if it ends without one`;
    }
    if (idle >= GOAL_WAIT.idleChecks) return `STARTUP_NO_GOAL ${key} ${pane}: the agent runs but ${noGoalWhy(goal)}: its first turn ended ${Math.round((deps.clock.now() - prompted) / 1_000)} s after its prompt; last lines: ${lastLines(screen)}`;
    await deps.clock.sleep(GOAL_WAIT.everyMs);
  }
};


// session: the id the lane's agent runs under, from its command line ("" or absent when it names none)
type Opened = { readonly pane: string; readonly tab?: string; readonly failure?: string; readonly session?: string };

// A herdr lane's agent picks its own session unless told: an omo agentCommand that names no session of its own gets
// --session-id <a new id> after the program, so launch knows the lane's session exactly. Any other command is run as it is.
export const withSessionId = (argv: readonly string[], id: string): string[] =>
  isOmoExecutable(argv[0] ?? "") && !hasSessionSelector(argv) ? [argv[0] ?? "omo", "--session-id", id, ...argv.slice(1)] : [...argv];

// env: launchEnv for the lane (laneEnv), set on the agent's command line, since a herdr pane takes the server's environment
export const openHerdr = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string, env: Readonly<Record<string, string | undefined>> = {}): Promise<Opened> => {
  // the template is checked, not the filled argv: the prompt is one argument and never a selector
  // an omo agent gets the model's level as its own --thinking (lane-model.ts withThinking)
  const filled = fill(withSessionId(deps.config.agentCommand, crypto.randomUUID()), { model, prompt });
  const argv = isOmoExecutable(filled[0] ?? "") ? withThinking(filled, model) : filled;
  // the shared opener (herdr.ts): a tab labelled with the key, a workspace first on a fresh server, the agent run there
  let opened: { readonly pane: string; readonly tab?: string };
  try {
    // omo needs node for its hooks (agentPath); another agent starts with the server's PATH as before
    const path = isOmoExecutable(argv[0] ?? "") ? { PATH: agentPath(argv[0] ?? "omo") } : {};
    opened = await openHerdrSession(deps.run, deps.clock, { title: key, cwd, argv, env: { ...env, ...path }, ...(deps.config.laneWorkspace ? { workspace: deps.config.laneWorkspace } : {}) });
  } catch (e) {
    throw new LaunchFailed(e instanceof Error ? e.message : String(e));
  }
  const { pane, tab } = opened;
  // a command with its own --session-dir keeps its sessions (and goals) outside sessionsDir, so launch cannot read them
  const elsewhere = argv.some((a) => a === "--session-dir" || a.startsWith("--session-dir="));
  return { pane, ...(tab ? { tab } : {}), session: elsewhere ? "" : argvSessionId(argv) };
};

export const openAoe = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string, env: Readonly<Record<string, string | undefined>>): Promise<Opened> => {
  let pane: string;
  try {
    const { base, thinking } = splitModel(model);
    pane = await openAoeSession(deps.run, deps.clock, { title: key, cwd, tool: deps.config.agentCommand[0] ?? "omo", model: base, ...(thinking ? { thinking } : {}), env });
  } catch (e) {
    if (e instanceof AoeError) throw new LaunchFailed(e.message);
    throw e;
  }
  const failure = await awaitPrompt(deps, pane);
  if (failure) return { pane, failure };
  const session = await aoeAgentSession(deps, pane);
  // a lane that missed launchEnv (the GPU guard) gets no prompt: it would start working with the GPU in reach
  const off = await envMismatch(deps.run, pane, env);
  if (off.length) return { pane, failure: `launchEnv not in the session: ${off.join(", ")}; the lane prompt was not sent` };
  // an agent with no API key shows its error where the prompt went in and keeps the text: that error is the reason
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, prompt)))
    return { pane, failure: startupFailure(await readScreen(deps.run, "aoe", pane)) ?? "the launch prompt was not submitted (see NOT_SUBMITTED in the watch log)" };
  return { pane, session };
};

// The session aoe started the lane's agent with: aoe pins an omo session by putting --session-id <id> in its command line
// (openAoeSession gives aoe add the PATH it needs for that). launch adds no selector of its own: aoe would then refuse
// every restart of the session ("already contains native session selector"). The agent is the first agent process under
// the pane's shell, read once its prompt shows.
const aoeAgentSession = async (deps: FlowDeps, pane: string): Promise<string> => {
  const shell = await shellPidOf(pane, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: "aoe" });
  const agent = shell ? descendants(await procTable(deps.run), shell).find((p) => AGENT.test(p.cmd) && !ended(p)) : undefined;
  return agent ? argvSessionId(agent.cmd.split(/\s+/)) : "";
};

// The agent's ❯ prompt, or the first startup error on screen: an agent that exits at once never shows a prompt.
export const awaitPrompt = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  for (let i = 0; i < 90; i++) {
    const screen = await readScreen(deps.run, "aoe", pane);
    if (inputLine(screen) !== undefined) return undefined;
    const bad = startupFailure(screen);
    if (bad) return bad;
    await deps.clock.sleep(2_000);
  }
  return "no ❯ prompt within 3 minutes";
};
