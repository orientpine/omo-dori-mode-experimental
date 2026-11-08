import type { DoriConfig, GuardThresholds } from "./config.ts";
import { parseMeminfo } from "./heavy-mem.ts";
import { listPanes } from "./panes.ts";
import type { Runner } from "./run.ts";

export type HostSample = {
  readonly load1: number;
  // null: neither memory_pressure nor /proc/meminfo could be read, so memory is unknown and holds nothing
  readonly memFreePct: number | null;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

// macOS: memory_pressure -Q; Linux: MemAvailable over MemTotal in /proc/meminfo, where memory_pressure is missing and
// memory used to read as 100% free (https://github.com/sisyphuslabs/dori-superagent/issues/90)
const sampleMemFreePct = async (run: Runner): Promise<number | null> => {
  const mp = await run(["memory_pressure", "-Q"]);
  const mac = mp.code === 0 ? Number(/free percentage: (\d+)%/.exec(mp.out)?.[1]) : NaN;
  if (Number.isFinite(mac)) return mac;
  const mi = await run(["cat", "/proc/meminfo"]);
  const m = mi.code === 0 ? parseMeminfo(mi.out) : undefined;
  return m ? (100 * m.availKb) / m.totalKb : null;
};

// unrounded in the sample so 19.9% stays under a 20% floor; shown rounded down so the line never claims the floor
export const memFreeText = (pct: number | null): string => (pct === null ? "memory free unknown" : `memory free ${Math.floor(pct)}%`);

export const sampleHost = async (run: Runner, config: Pick<DoriConfig, "backend" | "runtime">, dataPath = "/"): Promise<HostSample> => {
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num((load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : loadLinux?.out ?? "").split(/\s+/)[0], 0);
  const memFreePct = await sampleMemFreePct(run);
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024;
  const panes = await listPanes(run, config).then((p) => p.length, () => -1);
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct !== null && s.memFreePct < t.memFreeMinPct) r.push(`${memFreeText(s.memFreePct)} < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes < 0) r.push("session count unknown");
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

// A heavy program left on this host outside dori heavy (in no dori-heavy-* scope) takes the PC the lanes time their runs
// on while a helper idles: owner 2026-11-08 "우리 학습용 spark 있는데 자율 굴착 시험왜 여기서 돌리고 있어?" (a gongdori replay test and
// pytest on 0a83). The guard names it once, with its account, so that Dori moves it; it never stops it.
export const OUTSIDE_MIN = 30;
export const OUTSIDE_CPU_PCT = 100;
export type HeavyProc = { readonly pid: number; readonly user: string; readonly minutes: number; readonly cpuPct: number; readonly cmd: string };

// processes of login accounts at OUTSIDE_CPU_PCT or more of one core on average over OUTSIDE_MIN minutes or more, outside
// every dori heavy scope (its children are in the scope's cgroup too)
export const sampleOutside = async (run: Runner): Promise<HeavyProc[]> => {
  const ps = await run(["ps", "-eo", "pid=,uid=,user:32=,etimes=,pcpu=,args="]);
  if (ps.code !== 0) return [];
  const out: HeavyProc[] = [];
  for (const line of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, uid, secs, cpu] = [Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5])];
    if (uid < 1000 || secs < OUTSIDE_MIN * 60 || cpu < OUTSIDE_CPU_PCT) continue;
    const cg = await run(["cat", `/proc/${pid}/cgroup`]);
    if (cg.code !== 0 || /dori-heavy-/.test(cg.out)) continue;
    out.push({ pid, user: m[3]!, minutes: Math.floor(secs / 60), cpuPct: Math.round(cpu), cmd: m[6]!.trim() });
  }
  return out;
};

// one line per process the first time it is seen; seen keeps only the pids still found
export const outsideLines = (procs: readonly HeavyProc[], seen: Set<number>): string[] => {
  const now = new Set(procs.map((p) => p.pid));
  for (const pid of seen) if (!now.has(pid)) seen.delete(pid);
  return procs.filter((p) => !seen.has(p.pid)).map((p) => {
    seen.add(p.pid);
    return `HOST_GUARD HEAVY_OUTSIDE ${p.user} pid ${p.pid}: ${p.minutes} min at ${p.cpuPct}% CPU outside dori heavy (${p.cmd.slice(0, 120)}); training, simulation and GPU tests go through dori heavy <label> --kind gpu --sync <paths> -- <command> (a training spark takes them), other heavy work through --kind cpu or browser`;
  });
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(alerting
      ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, ${memFreeText(s.memFreePct)}, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};
