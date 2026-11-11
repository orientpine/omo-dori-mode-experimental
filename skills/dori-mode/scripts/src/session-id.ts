import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { tmuxPanePid } from "./aoe.ts";
import type { Backend } from "./config.ts";
import type { Runner } from "./run.ts";
import { isAgentCommand } from "./executable.ts";

// stat: the ps state letters ("S", "R+", "Z" for a zombie); absent when the table was built without it
// sid: the terminal session the process is in (Linux ps sid); absent or 0 when it cannot be told (macOS, Windows)
export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string; readonly stat?: string; readonly sid?: number; readonly startedAt?: string; readonly executable?: string };
export type SessionHit = { readonly id: string; readonly via: "argv" | "child-env" | "start-time" | "none"; readonly pid?: number };

// omo on Linux and macOS (senpi's bundle under bun, or the omo command), and on Windows (the same bundle path with
// backslashes, or omo.exe / omo-windows-x64.exe, quoted as Win32_Process shows a command line with spaces in its path)
export const AGENT = { test: isAgentCommand } as const;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
// a child's PI_SESSION_FILE: the value runs up to its .jsonl, so a path with spaces stays whole
export const ENV_FILE = /(?:^|\s)PI_SESSION_FILE=(.+?\.jsonl)(?=\s|$)/;
export const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

// Win32_Process has no suspension state. NtSuspendProcess puts every thread in Wait/Suspended; query that state too,
// so a different invocation's pane messaging guard sees a freeze even before handover writes its replacement record.
// This script is static: no process names, PIDs, paths or arguments are interpolated as PowerShell code.
export const WIN_PROCS = ["powershell", "-NoProfile", "-NonInteractive", "-Command", "$stopped = @{}; Get-Process | ForEach-Object { try { $threads = @($_.Threads); if ($threads.Count -gt 0 -and @($threads | Where-Object { $_.ThreadState -ne 'Wait' -or $_.WaitReason -ne 'Suspended' }).Count -eq 0) { $stopped[$_.Id] = $true } } catch {} }; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,@{Name='StartedAt';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}},@{Name='Stat';Expression={if ($stopped.ContainsKey([int]$_.ProcessId)) {'T'} else {''}}} | ConvertTo-Json -Compress"];

export const winProcs = (json: string): Proc[] => {
  try {
    const rows: unknown = JSON.parse(json || "[]");
    const table = (Array.isArray(rows) ? rows : [rows]).flatMap((r: unknown): Proc[] => {
      if (typeof r !== "object" || r === null || !("ProcessId" in r) || typeof r.ProcessId !== "number" || !r.ProcessId) return [];
      return [{
        pid: r.ProcessId,
        ppid: "ParentProcessId" in r && typeof r.ParentProcessId === "number" ? r.ParentProcessId : 0,
        cmd: "CommandLine" in r && typeof r.CommandLine === "string" ? r.CommandLine : "",
        ...("ExecutablePath" in r && typeof r.ExecutablePath === "string" ? { executable: r.ExecutablePath } : {}),
        ...("StartedAt" in r && typeof r.StartedAt === "string" ? { startedAt: r.StartedAt } : {}),
        stat: "Stat" in r && r.Stat === "T" ? "T" : "",
      }];
    });
    const byPid = new Map(table.map((p) => [p.pid, p]));
    // A parent PID can have been reused after the child's original parent exited.
    return table.map((p) => Date.parse(byPid.get(p.ppid)?.startedAt ?? "") > Date.parse(p.startedAt ?? "") ? { ...p, ppid: 0 } : p);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

// On Linux the table carries each process's session id too (macOS ps has no sid column): herdr ends every process of a
// pane's terminal session when it closes the pane, so a job that left the pane's process tree dies with it all the same.
export const procTable = async (run: Runner, platform: string = process.platform): Promise<Proc[]> => {
  if (platform === "win32") return winProcs((await run(WIN_PROCS)).out);
  const linux = platform === "linux";
  // -ww: whole command lines, even when COLUMNS is set (procps cuts the command column to it otherwise)
  return (await run(["ps", "-A", "-ww", "-o", linux ? "pid=,ppid=,sid=,stat=,command=" : "pid=,ppid=,stat=,command="])).out.split("\n").flatMap((line) => {
    // the sid column is optional in what is read: the state letters are never a number
    const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)\s+)?(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), ...(m[3] ? { sid: Number(m[3]) } : {}), stat: m[4] ?? "", cmd: m[5] ?? "" }] : [];
  });
};

