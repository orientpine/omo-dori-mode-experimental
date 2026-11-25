import { parseRef } from "./runtime/types.ts";

export const normalizeLeadPane = (pane: string, kind: unknown): string => {
  if (kind !== "omo-host" && kind !== "hc") return pane;
  const qualified = `${kind}:${pane}`;
  return parseRef(qualified) ? qualified : pane;
};
