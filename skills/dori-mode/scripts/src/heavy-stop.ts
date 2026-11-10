import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { dlopen, FFIType } from "bun:ffi";

import { killTree } from "./heavy-job.ts";
import { withLock } from "./heavy-slot-store.ts";
import type { SlotDeps } from "./heavy-slot-types.ts";

// The helper's side of a run's life (heavy-stale.ts is the caller's): who started it, its heartbeat, its caller gone,
// and `stop <label> [run]`.

// the file in a helper run's job folder naming its caller and label, as `stop <label>` matches them
const WHO = "who";
// the mark stop leaves in a run's job folder, so the worker says WORKER_CANCELLED as it goes
const CANCELLED = "cancelled";

// A process as it was started: this boot's id and its start time in clock ticks (/proc/<pid>/stat field 22), so a pid
// reused after the worker died, or after a reboot, is not taken for it. undefined when it is gone.
export const procId = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()} ${start}`;
  } catch {
    return undefined;
  }
};

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
const SIGTERM = 15n;
const killIfStill = (pid: number, recorded: string, signal = 9n): boolean => {
  const fd = Number(sys().symbols.syscall(PIDFD_OPEN, BigInt(pid), 0n, 0n, 0n));
  if (fd < 0) return false;
  try {
    if (procId(pid) !== recorded) return false;
    // SIGKILL takes the worker's children too; after a SIGTERM the worker ends them itself
    const children = signal === 9n ? Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number) : [];
    if (Number(sys().symbols.syscall(PIDFD_SEND_SIGNAL, BigInt(fd), signal, 0n, 0n)) !== 0) return false;
    for (const c of children) killTree(c);
    return true;
  } finally {
    sys().symbols.close(fd);
  }
};

// what a run's job folder records for `stop`: its caller, label and the worker as started; its id is the folder's name
export const markRun = (dir: string, caller: string, label: string): string => {
  writeFileSync(join(dir, WHO), `${caller} ${label} ${procId(process.pid) ?? "-"}`);
  return basename(dir);
};

// A caller that holds the connection (hold in job.json) keeps the helper's stdin open until it reads WORKER_EXIT: EOF
// before that is the caller gone. On 2026-11-08 gongdori's rvp-make2 ran on cha two hours after its caller had gone:
// cha's Tailscale SSH closes a lost session's I/O ("processes exit on their own") and keeps the session's process, so
// the worker's parent never changed (stopWithCaller) and bwrap's --die-with-parent, which watches the worker, never
// fired; the worker's stdin did reach EOF at once. gone() logs; the worker then stops as on SIGTERM (heavy-job.ts
// stopNow: its folder deleted, its slot freed, its box gone with it). The function it returns ends the watch once the run
// is over, so the worker exits without waiting for the caller to close.
export const watchCaller = (gone: () => void): (() => void) => {
  let ended = false;
  const r = Bun.stdin.stream().getReader();
  void (async () => {
    while (!(await r.read()).done);
    if (ended) return;
    gone();
    process.kill(process.pid, "SIGTERM");
  })();
  return () => {
    ended = true;
    void r.cancel();
  };
};

// The caller's side of hold: the helper's stdin is closed once WORKER_EXIT came (the run is over there), so an ssh stand-in
// that copies stdin through (cat) ends too; a run that broke off has its ssh gone with its stdin. Returns code.
export const endedWith = (stdin: { end(): unknown }, code: number): number => {
  void stdin.end();
  return code;
};

// a run stop ended says so to its caller as it goes (heavy-job.ts onStop): WORKER_CANCELLED
export const sayCancelled = (dir: string): void => {
  if (existsSync(join(dir, CANCELLED))) console.error("WORKER_CANCELLED stopped there by dori heavy-stop");
};


// WORKER_ALIVE <phase> on stderr every aliveSec while the run lasts; set() names the phase
export const heartbeat = (aliveSec: number) => {
  let phase = "in";
  const t = setInterval(() => console.error(`WORKER_ALIVE ${phase}`), aliveSec * 1000);
  return {
    set: (p: string): void => {
      phase = p;
    },
    stop: (): void => clearInterval(t),
  };
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
// was this run stopped here (its <run>.cancelled record), so a caller whose worker died without a word can tell a manual
// stop from a dropped connection? Only the caller that started it may ask.
export const wasCancelled = (execRoot: string, caller: string, label: string, run: string): boolean => {
  try {
    const who = readFileSync(join(execRoot, run, WHO), "utf8").split(" ");
    if (who[0] !== caller || who[1] !== label) return false;
  } catch {
    // the folder is gone; the record is enough
  }
  return existsSync(join(execRoot, "..", "cancelled", run));
};

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
    // the recorded worker: SIGTERM first, so it tells its caller (sayCancelled) and cleans up; what is left after 3 s is
    // killed. Both signals go through a pidfd after a fresh identity check (killIfStill), so a reused pid is never hit.
    // Its descendants are collected before the signal: a worker that exits on SIGTERM leaves no parent for pgrep -P, and
    // children it started outside the box (GPU-room, playwright) would otherwise escape the later SIGKILL.
    if (now !== undefined) {
      writeFileSync(join(execRoot, d, CANCELLED), "");
      // a durable cancellation record outside the run folders, so a caller whose worker was killed can still learn this
      // run was stopped here (the run folder itself is deleted)
      mkdirSync(join(deps.dir, "cancelled"), { recursive: true });
      writeFileSync(join(deps.dir, "cancelled", d), "");
      const children = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
      if (killIfStill(pid, now, SIGTERM)) for (let i = 0; i < 30 && procId(pid) === now; i++) Bun.sleepSync(100);
      killIfStill(pid, now);
      for (const c of children) killTree(c);
    }
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
