// End re-armed command monitors before freezing their old agent: a stopped watch still owns its locks and ports.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmuxPanePid } from "./aoe.ts";
import { agentTree } from "./frozen.ts";
import { type HandoverDeps, type HandoverFacts, manifestPath, type MonitorSpec, readManifest, sameCommand } from "./handover.ts";
import { descendants, ended } from "./session-id.ts";

// Why a path watch has nothing left to wait for, so a handover neither re-arms nor checks it: omo refuses a watch whose
// folder is gone ("Cannot watch file: parent directory does not exist"), and a create watch whose file is there has
// fired (omo ends it, "watcher completed") or never will. zzangdori's rv-human-natural lane rolled back twice on
// 2026-11-08 (17:04Z, 17:23Z) with "monitors not running" for one of each. A command watch is never judged here.
export const endedWatch = (m: { readonly path?: string; readonly event?: string }, exists: (path: string) => boolean = existsSync): string | undefined =>
  !m.path ? undefined
    : !exists(dirname(m.path)) ? `its folder ${dirname(m.path)} is gone, so omo cannot watch it`
    : (m.event ?? "create") === "create" && exists(m.path) ? `its file ${m.path} is there already`
    : undefined;

// The watch a monitor of the note was carried over as: its description, or that description with a note of the new
// session's own after it (port-hc-runtime's "dori review #404 round 9 (watch-only: old session's review pid 3636161
// already running)", 2026-11-08 22:51Z), never another name that only begins with the same words.
export const sameWatch = (wanted: string | undefined, armed: string | undefined): boolean => !!wanted && !!armed && (armed === wanted || armed.startsWith(`${wanted} (`));

// A monitor that starts work (LAUNCHES_WORK) has nothing left to wait for once its own process (the whole command: the
// work and the lines after it) and the work the note recorded under it (monitorWork) have ended: port-hc-runtime's 4eae
// ci (2026-11-08 22:35Z) and dori review (23:06Z) ended while their moves were checked, the new sessions' waits ended
// with them, and the moves were undone. This reads processes, never omo's notice text: a watch's own output can forge
// that text, and omo writes no run id or exit code to the session (three reviews of #414 found ways around reading it).
// A process counts as ended when its pid is gone or holds another process (another start time in /proc, Linux); with
// no start time recorded the pid alone decides. Work started detached (nohup, setsid, a lone &, systemd-run, tmux,
// screen, docker, sbatch) can outlive the monitor's process, so it is still asked for. Known gap: work the recorded
// processes hand to a process they do not wait for, or remote work that outlives its ssh client, is taken for ended.
export const procStart = (pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | undefined => {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[0] === "Z" ? undefined : rest[19];
  } catch {
    return undefined;
  }
};
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM";
  }
};
type Work = { readonly pid: number; readonly start?: string | null | undefined; readonly cmd: string; readonly pids?: readonly number[]; readonly starts?: readonly (string | null | undefined)[] };
// launch.detached: found in the command or a script it reads, not only in why, the first reason (#414 review 4); a record
// written before it had the field falls back to why.
const DETACHED = /^(?:a background job|nohup|setsid|systemd-run|disown|tmux|screen|docker|sbatch)/;
export const workEnded = (work: readonly Work[], alive: (pid: number) => boolean = pidAlive, start: (pid: number) => string | undefined = procStart) => (m: MonitorSpec): boolean => {
  if (!m.launch || (m.launch.detached ?? DETACHED.test(m.launch.why))) return false;
  // two monitors can share a description: match the work by the monitor's own pid when the note recorded it (#414 review 5)
  const w = work.find((j) => (m.pid !== undefined ? j.pid === m.pid : j.cmd === (m.description || m.command)));
  if (!w) return false;
  const over = (pid: number, at: string | null | undefined): boolean => (at != null ? start(pid) !== at : !alive(pid));
  return over(w.pid, w.start) && (w.pids ?? []).every((pid, i) => over(pid, w.starts?.[i]));
};

