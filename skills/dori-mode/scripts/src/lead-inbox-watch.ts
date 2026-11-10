import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { shellWords } from "./handover.ts";
import type { readManifest } from "./handover.ts";

type Entry = ReturnType<typeof readManifest>[number] & { readonly deliveryPaused?: boolean };

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const scriptCalls = (command: string): string[] => {
  const words = shellWords(command) ?? [];
  const first = words[0] ?? "";
  const shell = first.split("/").at(-1);
  const direct = shell === "exec" ? words[1] : first;
  if (direct?.startsWith("/") && direct.endsWith(".sh")) return [direct];
  if (!SHELLS.has(shell ?? "")) return [];
  const option = words[1] ?? "";
  const nested = words[2];
  if (/^-[a-z]*c[a-z]*$/.test(option)) return nested ? scriptCalls(nested) : [];
  const script = words[1];
  return script?.startsWith("/") && script.endsWith(".sh") ? [script] : [];
};

// why the session hears no inbox row, or undefined while a monitor on the inbox file runs and delivers
export const watchProblem = (entries: readonly Entry[], inbox: string, now: number, alive: (pid: number) => boolean): string | undefined => {
  const name = basename(inbox);
  const on = entries.filter((e) => {
    if (e.command?.includes(name)) return true;
    return scriptCalls(e.command ?? "").some((word) => {
      try {
        return readFileSync(word, "utf8").includes(name);
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