// A zombie ("[bash] <defunct>"): it already ended and only waits for its parent to collect it, so no work dies with it.
export const ended = (p: Proc): boolean => (p.stat ?? "").startsWith("Z") || /<defunct>\s*$/.test(p.cmd);

export const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  const seen = new Set([root]);
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

// The pane's agent: the topmost agent process at or under its shell, read in tree order. Its command line is not searched
// for "mcp": a herdr lane carries its own prompt there (a lane keyed mcp-fix), and the agent's MCP servers sit below it.
export const topAgent = (table: readonly Proc[], shell: number): Proc | undefined =>
  shell ? [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].find((p) => AGENT.test(p.cmd) && !ended(p)) : undefined;

export const sessionDirFor = (sessionsDir: string, cwd: string): string => join(sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Windows command line split the way CommandLineToArgvW splits it: quotes group words, 2n backslashes before a quote
// give n backslashes and toggle quoting, 2n+1 give n and a literal quote, "" inside quotes is a literal quote, and other
// backslashes are literal.
export const winArgv = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') { word += "\\".repeat(Math.floor(n / 2)); if (n % 2) word += '"'; else { quoted = !quoted; } }
      else { word += "\\".repeat(n); i--; }
      inWord = true;
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') { word += '"'; i++; } else quoted = !quoted;
      inWord = true;
    } else if ((c === " " || c === "\t") && !quoted) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else { word += c; inWord = true; }
  }
  if (inWord) out.push(word);
  return out;
};

// The exact session an agent's command line names: --session-id <id> (omo: "use exact project session ID"), or
// --session <path to the session .jsonl> (the uuid at the end of that file name; aoe resumes a session this way) or a
// whole uuid. "" when it names none, or only a partial uuid omo would resolve itself (which session that is, is not known).
export const argvSessionId = (argv: readonly string[]): string => {
  const flagAt = argv.findIndex((a) => a === "--session" || a === "--session-id");
  const value = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  if (argv[flagAt] === "--session-id") return value;
  if (value.endsWith(".jsonl")) return SESSION_FILE.exec(value.split(/[\\/]/).pop() ?? "")?.[5] ?? "";
  return UUID.test(value) ? value : "";
};

// The flags with which omo picks its session itself (omo --help: --session, --session-id, --continue/-c, --resume/-r,
// --fork, --rebind, --no-session), as a separate word or as --flag=value.
const SELECTORS = ["--session", "--session-id", "--continue", "-c", "--resume", "-r", "--fork", "--rebind", "--no-session"];
export const hasSessionSelector = (argv: readonly string[]): boolean => argv.some((a) => SELECTORS.some((s) => a === s || a.startsWith(`${s}=`)));

// seen: the session recorded before for this same agent process (herdr-sessions.ts), when the caller keeps one
export type SessionDeps = { readonly run: Runner; readonly sessionsDir: string; readonly backend?: Backend; readonly listDir?: (dir: string) => readonly string[]; readonly seen?: (agent: Proc) => Promise<{ readonly id: string; readonly log?: string | undefined } | undefined>; readonly observed?: (id: string, sessions: readonly { readonly id: string; readonly log?: string | undefined }[]) => void };

export const shellPidOf = async (pane: string, deps: SessionDeps): Promise<number> => {
  // the pane id says its backend, whatever the config says (aoe.ts tmuxPanePid: herdr process-info for a herdr pane id)
  return tmuxPanePid(deps.run, pane);
};