// The scripts a command's shells run by name, read from shell words, not a regex (#414 review 17: bash -o pipefail -c took
// pipefail for a script, and /bin/bash start.sh was no shell). Words split on blanks, quotes and backslashes resolved;
// ; & | ( ) and newlines start a new command; a redirection and its target are no word. Each command is read past
// assignments and wrappers (sudo, env, nohup, exec, time, nice, setsid, stdbuf, timeout with their options; node-dori-do
// and its host; ssh, its options and host, whose remote words are a command again) up to a shell named by any path:
// options with an operand (-o, +o, -O, +O, --rcfile, --init-file) are skipped, a -c string is a command again, -s reads
// its script from stdin, and the first other word is the script. A script found in ssh's remote words runs on another
// host (remote): a local file of that name says nothing about it (#414 review 18). Every o or O in a short option, also
// combined (-euo pipefail), takes the next word as its value. A shell with -s or no script reads its script from its
// last input redirection (< file), which is returned as its script, remote under ssh (dori challenge of review 18),
// marked stdin: such a shell runs whatever that file holds, so it starts work (#414 review 19). The input flows into a
// -c string and to ssh's remote shell (ssh forwards it, so that file is local); a shell whose input the handover cannot
// see (a pipe, a group's redirection) gets an empty path, which is never read, so it is work and keeps its watch
// (#414 review 20: fail closed instead of following every shell form).
const SHELL = /^(?:ba|z|da|k)?sh$/;
const WRAP = /^(?:sudo|env|nohup|exec|time|nice|setsid|stdbuf|timeout)$/;
// the options of each wrapper that take a value (sudo -n takes none, nice -n does)
const WRAP_ARG: Record<string, RegExp> = { sudo: /^-[ugCDhprtU]$/, env: /^-[uCS]$/, nice: /^-n$/, timeout: /^-[sk]$/, stdbuf: /^-[ioe]$/ };
const SSH_ARG = /^-[bcDEeFIiJLlmOoPpQRSWw]$/;
export type ShellScript = { readonly path: string; readonly remote: boolean; readonly stdin: boolean };
type Words = { readonly argv: string[]; readonly inputs: string[] };
const shellWords = (text: string): Words[] => {
  const cmds: Words[] = [{ argv: [], inputs: [] }];
  let input = false;
  let w: string | undefined;
  let target = false;
  const end = () => {
    if (w !== undefined && !target) cmds[cmds.length - 1]?.argv.push(w);
    if (w !== undefined && target && input) cmds[cmds.length - 1]?.inputs.push(w);
    if (w !== undefined) target = false;
    w = undefined;
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i] ?? "";
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      w = (w ?? "") + text.slice(i + 1, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < text.length && text[j] !== '"'; j++) s += text[j] === "\\" && j + 1 < text.length ? text[++j] : text[j];
      w = (w ?? "") + s;
      i = j + 1;
    } else if (c === "\\") {
      w = (w ?? "") + (text[i + 1] ?? "");
      i += 2;
    } else if (c === "<" || c === ">") {
      // only < and 0< feed stdin; 10< opens another descriptor
      const fd = w !== undefined && /^\d+$/.test(w) ? w : undefined;
      if (fd !== undefined) w = undefined;
      else end();
      input = c === "<" && (fd === undefined || fd === "0") && text[i + 1] !== "<" && text[i + 1] !== "(";
      while (text[i] === "<" || text[i] === ">") i++;
      if (text[i] === "&") i++;
      target = true;
    } else if (/[;&|()\n]/.test(c)) {
      end();
      target = false;
      cmds.push({ argv: [], inputs: [] });
      i++;
    } else if (/\s/.test(c)) {
      end();
      i++;
    } else {
      w = (w ?? "") + c;
      i++;
    }
  }
  end();
  return cmds;
};
export const shellScripts = (command: string, depth = 0, remote = false, inherited: readonly ShellScript[] = []): ShellScript[] =>
  depth > 4
    ? []
    : shellWords(command).flatMap(({ argv, inputs }) => {
        const input = inputs.length ? inputs.slice(-1).map((path) => ({ path, remote, stdin: true })) : [...inherited];
        let k = 0;
        for (;;) {
          // assignments, a group's {, ! and the control words a command can follow (#414 review 21)
          while (/^[A-Za-z_]\w*=/.test(argv[k] ?? "") || /^(?:\{|!|if|then|else|elif|while|until|do)$/.test(argv[k] ?? "")) k++;
          const base = (argv[k] ?? "").split("/").pop() ?? "";
          if (WRAP.test(base)) {
            for (k++; (argv[k] ?? "").startsWith("-"); ) k += WRAP_ARG[base]?.test(argv[k] ?? "") ? 2 : 1;
            if (base === "timeout" && /^\d/.test(argv[k] ?? "")) k++;
          } else if (base === "node-dori-do") k += 2;
          else if (base === "ssh") {
            for (k++; (argv[k] ?? "").startsWith("-"); ) k += SSH_ARG.test(argv[k] ?? "") ? 2 : 1;
            return shellScripts(argv.slice(k + 1).join(" "), depth + 1, true, input);
          } else if (SHELL.test(base)) {
            let string = false;
            let stdin = false;
            for (k++; k < argv.length; ) {
              const o = argv[k] ?? "";
              if (o === "--") { k++; break; }
              if (o === "--rcfile" || o === "--init-file") k += 2;
              else if (o.startsWith("--")) k++;
              else if (/^[-+][a-zA-Z]+$/.test(o)) {
                k++;
                for (const ch of o.slice(1)) {
                  if (ch === "o" || ch === "O") k++;
                  else if (o.startsWith("-") && ch === "c") string = true;
                  else if (o.startsWith("-") && ch === "s") stdin = true;
                }
              } else break;
            }
            if (string) return shellScripts(argv[k] ?? "", depth + 1, remote, input);
            const fed = input.length ? input : [{ path: "", remote, stdin: true }];
            if (stdin) return fed;
            return argv[k] ? [{ path: argv[k] ?? "", remote, stdin: false }] : fed;
          } else return [];
        }
      });

type Deps = Pick<HandoverDeps, "run" | "config" | "procs" | "signal" | "clock" | "home">;
type Facts = Pick<HandoverFacts, "from" | "monitors">;

export const endOldMonitors = async (deps: Deps, facts: Facts, spare: readonly number[] = []): Promise<string[]> => {
  try {
    const entries = facts.from.session ? readManifest(manifestPath(deps.config.sessionsDir, facts.from.cwd, facts.from.session)) : [];
    const table = await deps.procs();
    const shell = await tmuxPanePid(deps.run, facts.from.pane);
    const allowed = new Set(agentTree(table, shell, process.pid, spare).pids);
    const roots = [...new Set(entries.flatMap((e) => {
      const pid = e.runtime?.pid;
      return pid !== undefined && allowed.has(pid) && e.command
        && facts.monitors.some((m) => m.command && sameCommand(m.command, e.command ?? "", deps.home))
        && table.some((p) => p.pid === pid && !ended(p)) ? [pid] : [];
    }))];
    const chains = roots.map((pid) => ({ pid, pids: [pid, ...descendants(table, pid).filter((p) => allowed.has(p.pid) && !ended(p)).map((p) => p.pid)] }));
    for (const c of chains) deps.signal(-c.pid, "SIGTERM");
    // Allow shell traps to release resources; neither TERM nor KILL delivery alone proves a chain exited.
    if (chains.length) await deps.clock.sleep(250);
    let live = new Set((await deps.procs()).filter((p) => !ended(p)).map((p) => p.pid));
    const left = chains.filter((c) => c.pids.some((pid) => live.has(pid)));
    for (const c of left) deps.signal(-c.pid, "SIGKILL");
    if (left.length) {
      await deps.clock.sleep(250);
      live = new Set((await deps.procs()).filter((p) => !ended(p)).map((p) => p.pid));
    }
    // Job control can move a reader to another group; retain the captured pids even after their parent exits.
    const survivors = [...new Set(chains.flatMap((c) => c.pids))].filter((pid) => live.has(pid));
    for (const pid of survivors) deps.signal(pid, "SIGKILL");
    if (survivors.length) {
      await deps.clock.sleep(250);
      live = new Set((await deps.procs()).filter((p) => !ended(p)).map((p) => p.pid));
    }
    const failed = chains.filter((c) => c.pids.some((pid) => live.has(pid)));
    const done = chains.filter((c) => !failed.includes(c));
    return [
      `HANDOVER_OLD_MONITORS_ENDED ${done.length} (${done.map((c) => c.pid).join(",")})`,
      ...(failed.length ? [`HANDOVER_OLD_MONITORS_END_FAIL ${failed.map((c) => c.pid).join(",")}: still alive after SIGTERM and SIGKILL; freezing what remains`] : []),
    ];
  } catch (e: unknown) {
    return [`HANDOVER_OLD_MONITORS_END_FAIL ${facts.from.pane}: ${e instanceof Error ? e.message : String(e)}; freezing what remains`];
  }
};
