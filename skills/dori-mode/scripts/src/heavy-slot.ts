import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { headroomVerdict, type UsageSample } from "./heavy-headroom.ts";
import type { Clock } from "./run.ts";

// More jobs beside the first `slots`: up to maxSlots at once, each only when every resource keeps `free` percent free with
// it added, and not while a job taken less than settleSec ago has not shown its load yet.
export type Headroom = {
  readonly maxSlots: number;
  readonly free: number;
  readonly settleSec: number;
  readonly usage: (jobPids: readonly number[]) => Promise<UsageSample>;
};

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
  readonly headroom?: Headroom;
  // one line per job when it is taken (HEAVY_ADMIT) and when it starts or changes why it waits (HEAVY_WAIT)
  readonly log?: (line: string) => void;
};

const ORPHAN_MS = 60_000;

const tryTake = (deps: SlotDeps, n: number, label: string): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`);
    return slot;
  };
  const got = claim();
  if (got) return got;
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    owner = "";
  }
  const pid = Number(owner.split(" ")[0]);
  const orphaned = owner ? !deps.alive(pid) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

type Holder = { readonly n: number; readonly pid: number; readonly since: number };

const holders = (deps: SlotDeps, max: number): Holder[] => {
  const out: Holder[] = [];
  for (let n = 1; n <= max; n++) {
    let owner: string;
    try {
      owner = readFileSync(join(deps.dir, `slot.${n}`, "owner"), "utf8").trim();
    } catch {
      continue;
    }
    const pid = Number(owner.split(" ")[0]);
    if (deps.alive(pid)) out.push({ n, pid, since: Date.parse(owner.split(" ").at(-1) ?? "") || 0 });
  }
  return out;
};

// one admission decision at a time across processes, so two waiters never both take the same headroom
const withLock = async <T>(deps: SlotDeps, f: () => Promise<T>): Promise<T | null> => {
  const lock = join(deps.dir, "admit.lock");
  const take = (): boolean => {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), String(deps.pid));
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    let pid = NaN;
    try {
      pid = Number(readFileSync(join(lock, "owner"), "utf8"));
    } catch {
      pid = NaN;
    }
    const stale = Number.isInteger(pid) ? !deps.alive(pid) : deps.clock.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > ORPHAN_MS;
    if (!stale) return null;
    rmSync(lock, { recursive: true, force: true });
    if (!take()) return null;
  }
  try {
    return await f();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

type Try = { readonly slot: string; readonly why: string } | { readonly wait: string; readonly why: string };

const tryAdmit = async (deps: SlotDeps, label: string): Promise<Try> => {
  const load = await deps.load();
  if (load >= deps.maxLoad) return { wait: "load", why: `load ${load.toFixed(0)} >= ${deps.maxLoad}` };
  const h = deps.headroom;
  const max = Math.max(deps.slots, h?.maxSlots ?? 0);
  const running = holders(deps, max);
  if (running.length < deps.slots || !h) {
    for (let n = 1; n <= deps.slots; n++) {
      const slot = tryTake(deps, n, label);
      if (slot) return { slot, why: `${running.length} heavy job(s) running, load ${load.toFixed(0)} < ${deps.maxLoad}` };
    }
    if (!h) return { wait: "full", why: `all ${deps.slots} slot(s) busy` };
  }
  if (running.length >= max) return { wait: "full", why: `all ${max} slots busy` };
  const fresh = running.find((r) => deps.clock.now() - r.since < h.settleSec * 1000);
  if (fresh) return { wait: "settle", why: `slot.${fresh.n} was taken ${Math.round((deps.clock.now() - fresh.since) / 1000)}s ago; its load shows after ${h.settleSec}s` };
  const v = headroomVerdict(await h.usage(running.map((r) => r.pid)), h.free);
  if (!v.ok) return { wait: `headroom ${v.short.join(",")}`, why: `${running.length} running; ${v.detail}` };
  for (let n = 1; n <= max; n++) {
    const slot = tryTake(deps, n, label);
    if (slot) return { slot, why: `${running.length} running beside it; ${v.detail}` };
  }
  return { wait: "full", why: `all ${max} slots busy` };
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  mkdirSync(deps.dir, { recursive: true });
  let waiting = "";
  for (;;) {
    const t = await withLock(deps, () => tryAdmit(deps, label));
    if (t && "slot" in t) {
      deps.log?.(`HEAVY_ADMIT ${label} ${basename(t.slot)}: ${t.why}`);
      return t.slot;
    }
    if (t && t.wait !== waiting) {
      deps.log?.(`HEAVY_WAIT ${label}: ${t.why}`);
      waiting = t.wait;
    }
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
};