// The environment of a process as ps eww prints it after its arguments: the command the table shows for it (ps -A, the
// same arguments) is cut off first, so a PI_SESSION_ID= among its arguments is no environment. "" when the line does not
// start with that command (the pid runs another one now), and on Windows, whose environment is not read.
export const procEnv = async (run: Runner, p: Proc): Promise<string> => {
  if (process.platform === "win32" || !p.cmd) return "";
  const line = (await run(["ps", "eww", "-o", "command=", "-p", String(p.pid)])).out.replace(/\r?\n$/, "");
  return line.startsWith(p.cmd) ? line.slice(p.cmd.length) : "";
};

// Whether omo handed child the session in its env: senpi sets it for its bash tools' shells and kernels (core/tools/bash.js,
// kernels/session-env.ts); a monitor (SENPI_MONITOR_ID) or the provider keeps the agent's own env (launched; MooDori hc:t1).
const SHELL = /^(?:\S*\/)?(?:sh|bash|zsh|dash|fish|ksh)(?:\s|$)/;
export const handedSession = (child: Proc, env: string, launched: string): boolean => !/(?:^|\s)SENPI_MONITOR_ID=/.test(env) && (SHELL.test(child.cmd) || child.cmd.includes("senpi-codemode/src/kernels/") || ENV_ID.exec(env)?.[1] !== launched);
export const launchSessionId = async (run: Runner, agent: Proc): Promise<string> => ENV_ID.exec(await procEnv(run, agent))?.[1] ?? "";

export const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  return at < 0 ? undefined : argv[at]?.startsWith(`${flag}=`) ? argv[at]?.slice(flag.length + 1) : argv[at + 1];
};

// The agent's own arguments with their word boundaries: a Windows command line split as Windows does (winArgv), Linux's
// /proc cmdline when it is the same process the table shows; undefined when they cannot be told (never a whitespace
// split), so on macOS, whose ps loses them, no log is looked for from them.
export const agentArgv = async (run: Runner, pid: number, cmd: string): Promise<string[] | undefined> => {
  if (process.platform === "win32") return winArgv(cmd);
  if (process.platform !== "linux") return undefined;
  const ran = await run(["cat", `/proc/${pid}/cmdline`]);
  if (ran.code !== 0) return undefined;
  const argv = ran.out.split("\0").filter((a, i, all) => a || i < all.length - 1);
  // one word with spaces is a process that rewrote its title, not its arguments
  return argv.length > 1 && argv.join(" ") === cmd.trim() ? argv : undefined;
};

// The log file of session id: --session <file> when the arguments name it, else that session's file in the agent's own
// --session-dir (omo writes the logs right in it), else in sessionsDir's folder for cwd. undefined when none is there.
const sessionLogFor = (argv: readonly string[], id: string, cwd: string, deps: SessionDeps): string | undefined => {
  const file = flagValue(argv, "--session");
  if (file?.endsWith(`_${id}.jsonl`)) return resolve(cwd, file);
  const own = flagValue(argv, "--session-dir");
  const dir = own ? resolve(cwd, own) : sessionDirFor(deps.sessionsDir, cwd);
  const name = (deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } }))(dir).find((n) => n.endsWith(`_${id}.jsonl`));
  return name ? join(dir, name) : undefined;
};

