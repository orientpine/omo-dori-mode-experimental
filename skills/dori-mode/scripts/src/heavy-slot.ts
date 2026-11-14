import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { headroomVerdict, type UsageSample } from "./heavy-headroom.ts";
import { memVerdict } from "./heavy-mem.ts";
import { ownerMemWhy } from "./heavy-owner-pc.ts";
import { heldBy, type Holder, holders, releaseSlot, slotMemKb, slotSettleSec, tryTake, withLock } from "./heavy-slot-store.ts";

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
// memKb: the job's own estimate (exec mem=), kept free beside the running jobs as for a job of this host (tryAdmit)
// ownerMemPct: the owner's memory cap of an owner PC (heavy-owner-pc.ts), with every reservation counted
export const admitOnce = async (deps: SlotDeps, label: string, settleSec?: number, memKb?: number, ownerMemPct?: number): Promise<Try | null> => {
  mkdirSync(deps.dir, { recursive: true });
  const held = deps.hold?.();
  if (held) return { wait: "hold", why: `this host's heavy slots are held ${held}` };
  const waiting = line(deps).length;
  if (waiting) return { wait: "queue", why: `${waiting} job(s) wait in this host's queue` };
  const t = await admitUnheld(deps, () => tryAdmit(deps, label, memKb, settleSec, ownerMemPct));
  return t && "wait" in t && t.wait === "hold" ? { wait: "hold", why: `this host's heavy slots are held ${t.why}` } : t;
};

// An admission whose slot is given back when a hold (dori heavy hold-local) is on once it is taken. A hold set while the
// admission sampled load and headroom is read after the claim, and a hold set after the claim finds the job already
// running: no job takes a slot that a hold written before its claim forbids.
const admitUnheld = async (deps: SlotDeps, admit: () => Promise<Try>, holdExempt = false): Promise<Try | null> => {
  const t = await withLock(deps, admit);
  if (!t || !("slot" in t) || holdExempt) return t;
  const held = deps.hold?.();
  if (!held) return t;
  releaseSlot(t.slot);
  return { wait: "hold", why: held };
};

// memKb: the job's own estimate (dori heavy --mem). With it even the first slot waits until the memory it needs, beside
// what running jobs said they need and do not use yet, keeps headroom.free percent of the host free.
const tryAdmit = async (deps: SlotDeps, label: string, memKb?: number, settleSec?: number, ownerMemPct?: number): Promise<Try> => {
  const load = await deps.load();
  if (load >= deps.maxLoad) return { wait: "load", why: `load ${load.toFixed(0)} >= ${deps.maxLoad}` };
  const h = deps.headroom;
  const max = Math.max(deps.slots, h?.maxSlots ?? 0);
  const running = holders(deps, max);
  let sample: UsageSample | undefined;
  const usage = async (u: Headroom): Promise<UsageSample> => (sample ??= await u.usage(running.map((r) => r.tree)));
  let memWhy = "";
  if (ownerMemPct !== undefined && !(memKb && h)) return { wait: "memory", why: "the owner's memory cap cannot be weighed here (no estimate or no headroom sample)" };
  if (memKb && h) {
    const s = await usage(h);
    // the owner's cap with a sample that read no memory: wait, never admit unweighed (review 2 of #480)
    if (ownerMemPct !== undefined && !(s.memTotalKb > 0)) return { wait: "memory", why: "the owner's memory cap cannot be weighed here (the memory sample read nothing)" };
    if (s.memTotalKb > 0) {
      const reservedKb = running.reduce((a, r, i) => a + Math.max(0, slotMemKb(deps, r.n) - ((s.jobs[i]?.mem ?? 0) * s.memTotalKb) / 100), 0);
      const owner = ownerMemPct === undefined ? undefined : ownerMemWhy(s.memTotalKb, (s.memTotalKb * s.host.mem) / 100, reservedKb, memKb, ownerMemPct);
      if (owner) return { wait: "memory", why: owner };
      const v = memVerdict({ totalKb: s.memTotalKb, availKb: s.memTotalKb * (1 - s.host.mem / 100) }, memKb, reservedKb, h.free);
      if (!v.ok) return { wait: "memory", why: v.why };
      memWhy = `; ${v.why}`;
    }
  }
  // the owner's PC runs one batch item at a time, so the CPU quota it gets is the owner's whole CPU cap (review 3 of #480)
  if (ownerMemPct !== undefined && running.length > 0) return { wait: "full", why: `the owner's PC runs one batch item at a time, so its CPU cap holds: ${heldBy(deps, running)}` };
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
  // true while no other host will take the job (every helper refused it): its ticket is "local" in its place, so jobs
  // behind it may still go to a helper, and elsewhere is not asked until it turns false again (a refusal that expired)
  readonly nowhere?: () => boolean;
  // the job's own memory estimate in KB (dori heavy --mem)
  readonly memKb?: number;
  // ask elsewhere also while this host only waits for a just-taken job to show its load (dori heavy --kind: the other
  // PC should not sit idle for heavySettleSec); the GPU line (--job) keeps waiting here then
  readonly elsewhereWhileSettling?: boolean;
  // seconds this job needs before its load shows (kept in its slot for the next admission); default headroom.settleSec
  readonly settleSec?: number | undefined;
  // dori heavy --helpers-only: never this host's slot, only elsewhere, so no ticket in this host's line either
  readonly helpersOnly?: boolean;
  // the owner's transcription (heavy-queue.ts): a hold does not stop it, nor do jobs ahead in this host's line while a
  // hold is on (none of them may take a slot here then); without a hold it waits its turn
  readonly holdExempt?: boolean;
};

