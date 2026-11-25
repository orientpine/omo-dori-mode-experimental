import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DoriConfig, GuardThresholds } from "./config.ts";
import { sampleGuardLoadMemory } from "./host-load-memory.ts";
import { listPanes } from "./panes.ts";
import type { Runner } from "./run.ts";
import { type HcGuardDeps, type HcStuck, hcPass } from "./host-guard-hc.ts";

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

// unrounded in the sample so 19.9% stays under a 20% floor; shown rounded down so the line never claims the floor
export const memFreeText = (pct: number | null): string => (pct === null ? "memory free unknown" : `memory free ${Math.floor(pct)}%`);

export const sampleHost = async (run: Runner, config: Pick<DoriConfig, "backend" | "runtime">, dataPath = "/"): Promise<HostSample> => {
  const { load1, memFreePct } = await sampleGuardLoadMemory(run); // https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/264
  const diskFreeGb = (await sampleDiskFreeGb(run, dataPath)) ?? 0;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024;
  const panes = await listPanes(run, config).then((p) => p.length, () => -1);
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

// free GB of the filesystem holding path from df -k (null: df did not answer with a number)
const sampleDiskFreeGb = async (run: Runner, path = "/"): Promise<number | null> => {
  const df = await run(["df", "-k", path]);
  const kb = Number(df.out.split("\n").filter(Boolean).at(-1)?.trim().split(/\s+/)[3]);
  return df.code === 0 && Number.isFinite(kb) ? kb / 1_048_576 : null;
};

// Where the disk went, for the disk alert: the largest entries right under each root, with their account and size, so the
// lead knows whom to tell (2026-11-19: one lane's copies in /tmp and /var/tmp filled 0a83's root). du stays on the root's
// filesystem and stops after DU_SEC; a root it cannot list, or a folder it read only in part, is named as 못 읽음.
export const DISK_ROOTS = ["/tmp", "/var/tmp", "/home"];
const DU_SEC = 120;
const size = (kb: number): string => (kb >= 10 * 1_048_576 ? `${Math.round(kb / 1_048_576)}G` : kb >= 1_048_576 ? `${(kb / 1_048_576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`);
export const diskTops = async (run: Runner, roots: readonly string[] = DISK_ROOTS, n = 5): Promise<string> => {
  const found: { path: string; kb: number }[] = [];
  // kb: what du still counted there (Infinity: a root it could not list or stopped in), so the examples are the most telling
  const unread: { text: string; kb: number }[] = [];
  for (const root of roots) {
    let paths: string[];
    try {
      paths = readdirSync(root).map((name) => join(root, name));
    } catch (e) {
      unread.push({ text: `${root} (${e instanceof Error && "code" in e ? String(e.code) : String(e)})`, kb: Number.POSITIVE_INFINITY });
      continue;
    }
    if (!paths.length) continue;
    const du = await run(["timeout", String(DU_SEC), "du", "-xsk", "--", ...paths]);
    const errs = du.err.split("\n").filter(Boolean);
    for (const p of paths) {
      const kb = Number(new RegExp(`^(\\d+)\\t${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(du.out)?.[1]);
      const partial = errs.some((e) => ["/", "'", "\u2019"].some((end) => e.includes(`${p}${end}`)));
      if (Number.isFinite(kb)) found.push({ path: p, kb });
      if (partial || !Number.isFinite(kb)) unread.push({ text: `${p} (${Number.isFinite(kb) ? "일부만 셈" : "못 셈"})`, kb: Number.isFinite(kb) ? kb : 0 });
    }
    if (du.code === 124) unread.push({ text: `${root} (du stopped after ${DU_SEC} s)`, kb: Number.POSITIVE_INFINITY });
  }
  const top = found.sort((a, b) => b.kb - a.kb).slice(0, n);
  const st = top.length ? await run(["stat", "-c", "%U\t%n", "--", ...top.map((x) => x.path)]) : { out: "" };
  const owner = new Map(st.out.split("\n").flatMap((l) => (l.includes("\t") ? [[l.slice(l.indexOf("\t") + 1), l.slice(0, l.indexOf("\t"))] as const] : [])));
  const list = top.map((x) => `${x.path} (${owner.get(x.path) ?? "account 못 읽음"}) ${size(x.kb)}`).join(", ") || "nothing read";
  // one count and n examples: /tmp holds thousands of other accounts' small folders du reads only in part (0a83, 2026-11-19)
  const examples = unread.sort((a, b) => b.kb - a.kb).slice(0, n).map((u) => u.text).join(", ");
  return `largest under ${roots.join(" ")}: ${list}${unread.length ? `; 못 읽음 ${unread.length}곳: ${examples}${unread.length > n ? ", ..." : ""}` : ""}`;
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

// one line per process the first time it is seen; seen forgets a pid only when its process has ended, so one that dips
// under the threshold (or a failed ps) and comes back is not named again
export const outsideLines = (procs: readonly HeavyProc[], seen: Set<number>, alive = (pid: number): boolean => existsSync(`/proc/${pid}`)): string[] => {
  for (const pid of seen) if (!alive(pid)) seen.delete(pid);
  return procs.filter((p) => !seen.has(p.pid)).map((p) => {
    seen.add(p.pid);
    return `HOST_GUARD HEAVY_OUTSIDE ${p.user} pid ${p.pid}: ${p.minutes} min at ${p.cpuPct}% CPU outside dori heavy (${p.cmd.slice(0, 120)}); training, simulation and GPU tests go through dori heavy <label> --kind gpu --sync <paths> -- <command> (a training spark takes them), other heavy work through --kind cpu or browser`;
  });
};

// kinds: every reason kind (its first word: load, memory, disk, session, panes) seen since the alert began, so a reason
// that comes and goes during one alert is printed once; told: this alert's row is owed to the lead (in the
// inbox or in pending); pending: rows not written yet (the inbox write failed), in order, tried again each pass; unsaved:
// the last write of statePath failed, so it is written again next pass; hc: the hc cores seen stuck, by name (host-guard-hc.ts)
export type GuardState = { alerting: boolean; computeReady?: boolean; kinds?: readonly string[]; told?: boolean; pending?: readonly string[]; unsaved?: boolean; hc?: Record<string, HcStuck> };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  const kinds = state.alerting ? new Set(state.kinds) : new Set<string>();
  const fresh = reasons.some((r) => !kinds.has(r.split(" ")[0] ?? ""));
  if (alerting && fresh) out.push(`HOST_GUARD ALERT ${reasons.join(" | ")}`);
  if (!alerting && state.alerting) out.push(`HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, ${memFreeText(s.memFreePct)}, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
  for (const r of reasons) kinds.add(r.split(" ")[0] ?? "");
  state.alerting = alerting;
  state.kinds = [...kinds];
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};

// The kinds that wake the maintenance lead: what fills or starves the host for every Dori on it. Load and the pane count
// swing within minutes and only hold launches (can-launch), so they stay on the watch log.
const WAKE_KINDS = ["disk", "memory"];

export type GuardDeps = {
  readonly statePath: string;
  readonly now: () => number;
  // diskTops, asked only when disk is a new reason of the alert
  readonly tops: () => Promise<string>;
  // one row in the lead's inbox (makeDirectiveDeps leadInbox, the way backlog and the directive audit tell the lead)
  readonly inbox: (kind: string, id: string, content: string) => void;
  // the hc cores to check (unset: none, as on a herdr or aoe host)
  readonly hc?: HcGuardDeps;
};

export const guardStatePath = (stateDir: string): string => join(stateDir, "guard.json");

export const readGuardState = (path: string): GuardState => {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as GuardState;
    const pending = Array.isArray(s.pending) ? s.pending.filter((p): p is string => typeof p === "string") : [];
    return { alerting: s.alerting === true, kinds: Array.isArray(s.kinds) ? s.kinds : [], told: s.told === true, ...(pending.length ? { pending } : {}), ...(typeof s.hc === "object" && s.hc !== null && Object.keys(s.hc).length ? { hc: s.hc } : {}) };
  } catch {
    return { alerting: false };
  }
};

// One guard pass: guardTick's lines, the disk alert with where the disk went, and the lead's inbox told once per alert
// (its ALERT row when a disk or memory reason first shows, its CLEAR row when that alert is over), kept in statePath so a
// restarted guard does not tell it again. A failed write is a HOST_GUARD WAKE_FAIL line; the rows wait in order (an ALERT
// is never dropped for the CLEAR after it) and are tried again next pass, as is a state file that could not be written.
export const guardPass = async (s: HostSample, t: GuardThresholds, state: GuardState, deps: GuardDeps): Promise<string[]> => {
  // what another guard process told is in the file: read it, unless this process's own last write of it failed
  if (!state.unsaved) Object.assign(state, { pending: undefined, hc: undefined }, readGuardState(deps.statePath));
  const before = new Set(state.alerting ? state.kinds : []);
  const saved = (): string => JSON.stringify({ alerting: state.alerting, kinds: state.kinds, told: state.told, ...(state.pending?.length ? { pending: state.pending } : {}), ...(state.hc && Object.keys(state.hc).length ? { hc: state.hc } : {}) });
  const was = saved();
  const queue = [...(state.pending ?? [])];
  const out: string[] = [];
  for (const line of guardTick(s, t, state)) {
    if (line.startsWith("HOST_GUARD ALERT ")) {
      const fresh = (state.kinds ?? []).filter((k) => !before.has(k));
      const full = fresh.includes("disk") ? `${line} | ${await deps.tops()}` : line;
      out.push(full);
      if (!state.told && fresh.some((k) => WAKE_KINDS.includes(k))) {
        queue.push(full);
        state.told = true;
      }
    } else if (line.startsWith("HOST_GUARD CLEAR ")) {
      out.push(line);
      if (state.told) queue.push(line);
      state.told = false;
    } else out.push(line);
  }
  for (const { line, wake } of deps.hc ? await hcPass(deps.hc, state, alertReasons(s, t).find((r) => r.startsWith("disk "))) : []) {
    out.push(line);
    if (wake) queue.push(line);
  }
  // a pass may owe several rows (an hc restart and its CLEAR), so each after the first gets its own id
  for (let n = 0; queue.length; n++) {
    try {
      deps.inbox("host-guard", `host-guard-${new Date(deps.now()).toISOString()}${n ? `-${n}` : ""}`, queue[0] ?? "");
      queue.shift();
    } catch (e) {
      out.push(`HOST_GUARD WAKE_FAIL the lead's inbox row was not written (${e instanceof Error ? e.message : String(e)}); ${queue.length} row(s) tried again next pass`);
      break;
    }
  }
  state.pending = queue;
  if (saved() !== was || state.unsaved) {
    // written beside it and renamed over it, so a reader never sees half a file
    const tmp = `${deps.statePath}.tmp`;
    try {
      mkdirSync(dirname(deps.statePath), { recursive: true });
      writeFileSync(tmp, `${saved()}\n`);
      renameSync(tmp, deps.statePath);
      state.unsaved = false;
    } catch (e) {
      state.unsaved = true;
      out.push(`HOST_GUARD STATE_FAIL ${deps.statePath} (${e instanceof Error ? e.message : String(e)}); tried again next pass, and a guard restarted before then may tell the lead again`);
    }
  }
  return out;
};
