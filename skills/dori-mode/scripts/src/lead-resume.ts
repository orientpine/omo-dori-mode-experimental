import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { target } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { hcRead, isHcPane } from "./hc-pane.ts";
import { herdrOk, herdrReadAnsi, isHerdrPane } from "./herdr.ts";
import { holdOf, jobSignal, resumeAgent, type StatOf } from "./job-control.ts";
import { ownerRows, placeOf, tailOf } from "./lead-limit.ts";
import { waitingOwnerRows } from "./owner-waiting.ts";
import { execOf } from "./run.ts";
import { hcCall } from "./runtime/hc/exec.ts";

// 2026-11-09 02:18Z the lead's omo stopped (T, its shell holding the tty) and stayed so until 07:20Z: LANE_SUSPENDED named it
// once, the inbox monitor kept waking a process that could not read, and every LEAD_OWNER_WAITING ended NOT_SUBMITTED, so the
// owner's messages went unanswered for five hours. dori watch now brings the lead back when it names it, and retries each tick:
// - resumeAgent first: a stopped foreground group is continued, a cooked tty gets its raw mode back and a redraw; no key typed;
// - a job its shell holds needs fg typed in that shell, the one key this watch types into a shell, and only at an empty prompt
//   (atEmptyPrompt), at most FG_MAX times per stop, because a typed line races whoever else types there (review of #332, round 5);
// - LEAD_RESUMED <pane> <pid> or LEAD_RESUME_FAIL <pane> <why>, a new line only when the reason changes;
// - the owner hears one line per outcome per agent: a lead that keeps stopping is told once, a repair that then fails once more.
// Only the lead: a lane stays read-only here. lane-death.ts keeps panes a handover froze or is moving out of this.

const FG_MAX = 3;
const FG_CHECKS = 15;
const FG_CHECK_MS = 200;
const DAY_MS = 24 * 60 * 60_000;
const INBOX_TAIL_BYTES = 512 * 1024;

export type LeadResumeIO = { readonly stat: StatOf; readonly signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => boolean; readonly tty?: (pid: number) => string | undefined; readonly jobGroups?: (shellPid: number) => Promise<readonly number[] | undefined> };

export const leadSignal = jobSignal<"SIGSTOP" | "SIGCONT">((pid, sig) => {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
});

const PROMPT = /^(?:\(\S+\) )?[^\s@]+@[^\s:]+:\S*[$#](?= |$)/;
const JOB_STOPPED = /^\[\d+\][+-]?\s+Stopped\b/;
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "y");

// a row's text, and for each of its characters whether a colour was on: an SGR 0 or an empty one turns the colour off
const cells = (row: string): { readonly text: string; readonly coloured: readonly boolean[] } => {
  let text = "";
  const coloured: boolean[] = [];
  let on = false;
  for (let i = 0; i < row.length; ) {
    SGR.lastIndex = i;
    const sgr = SGR.exec(row);
    if (sgr) {
      const first = sgr[1]?.split(";")[0] ?? "";
      if (first === "" || first === "0") on = (sgr[1] ?? "").split(";").some((n) => n === "38" || n === "48");
      else if (first === "38" || first === "48") on = true;
      i += sgr[0].length;
      continue;
    }
    const ch = String.fromCodePoint(row.codePointAt(i) ?? 0);
    text += ch;
    for (let n = 0; n < ch.length; n++) coloured.push(on);
    i += ch.length;
  }
  return { text, coloured };
};

// True only when the row right under the newest "[n]+ Stopped" line is a user@host:path$ prompt with no input after it and no
// later prompt sits below it. Measured on herdr 0.9.5 with a real omo (2026-11-09): bash prints its prompt over omo's screen
// and erases nothing, so omo's status text stays both below the prompt and after it on its own row, in omo's colours, and
// herdr shows no cursor. What bash echoes as input carries no colour, so text after the prompt counts as old only when every
// visible character of it is coloured. Any other prompt shape, or a screen read without colours, is not recognised: no key.
export const atEmptyPrompt = (screen: string): boolean => {
  const rows = screen.split("\n").map((r) => cells(r.replace(/\r$/, "")));
  const job = rows.findLastIndex((r) => JOB_STOPPED.test(r.text));
  const row = rows[job + 1];
  if (job < 0 || !row) return false;
  const prompt = PROMPT.exec(row.text)?.[0];
  if (prompt === undefined) return false;
  for (let i = prompt.length + 1; i < row.text.length; i++) if (row.text[i]?.trim() && !row.coloured[i]) return false;
  return !rows.slice(job + 2).some((r) => PROMPT.test(r.text));
};

