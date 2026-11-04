// An agent typed into a pane's interactive shell (herdr pane run, aoe) is that shell's foreground job. A freeze that sent
// SIGSTOP to the agent alone let the shell see its job stop: bash took the tty back, printed "[1]+ Stopped", cooked the tty
// (icanon, echo) and made the job a background one, so the SIGCONT of a thaw left omo running in the background, where the
// first key typed into the pane stopped it again with SIGTTIN (handover-simplify, w1:p26, 2026-11-03 15:41Z: the rollback
// thawed it, it stayed T for 18 hours behind its last "esc to interrupt" and freshness refused 54 rollovers as busy).
// Measured on herdr 0.9.5 (2026-11-04, pane w2:p2): with the shell stopped before the agent and resumed after it, the tty
// stays with the agent and its mode is untouched. jobSignal does that for every SIGSTOP and SIGCONT; resumeAgent repairs
// an agent that a stop without it already put in the background.
import { readFileSync, readlinkSync } from "node:fs";

import { isHerdrPane } from "./herdr.ts";
import type { Clock, Runner } from "./run.ts";

// /proc/<pid>/stat fields 3-8: state, parent, process group, session, tty foreground process group (tpgid, -1: no tty)
export type JobStat = { readonly pid: number; readonly state: string; readonly ppid: number; readonly pgrp: number; readonly session: number; readonly tpgid: number };
export type StatOf = (pid: number) => JobStat | undefined;

// undefined where there is no /proc (macOS, Windows): there nothing is bracketed or repaired
export const readStat: StatOf = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // the command name in field 2 may hold spaces and parentheses: the fields after it start past its last ")"
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, state: f[0] ?? "", ppid: Number(f[1]), pgrp: Number(f[2]), session: Number(f[3]), tpgid: Number(f[5]) };
  } catch {
    return undefined;
  }
};

// The interactive shell that takes the tty back when pid stops: pid is the tty's foreground job in its own process group,
// and its parent leads the session (a pane's shell). An agent leading its own session (a tmux pane running it directly) or
// a child of the agent has none.
const jobShell = (stat: StatOf, pid: number): JobStat | undefined => {
  const p = stat(pid);
  if (!p || p.tpgid <= 0 || p.pgrp !== p.tpgid || p.session === p.pid) return undefined;
  const shell = stat(p.ppid);
  return shell && shell.pid === p.session && shell.pgrp !== p.pgrp ? shell : undefined;
};

// stopped: state T; background: running, but another process group holds its tty, as its shell's background job
export type Hold = "stopped" | "background";
export const holdOf = (stat: StatOf, pid: number): Hold | undefined => {
  const p = stat(pid);
  if (!p) return undefined;
  if (p.state === "T") return "stopped";
  return p.tpgid > 0 && p.pgrp !== p.tpgid && p.session !== p.pid && stat(p.ppid)?.pid === p.session ? "background" : undefined;
};

// SIGSTOP to a shell's foreground job stops the shell first; SIGCONT to it resumes the shell after it. Other signals and
// other processes pass through as they are.
export const jobSignal = <S extends string>(signal: (pid: number, sig: S) => boolean, stat: StatOf = readStat): ((pid: number, sig: S) => boolean) => (pid, sig) => {
  if (sig !== "SIGSTOP" && sig !== "SIGCONT") return signal(pid, sig);
  const shell = jobShell(stat, pid);
  if (sig === "SIGSTOP") {
    if (shell && !signal(shell.pid, sig)) return false;
    const sent = signal(pid, sig);
    if (!sent && shell) signal(shell.pid, "SIGCONT" as S);
    return sent;
  }
  const sent = signal(pid, sig);
  if (shell && stat(shell.pid)?.state === "T") signal(shell.pid, sig);
  return sent;
};

export type ResumeIO = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => boolean;
  readonly stat?: StatOf;
  // the agent's tty (/dev/pts/N)
  readonly tty?: (pid: number) => string | undefined;
  // the process groups of the shell's jobs (its children outside its own group)
  readonly jobs?: (shell: JobStat) => Promise<number[]> | number[];
};

const ttyOf = (pid: number): string | undefined => {
  try {
    const t = readlinkSync(`/proc/${pid}/fd/0`);
    return t.startsWith("/dev/") ? t : undefined;
  } catch {
    return undefined;
  }
};

const jobsOf = (run: Runner, stat: StatOf) => async (shell: JobStat): Promise<number[]> => {
  const kids = (await run(["ps", "-o", "pid=", "--ppid", String(shell.pid)])).out.split("\n").map(Number).filter((n) => n > 0);
  return [...new Set(kids.flatMap((k) => stat(k)?.pgrp ?? []).filter((g) => g !== shell.pgrp))];
};

// libuv's raw mode (uv_tty_set_mode UV_TTY_MODE_RAW), the mode omo runs its tty in: measured equal, stty -g for stty -g
const RAW = ["-brkint", "-icrnl", "-inpck", "-istrip", "-ixon", "-isig", "-icanon", "-iexten", "-echo", "cs8", "opost", "onlcr"];
const FG_WAIT_MS = 10_000;
const POLL_MS = 500;
const REDRAW_MS = 500;

