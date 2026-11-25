import { parseRef } from "./runtime/types.ts";

export const normalizeLeadPane = (pane: string, kind: unknown): string => {
  const hosted = `omo-host:${pane}`;
  return kind === "omo-host" && parseRef(hosted) ? hosted : pane;
};