type Told = "resumed" | "failed";
type Seen = { readonly pid: number; readonly incident?: string; readonly fgTyped: number; readonly reason?: string };
type Notice = { readonly key: string; readonly pane: string; readonly pid: number; readonly kind: Told; readonly text: string; readonly postedAt?: string };

const recordFile = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-resume.json");
const noticesFile = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-resume-notices.json");
const readSeen = (deps: FlowDeps, pid: number): Seen => {
  try {
    const r = JSON.parse(readFileSync(recordFile(deps), "utf8")) as Seen;
    return r.pid === pid ? r : { pid, fgTyped: 0 };
  } catch {
    return { pid, fgTyped: 0 };
  }
};
const readNotices = (deps: FlowDeps): Notice[] => {
  try {
    const rows = JSON.parse(readFileSync(noticesFile(deps), "utf8")) as Notice[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};
const writeNotices = (deps: FlowDeps, rows: readonly Notice[]): void => void writeFileSync(noticesFile(deps), `${JSON.stringify(rows)}\n`);
const queueNotice = (deps: FlowDeps, pane: string, pid: number, kind: Told, text: string): void => {
  const rows = readNotices(deps);
  const key = `${pid}:${kind}`;
  if (!rows.some((n) => n.key === key)) writeNotices(deps, [...rows, { key, pane, pid, kind, text }]);
};

const screenWithColours = async (deps: FlowDeps, pane: string): Promise<string> => {
  if (isHcPane(pane)) return hcRead(deps.run, pane, 0);
  return isHerdrPane(pane) ? herdrReadAnsi(deps.run, pane) : (await deps.run(["tmux", "capture-pane", "-p", "-e", "-J", "-t", target(pane)])).out;
};

const typeFg = async (deps: FlowDeps, pane: string): Promise<boolean> => {
  if (isHcPane(pane)) return hcCall(execOf(deps.run), ["send", pane.slice("hc:".length), "--", "fg"], { redact: "fg" }).then(() => true, () => false);
  if (isHerdrPane(pane)) return herdrOk(deps.run, ["pane", "send-text", pane, "fg\r"]);
  if ((await deps.run(["tmux", "send-keys", "-t", target(pane), "-l", "--", "fg"])).code !== 0) return false;
  return (await deps.run(["tmux", "send-keys", "-t", target(pane), "Enter"])).code === 0;
};

type Tried = { readonly ok: boolean; readonly reason?: string; readonly typed?: boolean; readonly skipped?: boolean };

// Every live direct child's process group is a shell job, including a pipeline whose group leader already exited.
// Bare fg is safe only when the lead is the sole such group: with two jobs bash's current job can be the other one.
const shellJobGroups = async (deps: FlowDeps, shellPid: number): Promise<readonly number[] | undefined> => {
  const r = await deps.run(["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,stat="]);
  if (r.code !== 0) return undefined;
  const groups = new Set<number>();
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const [ppid, pgrp] = [Number(m[2]), Number(m[3])];
    if (ppid === shellPid && pgrp !== shellPid && !m[4]?.startsWith("Z")) groups.add(pgrp);
  }
  return [...groups];
};

const tryResume = async (deps: FlowDeps, io: LeadResumeIO, pane: string, pid: number, fgTyped: number, off: () => boolean): Promise<Tried> => {
  if (off()) return { ok: false, skipped: true };
  const resumeIO = { run: deps.run, clock: deps.clock, signal: io.signal, stat: io.stat, ...(io.tty ? { tty: io.tty } : {}) };
  const line = await resumeAgent(resumeIO, pane, pid);
  if (line.startsWith("AGENT_GONE")) return { ok: false, reason: "its agent is gone" };
  const liveRunning = (): boolean => {
    const s = io.stat(pid);
    return !!s && s.state !== "T" && !holdOf(io.stat, pid);
  };
  if (!line.startsWith("AGENT_RESUME_FAIL")) return liveRunning() ? { ok: true } : { ok: false, reason: `no live running agent remains (${line})` };
  const agent = io.stat(pid);
  const shell = agent ? io.stat(agent.ppid) : undefined;
  if (!agent || !shell || shell.pid !== agent.session || shell.pgrp !== agent.tpgid || shell.state === "T") return { ok: false, reason: "another process holds its tty, so nothing was typed" };
  const jobs = await (io.jobGroups?.(shell.pid) ?? shellJobGroups(deps, shell.pid));
  if (!jobs) return { ok: false, reason: "its shell jobs could not be read, so nothing was typed" };
  if (jobs.length !== 1 || jobs[0] !== pid) return { ok: false, reason: "its shell has another job too; bare fg could resume another job, so nothing was typed" };
  if (fgTyped >= FG_MAX) return { ok: false, reason: `fg was typed ${FG_MAX} times and it still does not run; type fg in ${pane} by hand` };
  if (!atEmptyPrompt(await screenWithColours(deps, pane))) return { ok: false, reason: `no empty shell prompt under its Stopped line, so nothing was typed; type fg in ${pane} by hand` };
  if (off()) return { ok: false, skipped: true };
  if (!(await typeFg(deps, pane))) return { ok: false, reason: "typing fg into its pane failed", typed: true };
  for (let i = 0; i < FG_CHECKS; i++) {
    const s = io.stat(pid);
    if (!s || s.pgrp === s.tpgid) break;
    await deps.clock.sleep(FG_CHECK_MS);
  }
  if (off()) return { ok: false, skipped: true, typed: true };
  const after = await resumeAgent(resumeIO, pane, pid);
  if (after.startsWith("AGENT_GONE")) return { ok: false, reason: "its agent is gone after fg", typed: true };
  return liveRunning() ? { ok: true, typed: true } : { ok: false, reason: `fg was typed and it still does not run (${after})`, typed: true };
};

const ownerChannel = (deps: FlowDeps): string => {
  const inbox = deps.ownerInbox;
  // where his newest message still waiting on this lead is, as LEAD_OWNER_WAITING picks it (owner-waiting.ts)
  const tail = inbox && existsSync(inbox.path) ? tailOf(inbox.path, INBOX_TAIL_BYTES) : "";
  const rows = inbox && tail ? waitingOwnerRows(ownerRows(tail, inbox.ownerId).filter((r) => deps.clock.now() - r.at < DAY_MS), tail, inbox.path) : [];
  return placeOf(rows, inbox?.ownerChannel ?? "");
};

// A notice stays pending until Discord accepts it. The watch flushes it even after the lead runs again, and a posted
// notice remains in the file so a later stop of the same agent does not tell the owner twice.
const flushNotices = async (deps: FlowDeps, pane: string, includeUnavailable = false): Promise<string[]> => {
  const rows = readNotices(deps);
  const pending = rows.filter((n) => n.pane === pane && !n.postedAt);
  if (!pending.length) return [];
  const channel = ownerChannel(deps);
  const cannot = !deps.postOwner ? "no bot token" : !channel ? "no owner channel" : "";
  if (cannot && !includeUnavailable) return [];
  const out: string[] = [];
  let next = rows;
  for (const notice of pending) {
    const posted = cannot ? `NOT_POSTED ${cannot}` : await deps.postOwner!(channel, notice.text).then((id) => `POSTED ${channel} ${id}`, (e: unknown) => `NOT_POSTED ${String(e).slice(0, 160)}`);
    out.push(`LEAD_RESUME_NOTICE ${pane} ${posted}`);
    if (posted.startsWith("POSTED ")) next = next.map((n) => (n.key === notice.key ? { ...n, postedAt: new Date(deps.clock.now()).toISOString() } : n));
  }
  if (next !== rows) writeNotices(deps, next);
  return out;
};

export const leadResumeNoticeTick = async (deps: FlowDeps, pane: string): Promise<string[]> => flushNotices(deps, pane);

// off: the lead is frozen or being moved now, read again right before anything is sent to it
export const leadResumeTick = async (deps: FlowDeps, io: LeadResumeIO, pane: string, pid: number, incident: string, off: () => boolean): Promise<string[]> => {
  const known = readSeen(deps, pid);
  const fresh: Seen = known.incident === incident ? known : { pid, incident, fgTyped: 0 };
  const got = await tryResume(deps, io, pane, pid, fresh.fgTyped, off);
  if (got.skipped) return [];
  const out: string[] = [];
  const kind: Told = got.ok ? "resumed" : "failed";
  const words = deps.config.discord;
  const newReason = !got.ok && got.reason !== fresh.reason;
  if (got.ok) out.push(`LEAD_RESUMED ${pane} ${pid}`);
  else if (newReason) out.push(`LEAD_RESUME_FAIL ${pane} ${got.reason}`);
  const event = got.ok || newReason;
  if (event) queueNotice(deps, pane, pid, kind, got.ok ? words.leadResumedText : words.leadResumeFailText.replaceAll("{reason}", got.reason ?? ""));
  out.push(...(await flushNotices(deps, pane, event)));
  const next: Seen = { pid, incident, fgTyped: fresh.fgTyped + (got.typed ? 1 : 0), ...(got.ok || !got.reason ? {} : { reason: got.reason }) };
  writeFileSync(recordFile(deps), `${JSON.stringify(next)}\n`);
  return out;
};