// The session the agent runs now. omo hands each child it starts the session it runs at that moment (PI_SESSION_ID and
// its log, PI_SESSION_FILE) and can move to another session inside the same process (/new, /resume), while its arguments
// keep naming the one it started with (zzangdori lead w1:p37, 2026-11-09); a child started before a move still shows the
// old session, and the child that showed the move can end. So of the sessions its arguments, its own children (a nested
// agent's children carry that agent's session) and the record kept for this same agent (deps.seen) name, the one whose log
// omo wrote last; when no log tells, the arguments' one, else the first child's. "" when none is named.
const currentSession = async (table: readonly Proc[], agent: Proc, fromFlag: string, cwd: string, deps: SessionDeps): Promise<Pick<SessionHit, "id" | "via">> => {
  const named: { readonly id: string; readonly log?: string | undefined; readonly current?: boolean }[] = [];
  const launched = await launchSessionId(deps.run, agent);
  for (const child of table.filter((p) => p.ppid === agent.pid).slice(0, 40)) {
    const env = await procEnv(deps.run, child);
    const id = ENV_ID.exec(env)?.[1];
    if (id && handedSession(child, env, launched)) named.push({ id, log: ENV_FILE.exec(env)?.[1], current: true });
  }
  if (fromFlag) named.push({ id: fromFlag });
  // the record counts on its own too: a selector-free agent whose children all ended still names it
  const seen = deps.seen ? await deps.seen(agent) : undefined;
  if (seen) named.push({ ...seen, current: true });
  const result = (id: string, sessions: readonly { readonly id: string; readonly log?: string | undefined }[] = named): Pick<SessionHit, "id" | "via"> => { deps.observed?.(id, sessions); return { id, via: named.some((n) => n.id === id && n.current) ? "child-env" : id ? "argv" : "none" }; };
  const ids = [...new Set(named.map((n) => n.id))];
  if (!ids.length || (ids.length === 1 && !deps.observed)) return result(ids[0] ?? "");
  const written = (log: string | undefined): number => {
    try {
      return log ? statSync(log).mtimeMs : -Infinity;
    } catch {
      return -Infinity;
    }
  };
  // the real word boundaries matter here: a --session-dir with spaces is no two flags, and where they cannot be told
  // (macOS, a rewritten title) no path option is read from a whitespace split: the default folder and exact logs only
  const words = (await agentArgv(deps.run, agent.pid, agent.cmd)) ?? [];
  const identities = ids.map((id) => ({ id, log: named.filter((n) => n.id === id).map((n) => n.log ?? sessionLogFor(words, id, cwd, deps)).reduce<string | undefined>((a, b) => written(b) > written(a) ? b : a, undefined) }));
  const last = identities.map((entry) => ({ id: entry.id, at: written(entry.log) })).reduce((a, b) => (b.at > a.at ? b : a));
  return result(last.at > -Infinity ? last.id : fromFlag || (ids[0] ?? ""), identities);
};

export const resolveSession = async (pane: string, cwd: string, table: readonly Proc[], deps: SessionDeps): Promise<SessionHit> => {
  const shellPid = await shellPidOf(pane, deps);
  const agent = topAgent(table, shellPid);
  if (!agent) return { id: "", via: "none" };
  const argv = process.platform === "win32" ? winArgv(agent.cmd) : agent.cmd.split(/\s+/);
  const fromFlag = argvSessionId(argv);
  const current = await currentSession(table, agent, fromFlag, cwd, deps);
  if (current.id) return { ...current, pid: agent.pid };
  // a selector omo resolves itself (a partial --session uuid, --continue, --resume, --fork, --rebind) can open an older
  // session, whose file name is no start time: only a child's exact PI_SESSION_ID may name it, never a nearby new session
  const selected = hasSessionSelector(argv);
  // its own children were read above and showed none; a deeper child's PI_SESSION_ID still names it
  for (const child of process.platform === "win32" ? [] : descendants(table, agent.pid).filter((p) => p.ppid !== agent.pid).slice(0, 40)) {
    const env = await procEnv(deps.run, child), hit = handedSession(child, env, await launchSessionId(deps.run, agent)) ? ENV_ID.exec(env) : null;
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  if (selected) return { id: "", via: "none", pid: agent.pid };
  const started = Date.parse(process.platform === "win32" ? agent.startedAt ?? "" : (await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list = deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const near = list(sessionDirFor(deps.sessionsDir, cwd)).flatMap((name) => {
    const m = SESSION_FILE.exec(name);
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
    return m?.[5] && at >= started - 5_000 && at <= started + START_WINDOW_MS ? [{ id: m[5], at }] : [];
  }).sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};
