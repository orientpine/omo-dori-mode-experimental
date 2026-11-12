import { paneLife } from "./aoe.ts";
import { finished } from "./boot-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Reports } from "./reports.ts";

// A lane can finish and close its own pane before launch's start wait is over (dori-superagent issue #215, PR #216
// (MIT): https://github.com/sisyphuslabs/dori-superagent/pull/216): a pane that is gone while the lane is closed,
// verified done or reported done (boot-monitors.ts finished, upstream's predicate) is STARTUP_DONE, exit 0, not a failed
// start. Upstream reads hc's not_found on a screen or list read; here reads never throw, and a vanished herdr pane or hc
// terminal (probe.ts maps not_found to gone) reaches launch as paneLife's gone. An agent that exited in a pane that is
// still there is no finished lane's close, so it stays STARTUP_ERROR, as upstream keeps a `shell` status a failure.
export const launchDone = async (deps: FlowDeps, key: string, pane: string): Promise<string | undefined> => {
  const lane = await deps.registry.read(key);
  if (!lane || !finished({ ...lane, reportState: new Reports(deps.config.stateDir).read(key)?.state })) return undefined;
  const life = await paneLife(deps.run, pane);
  return !life.live && life.how === "gone" ? `STARTUP_DONE ${key}` : undefined;
};
