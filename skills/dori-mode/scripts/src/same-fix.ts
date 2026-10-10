import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sendVerified } from "./panes.ts";
import type { FixAttempt, Lane } from "./registry.ts";

// A lane tags a report that is a fix attempt: "(fix: <metric> / <hypothesis>)", e.g. "(fix: deadlock count / reward too small)".
// (lastReportLine trims a trailing ")", so a tag that ends the report may have lost it)
const FIX_TAG = /\(fix:\s*([^/()]+?)\s*\/\s*([^()]+?)\s*(?:\)|$)/i;

export const normFix = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// the footer's own "(fix: <metric> / <hypothesis>)" example, copied as is, is not an attempt
export const fixTag = (report: string): { readonly metric: string; readonly hypothesis: string } | undefined => {
  const m = FIX_TAG.exec(report);
  if (!m?.[1] || !m[2] || m[1].startsWith("<")) return undefined;
  return { metric: normFix(m[1]), hypothesis: normFix(m[2]) };
};

// Attempts on one metric with one hypothesis. Counted conservatively: when the lead asks for a fix (via "lead") and the
// lane then reports that same fix (via "report"), the two are one attempt.
export const fixCount = (fixes: readonly FixAttempt[], metric: string, hypothesis: string): number => {
  let n = 0;
  let askedByLead = false;
  for (const f of fixes) {
    if (f.metric !== metric || f.hypothesis !== hypothesis) continue;
    if (f.via === "report" && askedByLead) askedByLead = false;
    else {
      n++;
      askedByLead = f.via === "lead";
    }
  }
  return n;
};

// Records one fix attempt. From the configured attempt on (3rd by default) it returns an alert for the lead, and, only when
// sameFix.sendToLane is on, tells the lane to stop patching and look for the root cause. It never stops the lane.
export const recordFix = async (deps: FlowDeps, key: string, attempt: FixAttempt): Promise<{ readonly count: number; readonly alert?: string }> => {
  const lane: Lane | null = await deps.registry.read(key);
  if (!lane) return { count: 0 };
  const before = fixCount(lane.fixes ?? [], attempt.metric, attempt.hypothesis);
  const fixes = [...(lane.fixes ?? []), attempt];
  await deps.registry.patch(key, { fixes });
  const count = fixCount(fixes, attempt.metric, attempt.hypothesis);
  const cfg = deps.config.sameFix;
  if (count === before || count < cfg.after) return { count };
  let alert = `attempt ${count} on "${attempt.metric}" with the same hypothesis "${attempt.hypothesis}": stop patching; reproduce it and read the logs for the root cause first`;
  if (cfg.sendToLane && lane.pane) {
    const text = fill([cfg.laneText], { n: String(count), metric: attempt.metric, hypothesis: attempt.hypothesis })[0] ?? cfg.laneText;
    const delivered = await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, text);
    alert += delivered ? " (sent to the lane)" : ` (the note did not reach pane ${lane.pane})`;
  }
  return { count, alert };
};
