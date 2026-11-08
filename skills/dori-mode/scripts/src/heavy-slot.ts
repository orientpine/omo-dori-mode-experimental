import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { headroomVerdict, type UsageSample } from "./heavy-headroom.ts";
import { memVerdict } from "./heavy-mem.ts";
import { heldBy, type Holder, holders, slotMemKb, slotSettleSec, tryTake, withLock } from "./heavy-slot-store.ts";

import type { Headroom, SlotDeps } from "./heavy-slot-types.ts";

export type * from "./heavy-slot-types.ts";
export { releaseSlot, pidAlive } from "./heavy-slot-store.ts";

export type Try = { readonly slot: string; readonly why: string } | { readonly wait: string; readonly why: string };

// Waiters stand in line: a ticket file per waiter in <dir>/queue named <enqueued ms, 15 digits>-<pid>-<label>, so names
// sort in arrival order. Only the first live ticket may take a slot; a ticket whose process died is dropped.
const QUEUE = "queue";
const ticketPid = (name: string): number => Number(name.split("-")[1]);

// a ticket's content says whether its job can run on another host ("any") or only waits for this one ("local")
const ticketKind = (deps: SlotDeps, name: string): string => {
  try {
    return readFileSync(join(deps.dir, QUEUE, name), "utf8");
  } catch {
    return "local";
  }
};

const enqueue = (deps: SlotDeps, label: string, since: number, kind: "any" | "local"): string => {
  const dir = join(deps.dir, QUEUE);
  mkdirSync(dir, { recursive: true });
  for (let at = since; ; at++) {
    const path = join(dir, `${String(at).padStart(15, "0")}-${deps.pid}-${label.replace(/[^\w.-]/g, "_")}`);
    try {
      writeFileSync(path, kind, { flag: "wx" });
      return path;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
};

// live tickets in line order (dead ones removed on the way)
const line = (deps: SlotDeps): string[] => {
  const dir = join(deps.dir, QUEUE);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (deps.alive(ticketPid(n))) return true;
    rmSync(join(dir, n), { force: true });
    return false;
  });
};

// One admission try now, for a helper that serves another host's queue: a job waiting in this host's own line goes first.
export const admitOnce = async (deps: SlotDeps, label: string, settleSec?: number): Promise<Try | null> => {
  mkdirSync(deps.dir, { recursive: true });
  const waiting = line(deps).length;
  if (waiting) return { wait: "queue", why: `${waiting} job(s) wait in this host's queue` };
  return withLock(deps, () => tryAdmit(deps, label, undefined, settleSec));
};

// memKb: the job's own estimate (dori heavy --mem). With it even the first slot waits until the memory it needs, beside
// what running jobs said they need and do not use yet, keeps headroom.free percent of the host free.
const tryAdmit = async (deps: SlotDeps, label: string, memKb?: number, settleSec?: number): Promise<Try> => {
  const load = await deps.load();
  if (load >= deps.maxLoad) return { wait: "load", why: `load ${load.toFixed(0)} >= ${deps.maxLoad}` };
  const h = deps.headroom;
  const max = Math.max(deps.slots, h?.maxSlots ?? 0);
  const running = holders(deps, max);
  let sample: UsageSample | undefined;
  const usage = async (u: Headroom): Promise<UsageSample> => (sample ??= await u.usage(running.map((r) => r.pid)));
  let memWhy = "";
  if (memKb && h) {
    const s = await usage(h);
    if (s.memTotalKb > 0) {
      const reservedKb = running.reduce((a, r, i) => a + Math.max(0, slotMemKb(deps, r.n) - ((s.jobs[i]?.mem ?? 0) * s.memTotalKb) / 100), 0);
      const v = memVerdict({ totalKb: s.memTotalKb, availKb: s.memTotalKb * (1 - s.host.mem / 100) }, memKb, reservedKb, h.free);
      if (!v.ok) return { wait: "memory", why: v.why };
      memWhy = `; ${v.why}`;
    }
  }
  if (running.length < deps.slots || !h) {
    for (let n = 1; n <= deps.slots; n++) {
      const slot = tryTake(deps, n, label, memKb, settleSec);
      if (slot) return { slot, why: `${running.length} heavy job(s) running, load ${load.toFixed(0)} < ${deps.maxLoad}${memWhy}` };
    }
    if (!h) return { wait: "full", why: `all ${deps.slots} slot(s) busy: ${heldBy(deps, holders(deps, max))}` };
  }
  if (running.length >= max) return { wait: "full", why: `all ${max} slots busy: ${heldBy(deps, running)}` };
  const settleOf = (r: Holder): number => slotSettleSec(deps, r.n) ?? h.settleSec;
  const fresh = running.find((r) => deps.clock.now() - r.since < settleOf(r) * 1000);
  if (fresh) return { wait: "settle", why: `slot.${fresh.n} was taken ${Math.round((deps.clock.now() - fresh.since) / 1000)}s ago; its load shows after ${settleOf(fresh)}s` };
  // a job with its own estimate had memory checked above; the guess from running jobs is for the other resources
  const v = headroomVerdict(await usage(h), h.free, memKb ? ["mem"] : []);
  if (!v.ok) return { wait: `headroom ${v.short.join(",")}`, why: `${running.length} running; ${v.detail}` };
  for (let n = 1; n <= max; n++) {
    const slot = tryTake(deps, n, label, memKb, settleSec);
    if (slot) return { slot, why: `${running.length} running beside it; ${v.detail}${memWhy}` };
  }
  return { wait: "full", why: `all ${max} slots busy: ${heldBy(deps, holders(deps, max))}` };
};

