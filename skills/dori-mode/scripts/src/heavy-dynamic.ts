import { type MemInfo, fmtMem, memVerdict } from "./heavy-mem.ts";
import { claimSlot, inspectSlots } from "./heavy-slot-store.ts";
import type { SlotDeps, SlotRequest, Try } from "./heavy-slot-types.ts";
import { ownerMemWhy } from "./heavy-owner-pc.ts";

// https://github.com/sisyphuslabs/dori-superagent/pull/264
export type DynamicHost = { readonly load1: number | null; readonly memory: MemInfo | null };
export type DynamicPolicy = {
  readonly minSlots: number;
  readonly maxSlots: number;
  readonly jobMemKb: number;
  readonly memFreeMinPct: number;
  readonly sample: () => Promise<DynamicHost>;
  readonly elapsedMs?: () => number;
};
type DynamicDeps = SlotDeps & { readonly dynamic: DynamicPolicy };

export type ExplicitMemPolicy = {
  readonly headroom?: { readonly free: number };
  readonly dynamic?: Pick<DynamicPolicy, "memFreeMinPct">;
};

// The permanent preflight and the live admission check must leave the same share for an explicit estimate.
export const explicitMemFloor = ({ dynamic, headroom }: ExplicitMemPolicy): number =>
  dynamic ? Math.max(dynamic.memFreeMinPct, headroom?.free ?? 0) : headroom?.free ?? 10;

const WARMUP_MS = 120_000;
const MAX_AGE_MS = 1_000;
const SAMPLE_TRIES = 3;

const decide = async (deps: DynamicDeps, snapshot: ReturnType<typeof inspectSlots>, request?: SlotRequest) => {
  const { dynamic: p } = deps;
  const { held, free } = snapshot;
  const now = deps.clock.now();
  const stamp = new Date(now).toISOString();
  const warming = held.filter((h) => h.since === undefined || now - h.since < WARMUP_MS);
  const reservedKb = warming.reduce((total, h) => total + (h.memKb || p.jobMemKb), 0);
  const elapsed = p.elapsedMs ?? (() => performance.now());
  let host: DynamicHost = { load1: null, memory: null };
  let stale = true;
  for (let i = 0; i < SAMPLE_TRIES; i++) {
    const start = elapsed();
    const sample = await p.sample();
    if (elapsed() - start <= MAX_AGE_MS) {
      host = sample;
      stale = false;
      break;
    }
  }
  const { memory, load1 } = host;
  const loadOk = load1 !== null && load1 < deps.maxLoad;
  const spareKb = memory ? memory.availKb - (memory.totalKb * p.memFreeMinPct) / 100 - reservedKb : -Infinity;
  const fits = Math.floor(spareKb / p.jobMemKb + 1e-9);
  const wanted = held.length + (loadOk ? fits : Math.min(0, fits));
  const limit = load1 === null || memory === null ? p.minSlots : Math.max(p.minSlots, Math.min(p.maxSlots, wanted));
  const bound = wanted >= p.maxSlots && memory && load1 !== null ? "ceiling" : wanted < p.minSlots || load1 === null ? "floor" : loadOk ? "memory" : "load";
  const why = `limit ${limit} of ${p.minSlots}-${p.maxSlots} (${bound}), running ${held.length}${warming.length ? ` (${warming.length} starting)` : ""}: ` +
    (memory ? `memory ${((100 * memory.availKb) / memory.totalKb).toFixed(1)}% free, ${fmtMem(p.jobMemKb * 1024)} per job above ${p.memFreeMinPct}% fits ${fits >= 0 ? `${fits} more` : `${-fits} fewer`}; ` : "memory unknown; ") +
    (load1 === null ? "load unknown" : `load ${load1.toFixed(1)} ${loadOk ? "<" : ">="} ${deps.maxLoad}`) +
    (stale ? `; host sample took over ${MAX_AGE_MS} ms ${SAMPLE_TRIES} times` : "");
  if (!free || held.length >= p.maxSlots) return { result: { wait: "full", why }, held };
  if (held.length >= limit) return { result: { wait: loadOk ? "memory" : "load", why }, held };
  if (request?.ownerMemPct !== undefined && held.length > 0)
    return { result: { wait: "full", why: `${why}; the owner's PC runs one batch item at a time` }, held };
  if (request?.ownerMemPct !== undefined && !request.memKb)
    return { result: { wait: "memory", why: `${why}; the owner's memory cap cannot be weighed here` }, held };
  if (request?.memKb) {
    if (!memory) return { result: { wait: "memory", why: `${why}; explicit memory estimate cannot be weighed here` }, held };
    const owner = request.ownerMemPct === undefined ? undefined : ownerMemWhy(memory.totalKb, memory.totalKb - memory.availKb, reservedKb, request.memKb, request.ownerMemPct);
    const explicit = memVerdict(memory, request.memKb, reservedKb, explicitMemFloor(deps));
    if (owner || !explicit.ok) return { result: { wait: "memory", why: `${why}; ${owner ?? explicit.why}` }, held };
  }
  return { result: { slot: free.path, why }, held, free, stamp };
};

// The caller holds the admission flock; inspect owners and reservations before sampling, then claim without re-probing.
export const admitDynamic = async (deps: DynamicDeps, request: SlotRequest): Promise<Try> => {
  const { result, free, stamp } = await decide(deps, inspectSlots(deps), request);
  if (free && stamp) claimSlot(deps, free, { ...request, stamp });
  return result;
};

export const dynamicStatus = async (deps: DynamicDeps): Promise<readonly string[]> => {
  const { result, held } = await decide(deps, inspectSlots(deps));
  return [`HEAVY ${"slot" in result ? "OPEN" : "FULL"} ${result.why}`, ...held.map((h) =>
    `HEAVY_SLOT slot.${h.n} ${h.pid === undefined ? "owner unknown" : `${h.label} pid ${h.pid} since ${h.since === undefined ? "unknown" : new Date(h.since).toISOString()}`}`)];
};
