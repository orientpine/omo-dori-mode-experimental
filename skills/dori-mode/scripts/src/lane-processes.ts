import type { Runner } from "./run.ts";
import type { Runtimes } from "./runtime/registry.ts";
import type { TerminalKind, SessionRef } from "./runtime/types.ts";
import { descendants, ended, type Proc, procEnv, readProcTable } from "./session-id.ts";

// upstream sisyphuslabs/dori-superagent#225: collect while the pane still owns the process tree.
// each process with its start time: a pid and a command line alone do not prove it is the same process after the close
type Seen = Proc & { readonly start: string };
type Snapshot = readonly Seen[] | string;

// `ps -o lstart` (Linux procps and macOS): when each listed process started; a gone pid is simply not listed
const startTimes = async (run: Runner, pids: readonly number[]): Promise<Map<number, string> | string> => {
  if (!pids.length) return new Map();
  const r = await run(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")]);
  if (r.code !== 0 && r.err.trim()) return r.err.trim();
  return new Map(r.out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    return m ? [[Number(m[1]), m[2] ?? ""] as const] : [];
  }));
};
const SESSION_VAR: Readonly<Record<TerminalKind, string>> = { herdr: "HERDR_PANE_ID", hc: "HC_TERMINAL_ID" };

export const laneProcesses = async (rts: Runtimes, run: Runner, ref: SessionRef): Promise<Snapshot> => {
  // https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/282: the shared engine’s processes belong to no individual lane.
  if (ref.runtime === "omo-host") return [];
  if (process.platform === "win32") return "local session ownership cannot be checked on Windows";
  const pid = await rts.for(ref).probe(ref).then((p) => p.rootPid, () => undefined);
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return "the session reported no root process";

  const { rows, error } = await readProcTable(run);
  if (error) return error;
  const root = rows.find((p) => p.pid === pid && !ended(p));
  if (!root) return `session root ${pid} could not be read on this host`;

  // A runtime may report a remote PID. Check its own marker in the environment, never the command line.
  const linux = process.platform === "linux";
  const env = linux
    ? await run(["cat", `/proc/${pid}/environ`], { preserveOutput: true }).then((r) => (r.code === 0 ? r.out : ""))
    : await procEnv(run, root);
  if (!env.trim()) return `session root ${pid} could not be read on this host`;
  const marker = `${SESSION_VAR[ref.runtime]}=${ref.id}`;
  if (!env.split(linux ? "\0" : /\s+/).includes(marker)) {
    return `session root ${pid} on this host does not carry ${marker} (the session may run on another host)`;
  }
  const tree = [root, ...descendants(rows, pid)].filter((p) => p.pid > 1 && p.pid !== process.pid && p.cmd && !ended(p));
  const began = await startTimes(run, tree.map((p) => p.pid));
  if (typeof began === "string") return began;
  return tree.flatMap((p) => (began.has(p.pid) ? [{ ...p, start: began.get(p.pid) ?? "" }] : []));
};

// upstream sisyphuslabs/dori-superagent#225: the surviving exact PIDs may have been reparented after the close.
export const stopLeftovers = async (run: Runner, before: Snapshot): Promise<string> => {
  if (typeof before === "string") return `lane processes not checked: ${before}`;
  const { rows, error } = await readProcTable(run);
  if (error) return `lane processes not checked: ${error}`;
  const live = new Map(rows.filter((p) => !ended(p)).map((p) => [p.pid, p.cmd]));
  const same = before.filter((p) => live.get(p.pid) === p.cmd);
  const began = await startTimes(run, same.map((p) => p.pid));
  if (typeof began === "string") return `lane processes not checked: ${began}`;
  // a pid a new process with the same command took during the close has another start time (review 1 of #522)
  const survivors = same.filter((p) => began.get(p.pid) === p.start).map((p) => String(p.pid));
  if (!survivors.length) return "no lane process outlived the pane";
  const r = await run(["kill", "-TERM", ...survivors]);
  const what = `${survivors.length} lane processes outlived the pane`;
  return r.code === 0
    ? `${what}, stopped: ${survivors.join(" ")}`
    : `${what}, stop incomplete (${(r.err || `kill exited ${r.code}`).slice(0, 120)}): ${survivors.join(" ")}`;
};
