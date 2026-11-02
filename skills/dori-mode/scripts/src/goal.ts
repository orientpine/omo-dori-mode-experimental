import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { captureTmux, paneLife } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { paneTranscript, typeLine } from "./panes.ts";
import { sessionDirFor } from "./session-id.ts";

// A paused lane must not keep working through its omo goal: between turns omo starts the next one on its own while the
// goal is active, so a lane the lead paused kept spending turns (ported from dori-superagent 0057f49, #12, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/0057f49de9ae32f1bd0e38fe097d7430224bcb29). `dori pause` types
// `/goal pause` into the lane's session and reads the result back, `dori resume` types `/goal resume` for a goal the
// pause paused. omo keeps a session's goal in <session dir>/extensions/goal/<session id>.json ({"goal":{"status"}}),
// next to the transcript; when that file cannot be found the screen is read instead: omo prints "Goal paused" / "Goal
// active" at the start of a line (a side panel may follow on the same row), or "cannot update goal: no goal exists".

export type GoalRead = { readonly status: string } | "none" | "unknown";
export type GoalAct = "pause" | "resume";
export type GoalOutcome = { readonly outcome: "confirmed" | "no-goal" | "not-active" | "unconfirmed" | "failed"; readonly detail: string };

const WANT: Record<GoalAct, string> = { pause: "paused", resume: "active" };
// the goal status that can be changed by the command; anything else (complete, blocked, already paused) is left alone
const FROM: Record<GoalAct, string> = { pause: "active", resume: "paused" };
const SHOWN: Record<GoalAct, RegExp> = { pause: /^\s*Goal paused\b/, resume: /^\s*Goal active\b/ };
const NO_GOAL = /^\s*cannot update goal: no goal exists\b/;
const READ_BACK_TRIES = 10;

export const goalFileOf = (sessionPath: string): string | undefined => {
  const id = /_([^_]+)\.jsonl$/.exec(basename(sessionPath))?.[1];
  return id ? join(dirname(sessionPath), "extensions", "goal", `${encodeURIComponent(id)}.json`) : undefined;
};

export const readGoalFile = (file: string): GoalRead => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown";
  }
  try {
    const status = (JSON.parse(text) as { goal?: { status?: unknown } }).goal?.status;
    return typeof status === "string" ? { status } : "none";
  } catch {
    return "unknown";
  }
};

export const sessionGoal = async (deps: FlowDeps, pane: string): Promise<GoalRead> => {
  const path = await paneTranscript(deps.run, deps.config.sessionsDir, pane).catch(() => undefined);
  const file = path ? goalFileOf(path) : undefined;
  return file ? readGoalFile(file) : "unknown";
};

// The text of a transcript's first user message: what was typed to start the session (a lane's launch prompt).
const firstUserText = (transcript: string): string | undefined => {
  for (const line of transcript.split("\n")) {
    if (!line.includes('"user"')) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.map((p) => (p as { text?: unknown }).text).filter((t): t is string => typeof t === "string").join("\n") : "";
  }
  return undefined;
};

// The goal of the session started by the prompt holding `marker` (a lane's launch prompt names its unique key), among
// transcripts written since `since`. Matching by pid and start time can pick a sibling lane opened seconds apart in the
// same directory, since omo's child processes carry no PI_SESSION_ID; and only the first user message counts, so a lead
// or sibling that quoted the prompt (a captured pane in a tool result) is not taken for the lane. Both the cwd and its
// real path are searched: omo may keep a symlinked cwd's sessions under either.
export const laneGoal = (sessionsDir: string, cwd: string, marker: string, since: number): GoalRead => {
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  let found: GoalRead = "unknown";
  for (const dir of new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < since || !firstUserText(readFileSync(path, "utf8"))?.includes(marker)) continue;
      } catch {
        continue;
      }
      const file = goalFileOf(path);
      const goal = file ? readGoalFile(file) : "unknown";
      if (typeof goal === "object") return goal;
      if (goal === "none") found = "none";
    }
  }
  return found;
};

const count = (screen: string, re: RegExp): number => screen.split("\n").filter((l) => re.test(l)).length;

// Types /goal pause or /goal resume and reads the result back: the goal file's status, or (no file found) one more
// "Goal paused"/"Goal active" line on screen than before. A goal that is not in the state the command changes is left alone.
export const goalCommand = async (deps: FlowDeps, pane: string, act: GoalAct): Promise<GoalOutcome> => {
  const read = deps.readGoal ?? ((p: string) => sessionGoal(deps, p));
  const before = await read(pane);
  if (before === "none") return { outcome: "no-goal", detail: "no goal in its session" };
  if (before !== "unknown" && before.status !== FROM[act]) return { outcome: "not-active", detail: `its goal is ${before.status}, left as it is` };
  const screen = await captureTmux(deps.run, pane);
  const shownBefore = count(screen, SHOWN[act]);
  const noneBefore = count(screen, NO_GOAL);
  const why = await typeLine(deps.run, deps.clock, deps.config, pane, `/goal ${act}`);
  if (why) return { outcome: "failed", detail: `/goal ${act} not typed: ${why}` };
  for (let i = 0; i < READ_BACK_TRIES; i++) {
    await deps.clock.sleep(1_000);
    const now = await read(pane);
    if (now === "none") return { outcome: "no-goal", detail: "no goal in its session" };
    if (now !== "unknown") {
      if (now.status === WANT[act]) return { outcome: "confirmed", detail: `goal store reads ${now.status}` };
      continue;
    }
    const shown = await captureTmux(deps.run, pane);
    if (count(shown, SHOWN[act]) > shownBefore) return { outcome: "confirmed", detail: `screen shows Goal ${WANT[act]}` };
    if (count(shown, NO_GOAL) > noneBefore) return { outcome: "no-goal", detail: "omo says no goal exists" };
  }
  return { outcome: "unconfirmed", detail: `/goal ${act} typed but the goal was not read back ${WANT[act]} within ${READ_BACK_TRIES} s` };
};

export const liveSession = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  const life = await paneLife(deps.run, pane);
  return life.live ? undefined : life.how === "gone" ? "no tmux session" : `its program exited (status ${life.status})`;
};