// the line of a job that may not take this host's slot now, and what it does instead
const heldLine = (label: string, why: string, local: boolean, helpersOnly: boolean): string =>
  helpersOnly ? `HEAVY_HELPERS_ONLY ${label}: waits for a helper; it never runs on this host`
  : `HEAVY_HOLD_LOCAL ${label}: this host's heavy slots are held ${why}; ${local ? "it cannot run on a helper, so it waits here until the hold ends" : "it goes to the first helper that admits it"}`;

export const acquire = async <T>(deps: SlotDeps, label: string, opts: AcquireOptions<T> = {}): Promise<Acquired<T>> => {
  mkdirSync(deps.dir, { recursive: true });
  const ticket = opts.helpersOnly ? undefined : enqueue(deps, label, opts.since ?? deps.clock.now(), opts.elsewhere ? "any" : "local");
  let local = !opts.elsewhere;
  try {
    let waiting = "";
    for (;;) {
      const onlyHere = !opts.elsewhere || Boolean(opts.nowhere?.());
      if (onlyHere !== local && ticket) writeFileSync(ticket, onlyHere ? "local" : "any");
      local = onlyHere;
      const names = line(deps);
      // a hold on this host (dori heavy hold-local, heavy-hold.ts) is read before every try, so a job that waited here
      // when it came on does not take a slot that frees during it
      const holdNow = opts.helpersOnly ? undefined : deps.hold?.();
      const ahead = ticket && !(opts.holdExempt && holdNow) ? names.slice(0, Math.max(0, names.indexOf(basename(ticket)))) : [];
      const before = opts.helpersOnly ? "--helpers-only" : opts.holdExempt ? undefined : holdNow;
      const tried: Try | null = before ? { wait: "hold", why: before } : ahead.length ? { wait: "queue", why: `${ahead.length} job(s) ahead in the queue` } : await admitUnheld(deps, () => tryAdmit(deps, label, opts.memKb, opts.settleSec), Boolean(opts.holdExempt));
      const held = tried && "wait" in tried && tried.wait === "hold" ? tried.why : undefined;
      const t: Try | null = held ? { wait: `hold ${local}`, why: held } : tried;
      const localOnlyAhead = ahead.length > 0 && ahead.every((n) => ticketKind(deps, n) === "local");
      if (t && "slot" in t) {
        deps.log?.(`HEAVY_ADMIT ${label} ${basename(t.slot)}: ${t.why}`);
        return { slot: t.slot };
      }
      if (t && t.wait !== waiting) {
        deps.log?.(held ? heldLine(label, held, local, Boolean(opts.helpersOnly)) : `HEAVY_WAIT ${label}: ${t.why}`);
        waiting = t.wait;
      }
      if (t && opts.elsewhere && !local && (localOnlyAhead || (t.wait !== "queue" && (t.wait !== "settle" || opts.elsewhereWhileSettling)))) {
        const got = await opts.elsewhere(t.why);
        if (got !== null) return { elsewhere: got };
      }
      await deps.clock.sleep(opts.pollMs ?? 15_000);
    }
  } finally {
    if (ticket) rmSync(ticket, { force: true });
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000, memKb?: number): Promise<string> => {
  const got = await acquire<never>(deps, label, { pollMs, ...(memKb ? { memKb } : {}) });
  return "slot" in got ? got.slot : got.elsewhere;
};
