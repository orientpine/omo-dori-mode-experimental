import type { DoriConfig } from "./config.ts";
import { listPanes, readScreen } from "./panes.ts";
import type { Runner } from "./run.ts";

// pausedPanes: panes of paused lanes, which the lead parked on purpose
export const deadPaneTick = async (run: Runner, config: DoriConfig, seen: Set<string>, hourKey: string, pausedPanes: readonly string[] = []): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set(config.workspaces);
  const skip = new Set([config.leadPane, ...config.ignorePanes, ...pausedPanes].filter(Boolean));
  for (const pane of await listPanes(run, config.backend)) {
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const tail = (await readScreen(run, config.backend, pane.pane_id, 6)).toLowerCase();
    if (!config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()))) continue;
    const mark = `${pane.pane_id} ${hourKey}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    out.push(`DEAD_PANE ${pane.pane_id}`);
  }
  return out;
};
