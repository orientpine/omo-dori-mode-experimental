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
