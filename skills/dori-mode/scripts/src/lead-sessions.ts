import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SESSION_FILE } from "./session-id.ts";

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
};

// Handover facts keep from.session; result files also persist to.session, including
// the current lead. Metrics stay record-only: no process lookup on each scan.
export const leadSessionIds = (stateDir: string): ReadonlySet<string> => {
  const ids = new Set<string>();
  const dir = join(stateDir, "handover");
  for (const name of names(dir).filter((n) => n.endsWith(".json"))) {
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (e) {
      if (e instanceof SyntaxError || (e instanceof Error && "code" in e && e.code === "ENOENT")) continue;
      throw e;
    }
    if (!record || typeof record !== "object") continue;
    for (const target of [("from" in record ? record.from : undefined), ("to" in record ? record.to : undefined)]) {
      if (target && typeof target === "object" && "session" in target && typeof target.session === "string" && target.session) ids.add(target.session);
    }
  }
  return ids;
};

// Unknown identity preserves the legacy whole-folder behavior, including setups
// that have never handed over. A known identity must never admit lane files.
export const leadSessionFiles = (dir: string, stateDir?: string): string[] => {
  if (!dir) return [];
  const ids = stateDir ? leadSessionIds(stateDir) : new Set<string>();
  return names(dir)
    .filter((name) => name.endsWith(".jsonl") && (ids.size === 0 || ids.has(SESSION_FILE.exec(name)?.[5] ?? "")))
    .map((name) => join(dir, name));
};
