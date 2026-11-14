import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotDeps } from "./heavy-slot-types.ts";

const ORPHAN_MS = 60_000;

// the owner line is "<pid> <label> <claimed ISO time>"
const parseOwner = (owner: string): { pid: number; label: string; since: number | undefined } => {
  const words = owner.trim().split(" ");
  const since = Date.parse(words.at(-1) ?? "");
  return { pid: Number(words[0]), label: words[1] ?? "", since: Number.isNaN(since) ? undefined : since };
};

// what this process wrote into each slot it took, so it frees a slot only while that slot is still its own
const taken = new Map<string, string>();

// a job's own memory estimate (dori heavy --mem), in KB, kept in its slot so later admissions count what it will still load
const MEM_FILE = "mem";
export const slotMemKb = (deps: SlotDeps, n: number): number => {
  try {
    return Number(readFileSync(join(deps.dir, `slot.${n}`, MEM_FILE), "utf8")) || 0;
  } catch {
    return 0;
  }
};

// how many seconds a job needs before its load shows, when it said so (dori heavy --kind cpu|browser: a browser test's load
// shows within seconds); a slot without it waits headroom.settleSec (a GPU job loading a model)
const SETTLE_FILE = "settle";
export const slotSettleSec = (deps: SlotDeps, n: number): number | undefined => {
  try {
    const v = Number(readFileSync(join(deps.dir, `slot.${n}`, SETTLE_FILE), "utf8"));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
};

export const tryTake = (deps: SlotDeps, n: number, label: string, memKb?: number, settleSec?: number): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    const owner = `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`;
    if (memKb) writeFileSync(join(slot, MEM_FILE), String(Math.round(memKb)));
    if (settleSec) writeFileSync(join(slot, SETTLE_FILE), String(settleSec));
    writeFileSync(join(slot, "owner"), owner);
    taken.set(slot, owner);
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
  const { pid, since } = parseOwner(owner);
  const orphaned = owner ? !deps.alive(pid, since) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

// The process whose tree is a slot's job, when that is not the slot's owner (dori heavy --items here, heavy-batch.ts): the
// batch owns the slot until the item ran and was cleaned up (so it is never free while that item's output still drains),
// and admission measures the item's own process tree, not every item under the batch's one process.
const TREE_FILE = "tree";
export const setSlotTree = (slot: string, pid: number): void => writeFileSync(join(slot, TREE_FILE), String(pid));

// pid: the owner, whose life holds the slot; tree: the process whose tree is the job (its TREE_FILE, else the owner)
export type Holder = { readonly n: number; readonly pid: number; readonly tree: number; readonly label: string; readonly since: number };

export const holders = (deps: SlotDeps, max: number): Holder[] => {
  const out: Holder[] = [];
  for (let n = 1; n <= max; n++) {
    let owner: string;
    try {
      owner = readFileSync(join(deps.dir, `slot.${n}`, "owner"), "utf8").trim();
    } catch {
      continue;
    }
    const { pid, label, since } = parseOwner(owner);
    if (!deps.alive(pid, since)) continue;
    let tree = pid;
    try {
      tree = Number(readFileSync(join(deps.dir, `slot.${n}`, TREE_FILE), "utf8")) || pid;
    } catch {
      tree = pid;
    }
    out.push({ n, pid, tree, label, since: since ?? 0 });
  }
  return out;
};

const age = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m` : `${min}m`;
};

// which jobs hold the slots and for how long, so a waiter can see a job that should have ended
export const heldBy = (deps: SlotDeps, running: readonly Holder[]): string =>
  running.map((r) => `slot.${r.n} ${r.label} pid ${r.pid} ${r.since ? age(deps.clock.now() - r.since) : "?"}`).join(", ");

// one admission decision at a time across processes, so two waiters never both take the same headroom
export const withLock = async <T>(deps: SlotDeps, f: () => Promise<T>): Promise<T | null> => {
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

// frees the slot only while it is still the one this process took: a slot taken over by the next job (its holder looked
// dead) stays with that job
export const releaseSlot = (slot: string): void => {
  const mine = taken.get(slot);
  taken.delete(slot);
  if (mine !== undefined) {
    let now = "";
    try {
      now = readFileSync(join(slot, "owner"), "utf8");
    } catch {
      return;
    }
    if (now !== mine) return;
  }
  rmSync(slot, { recursive: true, force: true });
};

// alive and not a zombie; with `since`, also started by then (ps etimes is whole seconds, so 2 s of slack)
export const pidAlive = (pid: number, since?: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const [stat = "", etimes = ""] = Bun.spawnSync(["ps", "-o", "stat=,etimes=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);
  if (stat === "" || stat.startsWith("Z")) return false;
  return since === undefined || !/^\d+$/.test(etimes) || Date.now() - Number(etimes) * 1000 <= since + 2_000;
};
