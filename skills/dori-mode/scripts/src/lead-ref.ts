import { parseRef } from "./runtime/types.ts";

export const normalizeLeadPane = (pane: string, kind: unknown): string => {
  if (kind !== "hc") return pane;
  const qualified = `${kind}:${pane}`;
  return parseRef(qualified) ? qualified : pane;
};

// Why a terminal lead handover cannot move this lead, or undefined. https://github.com/sisyphuslabs/dori-superagent/pull/284:
// the replacement opens where the backend opens sessions (`opening`), so a leadRuntime naming another place is refused
// before anything moves (review 8 of PR 527, docs/follow-ups.md).
export const leadUnmovable = (leadPane: string, leadRuntime: string | undefined, opening: string): string | undefined => {
  if (!leadPane) return "leadPane is not set";
  if (parseRef(leadPane)?.runtime === "omo-host") return "terminal handover cannot move a hosted lead";
  if (leadRuntime && leadRuntime !== opening) return `leadRuntime ${leadRuntime} differs from ${opening}, where the new lead would open: a lead handover with a lead elsewhere is not supported yet; unset leadRuntime or make it match`;
  return undefined;
};
