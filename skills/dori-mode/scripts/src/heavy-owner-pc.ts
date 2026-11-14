import { readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";

// The owner's own PC as a batch helper (owner's card Q46, 2026-11-14, #soodori 1571035278930477126: "추천대로 (잠김·입력
// 없음 20분, ... 코어 절반)"; kimm-cha was then given whole, #soodori 1571035397390204969, so this is cha's). A helper entry
// with owner: {idleMin, cpuPct, memPct, kinds?} sends each dori heavy --items item there with idle=<idleMin> and
// cap=<cpuPct>:<memPct>; the helper takes it only while its owner is away and under those caps, and says WORKER_BUSY
// otherwise, so a new item waits and the ones running there go on (none is stopped). Away is read from
// ~/.dori/idle.json, {at, locked, lastInputAt} in UTC, which cha's dori-idle-state.timer rewrites every minute
// (zzangdori's lane cha-idle-state, #dori-pair 1571039266337984573): the screen locked, or no input for idleMin
// minutes, and at no older than IDLE_FRESH_MS. A file missing, unreadable, stale or of another shape: not away (fail
// closed). kinds: the --kind kinds of a batch it takes (cha's RTX 3090 for browser work only; GPU training goes to the
// training sparks).

export type OwnerPc = { readonly idleMin: number; readonly cpuPct: number; readonly memPct: number; readonly kinds?: readonly string[] };
export const IDLE_FRESH_MS = 3 * 60_000;
const IDLE = /^idle=(\d{1,4})$/;
const CAP = /^cap=(\d{1,3}):(\d{1,3})$/;

export const ownerOptOk = (o: string): boolean => IDLE.test(o) || (CAP.test(o) && o.slice(4).split(":").every((n) => Number(n) <= 100));
export const ownerWords = (o: OwnerPc): string[] => [`idle=${Math.round(o.idleMin)}`, `cap=${Math.round(o.cpuPct)}:${Math.round(o.memPct)}`];
export const ownerTakes = (o: OwnerPc | undefined, kind: string): boolean => !o?.kinds || o.kinds.includes(kind);

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
// a time that cannot be (2026-13-99...) is no time (review 1 of #480)
const timeOf = (v: unknown): number | undefined => {
  const t = typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

// why the owner is not away by the idle file, or undefined when he is
export const notAway = (idleMin: number, now: number, file = join(homedir(), ".dori", "idle.json"), read: (f: string) => unknown = readJson): string | undefined => {
  const raw = read(file);
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const at = timeOf(s?.["at"]);
  const last = timeOf(s?.["lastInputAt"]);
  // a file from the future (a clock set back) is no fresh file either
  if (!s || at === undefined || last === undefined || typeof s["locked"] !== "boolean" || at > now + 60_000) return `the owner's idle state (${file}) cannot be read, so this PC takes no batch item`;
  if (now - at > IDLE_FRESH_MS) return `the owner's idle state (${file}) is ${Math.round((now - at) / 1000)} s old, so this PC takes no batch item`;
  if (s["locked"] || now - last >= idleMin * 60_000) return undefined;
  return `the owner is on this PC (screen not locked, input ${Math.round((now - last) / 60_000)} min ago, under ${idleMin}), so it takes no new batch item; the ones running go on`;
};

export type Use = { readonly cpuPct: number; readonly memTotal: number; readonly memAvail: number };
const useNow = (): Use => {
  const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) || 0;
  const kb = (k: string, t: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(t)?.[1] ?? 0) * 1024;
  const m = readFileSync("/proc/meminfo", "utf8");
  return { cpuPct: (load / Math.max(1, cpus().length)) * 100, memTotal: kb("MemTotal", m), memAvail: kb("MemAvailable", m) };
};

// the helper's side: why an item asked with idle= and cap= waits, or undefined when it may start; needBytes: its mem=
export const ownerBusy = (opts: readonly string[], needBytes = 0, now = Date.now(), file?: string, use: () => Use = useNow): string | undefined => {
  const idle = IDLE.exec(opts.find((o) => IDLE.test(o)) ?? "");
  const away = idle ? notAway(Number(idle[1]), now, file) : undefined;
  if (away) return away;
  const cap = CAP.exec(opts.find((o) => CAP.test(o)) ?? "");
  if (!cap) return undefined;
  const u = use();
  const [cpuMax, memMax] = [Number(cap[1]), Number(cap[2])];
  if (u.cpuPct >= cpuMax) return `this PC is ${Math.round(u.cpuPct)}% busy (cpu), its batch cap is ${cpuMax}%`;
  const memPct = u.memTotal ? ((u.memTotal - u.memAvail + needBytes) / u.memTotal) * 100 : 100;
  return memPct > memMax ? `this PC's memory would be ${Math.round(memPct)}% used with it, its batch cap is ${memMax}%` : undefined;
};

// the owner's memory cap of cap=<cpu>:<mem>, and why an item may not start under it: what is used, what running items
// reserved and do not use yet, and its own estimate together (checked under the slot lock, heavy-slot.ts tryAdmit)
export const ownerMemCap = (opts: readonly string[]): number | undefined => {
  const cap = CAP.exec(opts.find((o) => CAP.test(o)) ?? "");
  return cap ? Number(cap[2]) : undefined;
};
export const ownerMemWhy = (totalKb: number, usedKb: number, reservedKb: number, needKb: number, capPct: number): string | undefined => {
  const pct = totalKb > 0 ? ((usedKb + reservedKb + needKb) / totalKb) * 100 : 100;
  return pct > capPct ? `memory with it and the running items' reservations would be ${Math.round(pct)}% used, over the owner's memory cap of ${capPct}%` : undefined;
};
// why an item can never start on the owner's PC, so it is refused there, never kept waiting (review 2 of #480): no memory
// estimate to hold to the memory cap, or one over the whole cap
export const ownerNever = (opts: readonly string[], needBytes: number | undefined, use: () => Use = useNow): string | undefined => {
  const capPct = ownerMemCap(opts);
  if (capPct === undefined) return undefined;
  if (!needBytes) return "an item on the owner's PC needs a memory estimate (dori heavy --mem-per-worker) to be held to its memory cap";
  const total = use().memTotal;
  return total > 0 && (needBytes / total) * 100 > capPct ? `its ${Math.round(needBytes / 1024 ** 3)}G estimate is over the owner's memory cap of ${capPct}% by itself` : undefined;
};
// the owner's CPU cap of cap=<cpu>:<mem>: the CPUQuota of the one item the owner's PC runs at a time (review 3 of #480)
export const ownerCpuCap = (opts: readonly string[]): number | undefined => {
  const cap = CAP.exec(opts.find((o) => CAP.test(o)) ?? "");
  return cap ? Number(cap[1]) : undefined;
};
