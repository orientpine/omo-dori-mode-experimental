import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, sessionFor } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sendVerified } from "./panes.ts";
import { type AutoturnMark, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { procTable } from "./session-id.ts";

// omo (senpi) stops starting turns on its own once it started engineTurns.maxPerUserInput (150) of them since the last
// user message, or engineTurns.maxToolFreePerMinute (12) without a tool call in a minute: goal continuations, monitor
// and task notifications all count. Each refused start appends a custom "engine-turn-limit" entry to the session
// transcript and shows "Paused: the agent started N turns on its own ... Send any message to continue." A user message
// (or a "." manual continue / continue-from-leaf) lifts it; an engine turn that starts after it means the limit no longer
// holds (raised settings). A paused session still shows its monitors (◉ watching), so its screen looks busy.
export type AutoturnPause = { readonly since: string; readonly last: string; readonly turns: number; readonly reason: string };

type Entry = { readonly type?: string; readonly customType?: string; readonly timestamp?: string; readonly data?: { readonly reason?: string; readonly sinceUserInput?: number }; readonly message?: { readonly role?: string } };

const USER_DIRECTED = new Set(["manual-continue", "continue-from-leaf"]);
// a line without any of these can neither pause nor lift a pause; it is not parsed
const HINT = /"role":"user"|engine-turn-(?:limit|start)|manual-continue|continue-from-leaf/;

// The pause the transcript ends in, or undefined when its last turn limit was lifted (or there is none).
export const autoturnPause = (transcript: string): AutoturnPause | undefined => {
  let pause: AutoturnPause | undefined;
  for (const line of transcript.split("\n")) {
    if (!HINT.test(line)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const lifted = (e.type === "message" && e.message?.role === "user") || (e.type === "custom_message" && USER_DIRECTED.has(e.customType ?? "")) || (e.type === "custom" && e.customType === "engine-turn-start");
    if (lifted) pause = undefined;
    else if (e.type === "custom" && e.customType === "engine-turn-limit") {
      const at = e.timestamp ?? "";
      const turns = Number(e.data?.sinceUserInput ?? 0);
      pause = pause ? { ...pause, last: at, turns: Math.max(pause.turns, turns) } : { since: at, last: at, turns, reason: String(e.data?.reason ?? "") };
    }
  }
  return pause;
};

// the end of the transcript is enough: a lift always comes after the limit entries it lifts
const TAIL_BYTES = 2 * 1024 * 1024;
const tailOf = (path: string): string => {
  const text = readFileSync(path, "utf8");
  return text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
};

const DAY_MS = 24 * 60 * 60_000;
const leadMarkPath = (deps: FlowDeps): string => join(deps.config.stateDir, "autoturn-lead.json");
const readLeadMark = (deps: FlowDeps): AutoturnMark | undefined => {
  const path = leadMarkPath(deps);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AutoturnMark;
  } catch {
    return undefined;
  }
};

const laneText = (lane: Lane, pause: AutoturnPause, n: number, max: number): string =>
  `[LEAD] autoturn: omo paused this session after it started ${pause.turns} turns on its own since the last message (senpi engine turn limit, ${pause.reason}). This message lifts the pause: continue from where it stopped${statusOf(lane) === "paused" ? "; the lead paused this lane, so keep waiting and start no new work" : ""}. If you only wait for a set time, wait on one monitor gate for it instead of goal continuations or repeated wakes. (watch resume ${n}/${max} in 24h)`;
const leadText = (pause: AutoturnPause, n: number, max: number): string =>
  `[DORI] LANE_AUTOTURN_PAUSED lead: omo paused this session after it started ${pause.turns} turns on its own since the last message (${pause.reason}); this message lifts it. Read the lanes log and the inbox for what arrived while it was paused. (watch resume ${n}/${max} in 24h)`;

// LANE_AUTOTURN_PAUSED once per pause of a lane's session (working, not-done or paused by the lead) or the lead's; up to
// autoturnResumeMax times in 24 hours per session it also types a short message that lifts the pause (to the lead its
// monitors cannot do that: a monitor notification is one more engine turn). Past the cap it only reports.
export const autoturnTick = async (deps: FlowDeps): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => l.pane && ["working", "not-done", "paused"].includes(statusOf(l)));
  const lead = deps.config.leadPane;
  if (!lanes.length && !lead) return [];
  const [sessions, table] = await Promise.all([aoeSessions(deps.run), procTable(deps.run)]);
  const now = deps.clock.now();
  const max = deps.config.autoturnResumeMax;
  const out: string[] = [];
  const targets: { readonly lane?: Lane; readonly pane: string; readonly cwd: string }[] = [
    ...lanes.map((lane) => ({ lane, pane: lane.pane ?? "", cwd: lane.cwd ?? sessionFor(sessions, lane.pane ?? "")?.path ?? "" })),
    ...(lead && !lanes.some((l) => l.pane === lead) ? [{ pane: lead, cwd: sessionFor(sessions, lead)?.path ?? "" }] : []),
  ];
  for (const t of targets) {
    if (!t.cwd || !sessionFor(sessions, t.pane)) continue;
    const key = t.lane?.key ?? "lead";
    let pause: AutoturnPause | undefined;
    try {
      const file = await sessionFile(deps.run, deps.config.sessionsDir, t.pane, t.cwd, table);
      pause = file ? autoturnPause(tailOf(file.path)) : undefined;
    } catch (e) {
      out.push(`LANE_WATCH_WARN autoturn check ${key}: ${String(e).slice(0, 160)}`);
      continue;
    }
    const mark = t.lane ? t.lane.autoturn : readLeadMark(deps);
    if (!pause || mark?.since === pause.since) continue;
    const resumes = (mark?.resumes ?? []).filter((at) => now - Date.parse(at) < DAY_MS);
    const head = `LANE_AUTOTURN_PAUSED ${key} ${t.pane} ${pause.turns} turns on its own (${pause.reason}) since ${pause.since}`;
    let tail: string;
    if (resumes.length >= max) tail = `not resumed: ${resumes.length} resumes in 24h already (autoturnResumeMax ${max}), the lead decides`;
    else {
      const n = resumes.length + 1;
      const ok = await sendVerified(deps.run, deps.clock, deps.config, t.pane, t.lane ? laneText(t.lane, pause, n, max) : leadText(pause, n, max));
      if (ok) resumes.push(iso(deps.clock));
      tail = ok ? `resumed ${n}/${max} in 24h` : "resume NOT_SUBMITTED: the message did not reach the pane";
    }
    const next: AutoturnMark = { since: pause.since, resumes };
    if (t.lane) await deps.registry.patch(t.lane.key, { autoturn: next });
    else writeFileSync(leadMarkPath(deps), `${JSON.stringify({ pane: t.pane, ...next })}\n`);
    out.push(`${head}; ${tail}`);
  }
  return out;
};
