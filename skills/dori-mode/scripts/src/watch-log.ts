import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "./run.ts";

export type WatchEvent = { readonly source: string; readonly line: string };

export const watchLog = (path: string, clock: Clock, event: WatchEvent): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date(clock.now()).toISOString()} ${event.source} ${event.line.replace(/[\r\n]+/g, " ")}\n`);
};