export type Acquired<T> = { readonly slot: string } | { readonly elsewhere: T };
export type AcquireOptions<T> = {
  readonly pollMs?: number;
  // when the job entered the line (a job sent back after its helper dropped keeps its place at the front)
  readonly since?: number;
  // the job at the front of the line, refused here for load, full slots or headroom (not while a new job settles), or a
  // job behind only jobs that wait for this host alone (plain dori heavy): a started run on another host, or null
  readonly elsewhere?: (wait: string) => Promise<T | null>;
  // true once no other host will take the job (every helper refused it): its ticket turns "local" in its place, so jobs
  // behind it may still go to a helper, and elsewhere is not asked again
  readonly nowhere?: () => boolean;
  // the job's own memory estimate in KB (dori heavy --mem)
  readonly memKb?: number;
  // ask elsewhere also while this host only waits for a just-taken job to show its load (dori heavy --kind: the other
  // PC should not sit idle for heavySettleSec); the GPU line (--job) keeps waiting here then
  readonly elsewhereWhileSettling?: boolean;
  // seconds this job needs before its load shows (kept in its slot for the next admission); default headroom.settleSec
  readonly settleSec?: number | undefined;
};

export const acquire = async <T>(deps: SlotDeps, label: string, opts: AcquireOptions<T> = {}): Promise<Acquired<T>> => {
  mkdirSync(deps.dir, { recursive: true });
  const ticket = enqueue(deps, label, opts.since ?? deps.clock.now(), opts.elsewhere ? "any" : "local");
  let local = !opts.elsewhere;
  try {
    let waiting = "";
    for (;;) {
      if (!local && opts.nowhere?.()) {
        writeFileSync(ticket, "local");
        local = true;
      }
      const names = line(deps);
      const ahead = names.slice(0, Math.max(0, names.indexOf(basename(ticket))));
      const t: Try | null = ahead.length ? { wait: "queue", why: `${ahead.length} job(s) ahead in the queue` } : await withLock(deps, () => tryAdmit(deps, label, opts.memKb, opts.settleSec));
      const localOnlyAhead = ahead.length > 0 && ahead.every((n) => ticketKind(deps, n) === "local");
      if (t && "slot" in t) {
        deps.log?.(`HEAVY_ADMIT ${label} ${basename(t.slot)}: ${t.why}`);
        return { slot: t.slot };
      }
      if (t && t.wait !== waiting) {
        deps.log?.(`HEAVY_WAIT ${label}: ${t.why}`);
        waiting = t.wait;
      }
      if (t && opts.elsewhere && !local && (localOnlyAhead || (t.wait !== "queue" && (t.wait !== "settle" || opts.elsewhereWhileSettling)))) {
        const got = await opts.elsewhere(t.why);
        if (got !== null) return { elsewhere: got };
      }
      await deps.clock.sleep(opts.pollMs ?? 15_000);
    }
  } finally {
    rmSync(ticket, { force: true });
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000, memKb?: number): Promise<string> => {
  const got = await acquire<never>(deps, label, { pollMs, ...(memKb ? { memKb } : {}) });
  return "slot" in got ? got.slot : got.elsewhere;
};
