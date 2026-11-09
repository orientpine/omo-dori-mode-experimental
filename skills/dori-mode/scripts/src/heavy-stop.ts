import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { dlopen, FFIType } from "bun:ffi";

import { killTree } from "./heavy-job.ts";
import { withLock } from "./heavy-slot-store.ts";
import type { SlotDeps } from "./heavy-slot-types.ts";
import { procId, WHO } from "./heavy-stale.ts";

// A helper's side of `dori heavy-worker "stop <label> <run>"` (heavy-stale.ts): a caller that found its run here stale ends
// what is left of it.

// SIGKILL to the process behind pid only while it is still the one recorded (procId): through a pidfd (Linux 5.3+) opened
// first and checked after, so a pid freed and reused between the check and the signal is never hit (as a plain kill by
// pid could). false when it is not that process, or no pidfd could be opened. Its children go with it: a run's box is
// bwrap --die-with-parent, and what else the worker started is killed by its tree after.
const sys = (() => {
  let lib: { symbols: { syscall: (...a: bigint[]) => bigint | number; close: (fd: number) => number } } | undefined;
  return () => (lib ??= dlopen("libc.so.6", { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 }, close: { args: [FFIType.i32], returns: FFIType.i32 } }) as never);
})();
const PIDFD_OPEN = 434n;
const PIDFD_SEND_SIGNAL = 424n;
const killIfStill = (pid: number, recorded: string): boolean => {
  const fd = Number(sys().symbols.syscall(PIDFD_OPEN, BigInt(pid), 0n, 0n, 0n));
  if (fd < 0) return false;
  try {
    if (procId(pid) !== recorded) return false;
    const children = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
    if (Number(sys().symbols.syscall(PIDFD_SEND_SIGNAL, BigInt(fd), 9n, 0n, 0n)) !== 0) return false;
    for (const c of children) killTree(c);
    return true;
  } finally {
    sys().symbols.close(fd);
  }
};

// a run's job folder deleted, read-only folders the job made in it included (made writable first when a plain delete fails)
const removeRun = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
};

// `stop <label> [run]` from caller: the runs of that label this caller started here (job folders under execRoot whose who
// file names both; with run, only that folder), their worker and what it started killed, their folders deleted, and the
// slots their worker held freed. Another caller's run is left alone, and so is a process that only reuses a dead worker's
// pid: a folder whose pid now belongs to another process is deleted, nothing is killed or freed for it. The number stopped.
export const stopRuns = async (execRoot: string, deps: SlotDeps, caller: string, label: string, run?: string): Promise<number> => {
  let n = 0;
  for (const d of ls(execRoot)) {
    if (run !== undefined && d !== run) continue;
    let who = "";
    try {
      who = readFileSync(join(execRoot, d, WHO), "utf8");
    } catch {
      continue;
    }
    const [whoCaller, whoLabel, ...started] = who.split(" ");
    if (whoCaller !== caller || whoLabel !== label) continue;
    const pid = Number(d.split("-")[0]);
    // a worker gone (killed with its ssh) leaves its slots to free; a live process that is not the recorded worker keeps
    // them and is left alone; the worker is killed before its folder goes, so a folder that cannot all be deleted keeps no run
    const now = procId(pid);
    if (now !== undefined && now !== started.join(" ")) {
      removeRun(join(execRoot, d));
      continue;
    }
    if (now !== undefined) killIfStill(pid, now);
    await freeSlots(deps, pid);
    removeRun(join(execRoot, d));
    n++;
  }
  return n;
};

const ls = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};

// how long a stop waits for admit.lock to free the dead worker's slots
const LOCK_WAIT_MS = 5_000;

// The slots whose owner is pid, freed under admit.lock as admissions take them (heavy-slot-store.ts withLock), each only
// while its owner is still the one read under that lock: an admission that found the worker dead may have taken a slot for
// a new job (review 8, 2026-11-09). When the lock stays busy LOCK_WAIT_MS they are left: a slot of a dead pid holds
// nothing, an admission's tryTake takes it over and holders() does not count it.
const freeSlots = async (deps: SlotDeps, pid: number): Promise<void> => {
  const free = async (): Promise<true> => {
    for (const s of ls(deps.dir).filter((x) => /^slot\.\d+$/.test(x))) {
      try {
        if (readFileSync(join(deps.dir, s, "owner"), "utf8").split(" ")[0] === String(pid)) rmSync(join(deps.dir, s), { recursive: true, force: true });
      } catch {}
    }
    return true;
  };
  const until = deps.clock.now() + LOCK_WAIT_MS;
  while ((await withLock(deps, free)) === null && deps.clock.now() < until) await deps.clock.sleep(50);
};
