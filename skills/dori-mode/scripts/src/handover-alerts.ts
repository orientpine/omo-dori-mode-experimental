import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { expandHome } from "./config.ts";
import type { HandoverDeps } from "./handover.ts";

const alertPane = (text: string): string | undefined => {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || !("update" in raw)) return undefined;
  const update = raw.update;
  if (typeof update !== "object" || update === null || !("alertPane" in update)) return undefined;
  return typeof update.alertPane === "string" ? update.alertPane : undefined;
};

class AlertPaneRewriteError extends Error {
  constructor(readonly path: string) {
    super(`Could not rewrite update.alertPane in ${path}`);
  }
}

type LeadMove = { readonly from: string; readonly to: string; readonly stamp: string };

export const pointInstanceAlerts = (deps: HandoverDeps, move: LeadMove): string[] => {
  const out: string[] = [];
  const rollback = move.from !== deps.config.leadPane;
  for (const ref of deps.config.instances) {
    const path = expandHome(ref.config, deps.home);
    if (path === deps.configPath || !existsSync(path)) continue;
    const copy = `${path}.bak-handover-${move.stamp}`;
    // Only files changed by this handover move back, not ones already pointing at the new lead.
    if (rollback && (!existsSync(copy) || alertPane(readFileSync(copy, "utf8")) !== move.to)) continue;
    const text = readFileSync(path, "utf8");
    if (alertPane(text) !== move.from) continue;
    let depth = 0;
    let update = false;
    let next = text;
    // Walk JSON string/structure tokens to locate only the top-level update object's own key.
    // Slicing at its value keeps whitespace, escaped keys and every other field byte-for-byte.
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
      const word = token[0];
      if (word === "{" || word === "[") {
        depth++;
        continue;
      }
      if (word === "}" || word === "]") {
        depth--;
        if (depth === 1) update = false;
        continue;
      }
      const end = token.index + word.length;
      if (!/^\s*:/.test(text.slice(end))) continue;
      const key: unknown = JSON.parse(word);
      if (depth === 1) update = key === "update";
      if (!update || depth !== 2 || key !== "alertPane") continue;
      const value = /^(\s*:\s*)("(?:\\.|[^"\\])*")/.exec(text.slice(end));
      if (!value?.[1] || !value[2]) break;
      const start = end + value[1].length;
      next = text.slice(0, start) + JSON.stringify(move.to) + text.slice(start + value[2].length);
      break;
    }
    if (alertPane(next) !== move.to) throw new AlertPaneRewriteError(path);
    if (!existsSync(copy)) writeFileSync(copy, text);
    writeFileSync(path, next);
    out.push(`HANDOVER_ALERTPANE ${path} ${move.from} -> ${move.to}`);
  }
  return out;
};
