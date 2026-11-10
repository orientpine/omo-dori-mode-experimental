import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { shellWords } from "./handover.ts";
import type { readManifest } from "./handover.ts";

type Entry = ReturnType<typeof readManifest>[number] & { readonly deliveryPaused?: boolean };

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const OPTION_VALUES = new Set(["-o", "+o", "-O", "+O", "--init-file", "--rcfile"]);
const ENV_SETUP = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;]|\$\([^)]*\))+(?:\s*;\s*|\s+)/;
const stripEnvironment = (command: string): string => {
  let rest = command;
  while (ENV_SETUP.test(rest)) rest = rest.replace(ENV_SETUP, "");
  return rest;
};
const scriptCalls = (command: string): string[] => {
  const words = shellWords(stripEnvironment(command)) ?? [];
  const offset = (words[0] ?? "").split("/").at(-1) === "exec" ? 1 : 0;
  const first = words[offset] ?? "";
  const shell = first.split("/").at(-1);
  if (first.startsWith("/") && first.endsWith(".sh")) return [first];
  if (!SHELLS.has(shell ?? "")) return [];
  for (let i = offset + 1; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") {
      const script = words[i + 1];
      return script?.startsWith("/") && script.endsWith(".sh") ? [script] : [];
    }
    if (/^-[a-z]*[sn][a-z]*$/.test(word) || word === "--help" || word === "--version") return [];
    if (/^-[a-z]*c[a-z]*$/.test(word)) {
      const nested = words[i + 1];
      return nested ? scriptCalls(nested) : [];
    }
    if (/^[-+][A-Za-z]+[oO]$/.test(word)) {
      if (words[i + 1] === "noexec") return [];
      i++;
    } else if (OPTION_VALUES.has(word)) {
      if (word === "-o" && words[i + 1] === "noexec") return [];
      i++;
    } else if (!word.startsWith("-") && !word.startsWith("+")) {
      return word.startsWith("/") && word.endsWith(".sh") ? [word] : [];
    }
  }
  return [];
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
