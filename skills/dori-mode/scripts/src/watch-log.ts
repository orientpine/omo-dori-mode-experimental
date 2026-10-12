import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "./run.ts";

export type WatchEvent = { readonly source: string; readonly line: string };

// One watch-log line, "<iso> <source> <KIND> <key> <detail>", read back: the only parser of this format (scorecard,
// dori signals and rollover-stats count from it). Undefined for a line that does not start with a time.
export type WatchLine = { readonly at: string; readonly source: string; readonly kind: string; readonly key: string; readonly detail: string };

export const parseWatchLine = (line: string): WatchLine | undefined => {
  const m = /^(\S+) (\S+) (\S+)(?: (\S+))?(?: (.*))?$/.exec(line.trimEnd());
  if (!m?.[1] || !m[2] || !m[3] || Number.isNaN(Date.parse(m[1]))) return undefined;
  return { at: m[1], source: m[2], kind: m[3], key: m[4] ?? "", detail: m[5] ?? "" };
};

export const watchLog = (path: string, clock: Clock, event: WatchEvent): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date(clock.now()).toISOString()} ${event.source} ${event.line.replace(/[\r\n]+/g, " ")}\n`);
};
