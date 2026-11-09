import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { readManifest } from "./handover.ts";

type Entry = ReturnType<typeof readManifest>[number] & { readonly deliveryPaused?: boolean };

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);

// why the session hears no inbox row, or undefined while a monitor on the inbox file runs and delivers
export const watchProblem = (entries: readonly Entry[], inbox: string, now: number, alive: (pid: number) => boolean): string | undefined => {
  const name = basename(inbox);
  const on = entries.filter((e) => {
    if (e.command?.includes(name)) return true;
    return [...(e.command ?? "").matchAll(/(?:^|[\s;&|(])(\/[^\s;&|'"()]*\.sh)\b/g)].some((m) => {
      try {
        return readFileSync(m[1] ?? "", "utf8").includes(name);
      } catch {
        return false;
      }
    });
  });
  if (!on.length) return `no monitor on ${name}`;
  const expired = (e: Entry): boolean => e.expiresAt != null && e.expiresAt <= now;
  const gone = (e: Entry): boolean => e.runtime?.pid === undefined || !alive(e.runtime.pid);
  if (on.some((e) => !e.suspended && !e.deliveryPaused && !expired(e) && !gone(e))) return undefined;
  const e = on[0] as Entry;
  const why = e.deliveryPaused ? "its delivery is paused" : e.suspended ? "it is suspended" : expired(e) ? "it expired" : "its process is gone";
  return `${plain(e.description || "the inbox monitor", 80)} armed but ${why}`;
};
