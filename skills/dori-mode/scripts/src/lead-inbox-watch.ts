import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { shellWords } from "./handover.ts";
import type { readManifest } from "./handover.ts";

// A pair-bot row is information, never a request, except one that calls this Dori (one of discord.callNames in it, or its
// bot mentioned) and another Dori's lead alert (a LEAD_<WORD> line such as LEAD_RUNAWAY or LEAD_COMPACTION_STUCK asks the
// other Dori to act; Discord's sender escapes its underscores); a lead's inbox monitor may drop the rest (MooDori
// 2026-11-11: 121 of 155 pair-bot rows named another Dori). With no callNames every one counts; with no bot id known, any
// mention does.
export const callsThisDori = (text: string, names: readonly string[], botId: string): boolean => {
  const said = text.replaceAll("\\_", "_"), lower = said.toLowerCase(), own = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  return !own.length || /^LEAD_[A-Z_]+\b/.test(said) || [...said.matchAll(/<@!?(\d+)>/g)].some((m) => !botId || m[1] === botId) || own.some((n) => lower.includes(n));
};

type Entry = ReturnType<typeof readManifest>[number] & { readonly deliveryPaused?: boolean };

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const OPTION_VALUES = new Set(["-o", "+o", "-O", "+O", "--init-file", "--rcfile"]);
const stripEnvironment = (command: string): string => {
  let rest = command;
  for (;;) {
    let i = 0;
    const spaces = () => { while (/\s/.test(rest[i] ?? "")) i++; };
    spaces();
    if (rest.startsWith("export", i) && /\s/.test(rest[i + 6] ?? "")) { i += 6; spaces(); }
    const name = /^[A-Za-z_]\w*=/.exec(rest.slice(i));
    if (!name) return rest;
    i += name[0].length;
    let quote = "", depth = 0, escaped = false;
    const quoteDepths: { depth: number; quote: string }[] = [];
    for (; i < rest.length; i++) {
      const c = rest[i] ?? "", next = rest[i + 1] ?? "";
      if (escaped) { escaped = false; continue; }
      if (c === "\\" && quote !== "single") { escaped = true; continue; }
      if (c === "$" && next === "(" && quote !== "single") {
        depth++;
        quoteDepths.push({ depth, quote });
        quote = "";
        i++;
        continue;
      }
      if (quote) {
        const end = quote === "double" ? '"' : "'";
        if (c === end) { quote = ""; continue; }
        if (c === "\\" && quote !== "single") { escaped = true; continue; }
        continue;
      }
      if (c === "\\") { escaped = true; continue; }
      if (c === "$" && next === "'") { quote = "ansi"; i++; continue; }
      if (c === "'") { quote = "single"; continue; }
      if (c === '"') { quote = "double"; continue; }
      if (c === "(" && depth > 0) { depth++; continue; }
      if (c === ")" && depth > 0) {
        const saved = quoteDepths.at(-1);
        if (saved?.depth === depth) { quote = saved.quote; quoteDepths.pop(); }
        depth--;
        continue;
      }
      if (depth === 0 && (c === ";" || /\s/.test(c))) break;
    }
    if (quote || depth > 0) return rest;
    spaces();
    if (rest[i] === ";") i++;
    spaces();
    rest = rest.slice(i);
  }
};
const scriptCalls = (command: string): string[] => {
  const words = shellWords(stripEnvironment(command)) ?? [];
  const offset = (words[0] ?? "").split("/").at(-1) === "exec" ? 1 : 0;
  const first = words[offset] ?? "";
  const shell = first.split("/").at(-1);
  const dNoExec = shell !== "zsh";
  if (first.startsWith("/") && first.endsWith(".sh")) return [first];
  if (!SHELLS.has(shell ?? "")) return [];
  for (let i = offset + 1; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") {
      const script = words[i + 1];
      return script?.startsWith("/") && script.endsWith(".sh") ? [script] : [];
    }
    if (/^-[A-Za-z]*[sn][A-Za-z]*$/.test(word) || (dNoExec && /^-[A-Za-z]*D[A-Za-z]*$/.test(word)) || ["--help", "--version", "--dump-strings", "--dump-po-strings"].includes(word)) return [];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      let j = i + 1;
      for (; j < words.length; j++) {
        const w = words[j] ?? "";
        if (w === "--") { j++; break; }
        if (w === "-n" || (/^-[A-Za-z]+$/.test(w) && (w.includes("n") || (dNoExec && w.includes("D"))))) return [];
        if (w === "--dump-strings" || w === "--dump-po-strings") return [];
        if (OPTION_VALUES.has(w) || /^[-+][A-Za-z]+[oO]$/.test(w)) {
          if (w.startsWith("-") && words[j + 1] === "noexec") return [];
          j++;
          continue;
        }
        if (w.startsWith("-") || w.startsWith("+")) continue;
        break;
      }
      const nested = words[j];
      return nested ? scriptCalls(nested) : [];
    }
    if (/^[-+][A-Za-z]+[oO]$/.test(word)) {
      if (word.startsWith("-") && words[i + 1] === "noexec") return [];
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
