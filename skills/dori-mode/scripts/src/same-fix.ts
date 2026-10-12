import type { FlowDeps } from "./done-flow.ts";
import { afterFix } from "./explore.ts";
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

// Attempts on one metric with one hypothesis (the stuck ladder's fixation mark). Counted conservatively: when the lead asks for a fix (via "lead") and the
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

// Records one fix attempt: into the lane's fixes and the area's hypothesis tree, then one step of the stuck ladder (the
// STUCK line when the metric's rung went up). count is the attempts of this metric and hypothesis. It never stops the lane.
export const recordFix = async (deps: FlowDeps, key: string, attempt: FixAttempt): Promise<{ readonly count: number; readonly notes: readonly string[] }> => {
  const lane: Lane | null = await deps.registry.read(key);
  if (!lane) return { count: 0, notes: [] };
  const fixes = [...(lane.fixes ?? []), attempt];
  await deps.registry.patch(key, { fixes });
  const notes = await afterFix(deps, lane, fixes, attempt);
  return { count: fixCount(fixes, attempt.metric, attempt.hypothesis), notes };
};
