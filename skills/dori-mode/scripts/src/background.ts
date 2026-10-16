import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";

// Background work an omo session started and is still waiting on, read from its session transcript: a detached eval
// cell, a background (or auto-detached) bash session, a background task child. omo shows none of these on its status
// line, so a lane that ended its turn to wait for one looks idle on screen. Each start is a tool result and each end a
// tool result or a delivered notification; a start without its end is still running.
export type BackgroundJob = { readonly kind: "eval" | "bash" | "task"; readonly id: string; readonly at: number };

const STARTS: readonly (readonly [BackgroundJob["kind"], RegExp])[] = [
  ["eval", /Eval cell (\S+) detached and is running/g],
  ["bash", /Command running in background with ID: (bash_\w+)/g],
  ["bash", /auto-detached to background with ID: (bash_\w+)/g],
  ["task", /\((st_[0-9a-z]+), running\)/g],
  ["task", /\b(st_[0-9a-z]+) \(running\)/g],
];
const ENDS: readonly RegExp[] = [
  /Detached eval cell (\S+) \(/g,
  /Eval cell (\S+) \(\w+\) is cancelled/g,
  /Background terminal session (bash_\w+) finished/g,
  /Killed (bash_\w+)\./g,
  /\b(bash_\w+) exited\b/g,
  /task completion [^\n]*?\bid:(st_[0-9a-z]+)/g,
  /Task (st_[0-9a-z]+) had already finished/g,
];
// a line without any of these cannot start or end a job; it is not parsed
const HINT = /detached and is running|in background with ID|auto-detached|st_[0-9a-z]+|Detached eval cell|is cancelled|Background terminal session|Killed bash_|bash_\w+ exited/;

type Entry = { readonly type?: string; readonly timestamp?: string; readonly content?: unknown; readonly message?: { readonly role?: string; readonly toolName?: string; readonly content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n") : "";

// The jobs started in [since, until] whose end is not in the transcript up to until. Only tool results start a job (an
// assistant's own words quoting the text do not); tool results, notifications and user turns end one.
export const pendingBackground = (transcript: string, since = 0, until = Number.POSITIVE_INFINITY): BackgroundJob[] => {
  const open = new Map<string, BackgroundJob>();
  for (const line of transcript.split("\n")) {
    if (!HINT.test(line)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp ?? "");
    if (Number.isNaN(at) || at > until) continue;
    const role = e.message?.role;
    const text = e.type === "custom_message" ? textOf(e.content) : role === "toolResult" || role === "user" ? textOf(e.message?.content) : "";
    if (!text) continue;
    for (const re of ENDS) for (const m of text.matchAll(re)) if (m[1]) open.delete(m[1]);
    if (role === "toolResult" && e.message?.toolName === "task_cancel") for (const m of text.matchAll(/\b(st_[0-9a-z]+)\b/g)) if (m[1]) open.delete(m[1]);
    if (role !== "toolResult" || at < since || e.message?.toolName === "task_cancel" || e.message?.toolName === "task_output") continue;
    for (const [kind, re] of STARTS) for (const m of text.matchAll(re)) if (m[1] && !open.has(m[1])) open.set(m[1], { kind, id: m[1], at });
  }
  return [...open.values()];
};

// The lane's own session transcript (the session its pane's omo runs) and the agent's start, or undefined when either
// cannot be read. Jobs started before the agent process started died with the earlier process.
export const laneBackground = async (run: Runner, sessionsDir: string, pane: string, cwd: string, until = Number.POSITIVE_INFINITY): Promise<BackgroundJob[] | undefined> => {
  const hit = await resolveSession(pane, cwd, await procTable(run), { run, sessionsDir, backend: "aoe" });
  if (!hit.id || !hit.pid) return undefined;
  const dir = sessionDirFor(sessionsDir, cwd);
  let name: string | undefined;
  try {
    name = readdirSync(dir).find((n) => n.endsWith(`_${hit.id}.jsonl`));
  } catch {
    return undefined;
  }
  if (!name) return undefined;
  const started = Date.parse((await run(["ps", "-o", "lstart=", "-p", String(hit.pid)])).out.trim());
  return pendingBackground(readFileSync(join(dir, name), "utf8"), Number.isNaN(started) ? 0 : started, until);
};
