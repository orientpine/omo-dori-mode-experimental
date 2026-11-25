import type { RuntimeKind } from "./runtime/types.ts";
import { parseRef } from "./runtime/types.ts";

// https://github.com/sisyphuslabs/dori-superagent/pull/284: use the fork's native address spelling in dori type.
export const normalizeLeadPane = (pane: string, kind: RuntimeKind): string => {
  const ref = parseRef(pane) ?? (kind === "hc" ? parseRef(`hc:${pane}`) : undefined);
  return ref?.runtime === kind ? (kind === "herdr" ? ref.id : `hc:${ref.id}`) : pane;
};

// https://github.com/sisyphuslabs/dori-superagent/pull/284: refuse before anything moves if the opener cannot follow
// the lead placement. Do not resolve a runtime earlier than before when there is no override.
export const leadUnmovable = (leadPane: string, leadRuntime: RuntimeKind | undefined, opening: () => string): string | undefined => {
  if (!leadPane) return "leadPane is not set";
  if (!leadRuntime) return undefined;
  const target = opening();
  return leadRuntime === target ? undefined : `leadRuntime ${leadRuntime} differs from ${target}, where the new lead would open: a lead handover with a lead elsewhere is not supported yet; unset leadRuntime or make it match`;
};
