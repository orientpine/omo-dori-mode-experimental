// Ported from https://github.com/sisyphuslabs/dori-superagent/pull/282.
import { runtimesOf } from "./run.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";
import type { FlowDeps } from "./done-flow-state.ts";
import { LaunchFailed, LaunchRegistrationError } from "./launch-types.ts";
import { STARTUP_CHECK_MS, GOAL_WAIT, lastLines } from "./pending-goal.ts";
import { isReason } from "./runtime/omo-host/exec.ts";
import { closedMeanwhile } from "./sessions.ts";

const hostUnavailable = (error: unknown): boolean => isReason(error, "host_unavailable", "transport_gone");
const hostHelp = "OmO host is unreachable; start the shared host: omo host ensure";

export const checkHostedLaunch = async (deps: FlowDeps): Promise<void> => {
  try {
    await runtimesOf(deps.run, deps.config).lane.list();
  } catch (error) {
    if (hostUnavailable(error)) throw new LaunchFailed(hostHelp);
    throw new LaunchFailed(`host check failed: ${String(error)}`);
  }
};

export const openHostedLane = async (deps: FlowDeps, input: { readonly key: string; readonly cwd: string; readonly model: string; readonly prompt: string }, register: (opened: { readonly pane: string }) => Promise<void>) => {
  const rt = runtimesOf(deps.run, deps.config).lane;
  const { key, cwd, model, prompt } = input;
  const group = deps.config.laneWorkspace;
  const ref = await rt.create({ name: key, cwd, model, env: {}, role: "lane", container: "tab", ...(group ? { group } : {}) }).catch((error: unknown) => {
    throw new LaunchFailed(hostUnavailable(error) ? hostHelp : `session create failed: ${String(error)}`);
  });
  const pane = formatRef(ref);
  try {
    await register({ pane });
  } catch (error) {
    const rolledBack = await rt.close(ref).then(() => true, () => false);
    throw new LaunchRegistrationError(error, rolledBack);
  }
  const failure = await rt.start(ref, prompt).then(() => undefined, (error: unknown) => String(error));
  return { pane, tab: undefined, session: ref.id, ref, failure };
};

export const hostedStartup = async (deps: FlowDeps, key: string, ref: SessionRef): Promise<string> => {
  const pane = formatRef(ref);
  const rt = runtimesOf(deps.run, deps.config).for(ref);
  await deps.clock.sleep(STARTUP_CHECK_MS);
  for (let idle = 1; ; idle++) {
    if (await closedMeanwhile(deps, ref, key)) return `STARTUP_DONE ${key}`;
    const screen = await rt.read(ref, 40);
    if (await closedMeanwhile(deps, ref, key)) return `STARTUP_DONE ${key}`;
    const probe = await rt.probe(ref);
    if (await closedMeanwhile(deps, ref, key)) return `STARTUP_DONE ${key}`;
    if (probe.status === "gone") return `STARTUP_ERROR ${key} ${pane}: the host session is gone`;
    if (probe.goal === "active") return `STARTUP_OK ${key} ${pane}`;
    if (probe.activity === "busy" || probe.activity === "running") {
      await deps.registry.patch(key, { pendingGoal: { idle: 0, at: deps.clock.now() } });
      return `STARTUP_PENDING_GOAL ${key} ${pane}: its first turn is still on and has set no goal yet; dori watch says LANE_NO_GOAL if it ends without one`;
    }
    if (idle >= GOAL_WAIT.idleChecks) return `STARTUP_NO_GOAL ${key} ${pane}: no goal in its session; last lines: ${lastLines(screen)}`;
    await deps.clock.sleep(GOAL_WAIT.everyMs);
  }
};