const foreground = (s: JobStat | undefined): boolean => !!s && s.state !== "T" && s.tpgid > 0 && s.pgrp === s.tpgid;
const where = (s: JobStat | undefined): string => (s ? `state ${s.state}, tty foreground group ${s.tpgid}, its group ${s.pgrp}` : "gone");

// Brings a pane's agent back to the running foreground job of its tty, as the lead did by typing fg: a stopped foreground
// job is continued; a background one is brought forward with fg typed into its shell (its pending input dropped first:
// keys sent while the shell held the tty pile up on its prompt), and the raw mode bash took away is given back, with a resize that
// makes omo draw its screen again. AGENT_RUNNING (nothing to do), AGENT_RESUMED, AGENT_RESUME_FAIL or AGENT_GONE.
export const resumeAgent = async (io: ResumeIO, pane: string, pid: number): Promise<string> => {
  const stat = io.stat ?? readStat;
  const first = stat(pid);
  if (!first) return `AGENT_GONE ${pane} agent ${pid}`;
  // no tty to own (no /proc, or a process without one): nothing to check
  if (first.state !== "T" && (first.tpgid <= 0 || foreground(first))) return `AGENT_RUNNING ${pane} agent ${pid}`;
  const done: string[] = [];
  if (first.state === "T" && first.pgrp === first.tpgid) {
    io.signal(-first.pgrp, "SIGCONT");
    done.push("its process group continued");
  }
  const shell = stat(first.ppid);
  if (shell && shell.pid === first.session && shell.state === "T") {
    io.signal(shell.pid, "SIGCONT");
    done.push("its shell continued");
  }
  let now = stat(pid);
  if (!foreground(now) && now && shell && shell.pid === now.session && now.tpgid === shell.pgrp) {
    const jobs = await (io.jobs ?? jobsOf(io.run, stat))(shell);
    if (jobs.length !== 1 || jobs[0] !== now.pgrp) return `AGENT_RESUME_FAIL ${pane} agent ${pid}: the shell ${shell.pid} holds ${jobs.length} jobs, so fg could pick another; type fg with the job of pid ${pid} in the pane (${where(now)})`;
    // a background omo that runs waits on the tty too: the line typed next would stop it (SIGTTIN) instead of reaching
    // the shell (herdr QA 2026-11-04), so it is stopped first; fg continues it
    if (now.state !== "T") {
      io.signal(-now.pgrp, "SIGSTOP");
      for (let waited = 0; stat(pid)?.state !== "T" && waited < FG_WAIT_MS; waited += POLL_MS) await io.clock.sleep(POLL_MS);
      done.push("stopped so that only the shell reads the line");
    }
    // ctrl-C first: the shell is the tty's foreground group (the agent a stopped background job), so it drops its whole
    // pending input (text after the cursor and an open quote's continuation lines too; ctrl-U kills only what is before
    // the cursor) and draws a fresh prompt for fg alone (herdr QA 2026-11-04)
    if (isHerdrPane(pane)) await io.run(["herdr", "pane", "send-text", pane, "\x03"]);
    else await io.run(["tmux", "send-keys", "-t", pane, "-l", "\x03"]);
    await io.clock.sleep(REDRAW_MS);
    if (isHerdrPane(pane)) await io.run(["herdr", "pane", "run", pane, "fg"]);
    else {
      await io.run(["tmux", "send-keys", "-t", pane, "-l", "fg"]);
      await io.run(["tmux", "send-keys", "-t", pane, "Enter"]);
    }
    done.push("fg typed into the shell");
    for (let waited = 0; !foreground(stat(pid)) && waited < FG_WAIT_MS; waited += POLL_MS) await io.clock.sleep(POLL_MS);
    now = stat(pid);
    const tty = (io.tty ?? ttyOf)(pid);
    if (foreground(now) && tty) {
      const mode = (await io.run(["stty", "-F", tty, "-a"])).out;
      if (/(^|\s)icanon(\s|$)/.test(mode)) {
        await io.run(["stty", "-F", tty, ...RAW]);
        done.push("raw tty mode given back");
      }
      // a width change makes omo lay out and paint its whole screen again (a height change repaints only changed lines,
      // and bash's lines stay on screen: herdr QA 2026-11-04)
      const cols = Number((await io.run(["stty", "-F", tty, "size"])).out.trim().split(/\s+/)[1]);
      if (cols > 1) {
        await io.run(["stty", "-F", tty, "cols", String(cols - 1)]);
        // omo must see the narrower width before it gets the old one back, or the two changes read as none
        await io.clock.sleep(REDRAW_MS);
        await io.run(["stty", "-F", tty, "cols", String(cols)]);
        done.push("redrawn");
      }
    }
  }
  now = stat(pid);
  if (foreground(now) || (now && now.tpgid <= 0 && now.state !== "T")) return `AGENT_RESUMED ${pane} agent ${pid}: ${done.join(", ") || "it runs again"}`;
  return `AGENT_RESUME_FAIL ${pane} agent ${pid}: ${done.length ? `${done.join(", ")}, still` : "it is"} not the running foreground job (${where(now)})`;
};
