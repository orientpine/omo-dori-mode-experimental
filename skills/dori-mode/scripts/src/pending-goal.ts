import { paneLife } from "./aoe.ts";
import { laneBackground } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type GoalRead, laneGoal } from "./goal.ts";
import { readScreen, submitToPane } from "./panes.ts";
import { statusOf } from "./registry.ts";
import { AGENT, descendants, ended, procTable, shellPidOf } from "./session-id.ts";
import { turnRunning } from "./submit.ts";

// A started lane has to set its goal (dori-superagent issue #50 reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/issues/50), but not within a fixed time: on 213 real lanes of four
// Dori accounts (2026-11-02) a ulw lane read its brief and ran a discovery wave first, so 81% set their goal later than
// 80 s; 201 set it before their first turn ended (median 146 s, p90 260 s, p99 849 s, longest 1383 s), 11 only after a
// user's nudge, one after a 19 s idle gap between turns. Waiting that long would hold up the lead's dori launch and the
// backlog pass, so the judgement is split: dori launch reads the lane's first turn briefly (right after its 20 s check,
// then every 10 s while the turn is idle) and dori watch, every 30 s, finishes it for a lane launch left pending.
// Either way a turn counts as ended without a goal only after three idle reads in a row, so a gap between tool calls or
// turns is no end.
export const GOAL_WAIT = { everyMs: 10_000, idleChecks: 3 } as const;

export const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private|tmp)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const noGoalWhy = (goal: GoalRead): string => (goal === "none" ? "no goal in its session" : "no goal found for its session");

// The goal of the lane's own session: the exact id its agent runs under (goal.ts laneGoal)
export const goalReader = (deps: FlowDeps, cwd: string, session: string): ((pane: string) => Promise<GoalRead>) =>
  deps.readGoal ?? (async () => laneGoal(deps.config.sessionsDir, cwd, session));

export const agentGone = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  if (deps.config.backend === "aoe") {
    const life = await paneLife(deps.run, pane);
    return life.live ? undefined : life.how === "gone" ? "the tmux session is gone" : `the agent exited (status ${life.status})`;
  }
  // whether any agent still runs under the pane's shell, which is not the same question as which session it is:
  // resolveSession skips a command holding the word mcp (an MCP server of the agent), and a herdr lane carries its own
  // prompt in the agent's command line, so a lane keyed mcp-fix or briefed /tmp/mcp.md would read as dead
  const shell = await shellPidOf(pane, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: deps.config.backend });
  const table = shell ? await procTable(deps.run) : [];
  const live = [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].some((p) => AGENT.test(p.cmd) && !ended(p));
  return live ? undefined : "no agent runs in the pane any more";
};

// A first turn is still on while its turn runs on screen, and while the agent waits on background work of its own: a
// job it detached (an eval or a bash the harness moved to the background, a task, a monitor) wakes it when it ends, and
// such a lane often sets its goal then (QA 2026-11-02: a sleep 150 detached after 5 s, the turn ended, the goal came when
// the job did). The jobs are done-flow's own reading of the session (background.ts laneBackground); a read that fails
// counts as none.
export const firstTurnRuns = async (deps: FlowDeps, pane: string, cwd: string, screen: string): Promise<boolean> =>
  turnRunning(screen) || Boolean((await laneBackground(deps.run, deps.config.sessionsDir, pane, cwd).catch(() => undefined))?.length);

export const noGoalText = (key: string): string => `[DORI] LANE_NO_GOAL ${key}: 첫 턴이 goal 없이 끝남 — pane 보고 goal 세우라고 해`;

// dori watch: each lane dori launch marked pending (STARTUP_PENDING_GOAL) is read again. A goal clears the mark
// (LANE_GOAL_SET); a running turn or a background job of its own resets the idle count kept on the mark; the third idle
// read in a row says LANE_NO_GOAL and types one line into the lead's pane, once (no retry, like a lane's death:
// LANE_NO_GOAL_TOLD or _NOT_TOLD), and clears the mark. A lane whose agent is gone is left to the lane death check; a lane
// that is not working (paused, claimed, closed) or names no session is skipped.
export const pendingGoalTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const lane of await deps.registry.list()) {
    const mark = lane.pendingGoal;
    if (!mark || !lane.pane || statusOf(lane) !== "working" || (!lane.session && !deps.readGoal)) continue;
    if (await agentGone(deps, lane.pane)) continue;
    const cwd = lane.cwd ?? deps.config.defaultCwd;
    const goal = await goalReader(deps, cwd, lane.session ?? "")(lane.pane);
    if (typeof goal === "object") {
      await deps.registry.patch(lane.key, { pendingGoal: undefined });
      out.push(`LANE_GOAL_SET ${lane.key} ${lane.pane}: its session holds a goal now; the pending-goal mark is cleared`);
      continue;
    }
    const screen = await readScreen(deps.run, deps.config.backend, lane.pane, 40);
    const idle = (await firstTurnRuns(deps, lane.pane, cwd, screen)) ? 0 : mark.idle + 1;
    if (idle < GOAL_WAIT.idleChecks) {
      if (idle !== mark.idle) await deps.registry.patch(lane.key, { pendingGoal: { idle } });
      continue;
    }
    await deps.registry.patch(lane.key, { pendingGoal: undefined });
    out.push(`LANE_NO_GOAL ${lane.key} ${lane.pane}: its first turn ended with ${noGoalWhy(goal)}; last lines: ${lastLines(screen)}`);
    const lead = deps.config.leadPane;
    const sent = lead ? await submitToPane(deps.run, deps.clock, deps.config, lead, noGoalText(lane.key)) : { status: "NOT_SUBMITTED" as const, reason: "no leadPane" };
    out.push(sent.status === "SUBMITTED" ? `LANE_NO_GOAL_TOLD ${lane.key} ${lead}` : `LANE_NO_GOAL_NOT_TOLD ${lane.key}: ${sent.reason}`);
  }
  return out;
};
