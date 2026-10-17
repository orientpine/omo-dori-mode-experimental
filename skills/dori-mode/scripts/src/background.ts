import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";
import { type Proc, procTable, resolveSession, sessionDirFor } from "./session-id.ts";

// Background work an omo session started and is still waiting on, read from its session transcript: a detached eval
// cell, a background (or auto-detached) bash session, a background task child. omo shows none of these on its status
// line, so a lane that ended its turn to wait for one looks idle on screen. Each start is read from the tool's own result
// (never from text it printed: a lane that greps logs or omo's source must not look busy), each end from a delivered
// notification or a kill/cancel result; a start without its end is still running.
export type BackgroundJob = { readonly kind: "eval" | "bash" | "task"; readonly id: string; readonly at: number };

const BASH_START = /^(?:Command running in background with ID: |Command is still running; auto-detached to background with ID: )(bash_\w+)/;
const TASK_START = /\((st_[0-9a-z]+), running\)/;
const ENDS: readonly RegExp[] = [
  /Detached eval cell (\S+) \(/g,
  /Background terminal session (bash_\w+) finished/g,
  /Killed (bash_\w+)\./g,
  /\b(bash_\w+) exited\b/g,
  /task completion [^\n]*?\bid:(st_[0-9a-z]+)/g,
  /Task (st_[0-9a-z]+) had already finished/g,
];
// a line without any of these cannot start or end a job; it is not parsed
const HINT = /detached and is running|"bash_id"|in background with ID|auto-detached|st_[0-9a-z]+|Detached eval cell|is cancelled|Background terminal session|Killed bash_|bash_\w+ exited/;

type ToolCall = { readonly name?: string; readonly resultPreview?: string };
type TaskRun = { readonly task_id?: string; readonly status?: string };
type Details = TaskRun & { readonly bash_id?: string; readonly background?: boolean; readonly run_in_background?: boolean; readonly items?: readonly TaskRun[]; readonly toolCalls?: readonly ToolCall[] };
type Entry = { readonly type?: string; readonly timestamp?: string; readonly content?: unknown; readonly message?: { readonly role?: string; readonly toolName?: string; readonly toolCallId?: string; readonly content?: unknown; readonly details?: Details } };

const ENDING_TOOLS = new Set(["kill_bash", "task_cancel"]);
const EVAL_STOPPED = /^Eval cell (\S+) \(\w+\) is cancelled/;

// the jobs one tool result started: its own detached cell, the bash sessions and tasks it (or its cell's tool calls) put
// in the background
const startsOf = (tool: string, callId: string, text: string, d: Details | undefined): [BackgroundJob["kind"], string][] => {
  const out: [BackgroundJob["kind"], string][] = [];
  if (tool === "eval" && callId && text.startsWith(`Eval cell ${callId} detached and is running`)) out.push(["eval", callId]);
  if (tool === "bash" && d?.background && d.bash_id) out.push(["bash", d.bash_id]);
  if (tool === "task" && d?.run_in_background) for (const t of d.items ?? [d]) if (t.task_id && t.status === "running") out.push(["task", t.task_id]);
  for (const c of d?.toolCalls ?? []) {
    const bash = c.name === "bash" ? BASH_START.exec(c.resultPreview ?? "")?.[1] : undefined;
    const task = c.name === "task" && c.resultPreview?.startsWith("Started task ") ? TASK_START.exec(c.resultPreview)?.[1] : undefined;
    if (bash) out.push(["bash", bash]);
    if (task) out.push(["task", task]);
  }
  return out;
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n") : "";

// The jobs started in [since, until] whose end is not in the transcript up to until.
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
    const tool = e.message?.role === "toolResult" ? (e.message.toolName ?? "") : undefined;
    const text = e.type === "custom_message" ? textOf(e.content) : tool !== undefined ? textOf(e.message?.content) : "";
    if (e.type === "custom_message" || (tool && ENDING_TOOLS.has(tool))) for (const re of ENDS) for (const m of text.matchAll(re)) if (m[1]) open.delete(m[1]);
    const stopped = tool === "eval" ? EVAL_STOPPED.exec(text)?.[1] : undefined;
    if (stopped) open.delete(stopped);
    if (tool === "task_cancel") for (const m of text.matchAll(/\b(st_[0-9a-z]+)\b/g)) if (m[1]) open.delete(m[1]);
    if (tool === undefined || at < since) continue;
    for (const [kind, id] of startsOf(tool, e.message?.toolCallId ?? "", text, e.message?.details)) if (!open.has(id)) open.set(id, { kind, id, at });
  }
  return [...open.values()];
};

// The lane's own session transcript (the session its pane's omo runs) and the agent's start, or undefined when either
// cannot be read. Jobs started before the agent process started died with the earlier process; jobs started before
// notBefore (a server or watcher left running for hours) are not what the lane waits on.
// The transcript file of the session a pane's omo runs, and that agent's pid, or undefined when either cannot be read.
export const sessionFile = async (run: Runner, sessionsDir: string, pane: string, cwd: string, table?: readonly Proc[]): Promise<{ readonly path: string; readonly pid: number } | undefined> => {
  const hit = await resolveSession(pane, cwd, table ?? (await procTable(run)), { run, sessionsDir, backend: "aoe" });
  if (!hit.id || !hit.pid) return undefined;
  const dir = sessionDirFor(sessionsDir, cwd);
  let name: string | undefined;
  try {
    name = readdirSync(dir).find((n) => n.endsWith(`_${hit.id}.jsonl`));
  } catch {
    return undefined;
  }
  return name ? { path: join(dir, name), pid: hit.pid } : undefined;
};

export const laneBackground = async (run: Runner, sessionsDir: string, pane: string, cwd: string, until = Number.POSITIVE_INFINITY, notBefore = 0): Promise<BackgroundJob[] | undefined> => {
  const file = await sessionFile(run, sessionsDir, pane, cwd);
  if (!file) return undefined;
  const started = Date.parse((await run(["ps", "-o", "lstart=", "-p", String(file.pid)])).out.trim());
  return pendingBackground(readFileSync(file.path, "utf8"), Math.max(Number.isNaN(started) ? 0 : started, notBefore), until);
};
