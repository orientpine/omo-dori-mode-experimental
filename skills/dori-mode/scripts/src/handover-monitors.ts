// End re-armed command monitors before freezing their old agent: a stopped watch still owns its locks and ports.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmuxPanePid } from "./aoe.ts";
import { agentTree } from "./frozen.ts";
import { type HandoverDeps, type HandoverFacts, manifestPath, readManifest, sameCommand } from "./handover.ts";
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
