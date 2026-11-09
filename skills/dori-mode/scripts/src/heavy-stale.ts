import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { dlopen, FFIType } from "bun:ffi";

import { killTree } from "./heavy-job.ts";
import type { HeavyHelper } from "./heavy-route.ts";
import { readerLines, settle } from "./heavy-settle.ts";

// Is a helper's run still alive (heavy-spread.ts)? On 2026-11-08 zzangdori's rvq-c3-final2 went to cha with a 2.1 GB --sync
// and sat 73 minutes with no line on either side until its lane cut it by hand: the upload went at 0.2-0.6 MB/s over the
// internet, the caller logged HEAVY_SPREAD only once the upload was over, the helper logged nothing between its admission
// and the job's start, and the caller waited on ssh with no check of its own. Now the caller logs HEAVY_SYNC while it
// uploads (lead 2026-11-08: "HEAVY_SYNC <label> <보낸 MB>/<전체 MB>"), a helper sends WORKER_ALIVE heartbeats (announced
// as alive=<sec> on its WORKER_ADMIT line), and a run with no bytes taken during the upload, or no line from a helper that
// beats after it, for heavyQueue.staleMin minutes is stale: HEAVY_HELPER_STALE, the ssh is killed, the helper is asked to
// stop what is left of it, and the job ends with STALE_EXIT, or with --stale-again goes back to the line. A long job that
// keeps beating is never cut; one on a helper that does not beat yet is watched during its upload only.

export const STALE_EXIT = 124;
// how long a stale run's ssh, tar and untar get to end after their process groups were killed
export const STALE_GRACE_MS = 5_000;

// stale: the run ended for no sign of life; abandoned: what it started had not all ended STALE_GRACE_MS after that
export type Stale = { readonly stale: string; readonly abandoned: boolean };

const SYNC_LOG_MS = 5 * 60_000;
// the file in a helper run's job folder naming its caller and label, as `stop <label>` matches them
const WHO = "who";

// alive=<sec> on a WORKER_ADMIT line: the helper's heartbeat, or undefined for a helper that does not beat
export const aliveOf = (admitted: string): number | undefined => {
  const s = Number(/(?:^|\s)alive=(\d+(?:\.\d+)?)(?:\s|$)/.exec(admitted)?.[1]);
  return s > 0 ? s : undefined;
};

// run=<id> on a WORKER_ADMIT line: that run's job folder on the helper, which `stop <label> <id>` ends alone (a label is not
// unique: two lanes of one caller may run the same label at once)
export const runOf = (admitted: string): string | undefined => /(?:^|\s)run=(\d{1,10}-[\w-]{1,32})(?:\s|$)/.exec(admitted)?.[1];

const mb = (b: number): string => (b / 1e6).toFixed(0);

type Watch = { readonly sent: (bytes: number) => void; readonly heard: () => void; readonly synced: () => void; readonly stop: () => void; readonly stale: Promise<string> };

// The caller's watch on one helper run: sent() for bytes the helper took, heard() for a line from it, synced() once the
// upload is over. stale resolves with why the run is stale; stop() ends the watch.
export const staleWatch = (o: { readonly label: string; readonly helper: string; readonly total: (stopped: Promise<unknown>) => Promise<number>; readonly staleMs: number; readonly aliveSec?: number; readonly now: () => number; readonly log: (l: string) => void }): Watch => {
  const start = o.now();
  // the upload's size comes when du answers (heavy-send.ts syncBytes), the first HEAVY_SYNC line with it or the first byte
  let total = 0;
  let stopped: () => void = () => {};
  void o.total(new Promise<void>((r) => (stopped = r))).then((n) => {
    total = n;
    if (!first && !opened && syncing && shown()) open();
  });
  let last = start;
  let logged = start;
  let sent = 0;
  let syncing = true;
  let fire: (why: string) => void = () => {};
  const stale = new Promise<string>((r) => (fire = r));
  const line = () => {
    const sec = Math.max(1, (o.now() - start) / 1000);
    const rate = sent / sec;
    const left = rate > 0 && total > sent ? `, about ${Math.ceil((total - sent) / rate / 60)} min left` : "";
    o.log(`HEAVY_SYNC ${o.label} ${mb(sent)}/${mb(total)} MB to ${o.helper}, ${(rate / 1e6).toFixed(2)} MB/s${left}`);
  };
  // a job of less than 1 MB goes in a moment: no HEAVY_SYNC lines for it
  const shown = (): boolean => total >= 1e6;
  let first = true;
  let opened = false;
  const open = (): void => {
    opened = true;
    line();
  };
  // a heartbeat that comes less often than staleMin would make a live run look stale: three missed beats at the least
  const quietMs = Math.max(o.staleMs, 3 * (o.aliveSec ?? 0) * 1000);
  const tick = setInterval(() => {
    const now = o.now();
    if (syncing && shown() && now - logged >= SYNC_LOG_MS) {
      logged = now;
      line();
    }
    const min = ((now - last) / 60_000).toFixed(1);
    if (syncing && now - last >= o.staleMs) fire(`it took no bytes for ${min} min (${mb(sent)}/${mb(total)} MB sent)`);
    else if (!syncing && o.aliveSec !== undefined && now - last >= quietMs) fire(`no word from it for ${min} min after the upload (it beats every ${o.aliveSec} s)`);
  }, Math.max(50, Math.min(30_000, o.staleMs / 4)));
  return {
    sent: (n) => {
      if (first && shown()) open();
      first = false;
      sent += n;
      if (syncing) last = o.now();
    },
    heard: () => {
      if (!syncing) last = o.now();
    },
    synced: () => {
      if (!syncing) return;
      syncing = false;
      last = o.now();
      if (shown()) line();
    },
    stop: () => {
      clearInterval(tick);
      stopped();
    },
    stale,
  };
};

// After a stale run: ask the helper to stop what is left of it (`dori heavy-worker "stop <label> <run>"`), waitMs at most
// for its answer, its stderr read included (a subprocess timeout ends with its direct child); true when left unended
export const stopOnHelper = async (h: HeavyHelper, label: string, log: (l: string) => void, run: string | undefined, waitMs = 30_000): Promise<boolean> => {
  // a helper that named no run id is older than run ids; a stop by label alone could end another run of that label there
  if (!run) {
    log(`HEAVY_HELPER_STOP ${label} ${h.name}: not asked, it named no run id (its dori is older), and a stop by label could end another run of ${label} there`);
    return false;
  }
  const p = Bun.spawn([...h.ssh, "stop", label, run], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const reader = p.stderr.getReader();
  let said: string | undefined;
  const answer = (async () => {
    for await (const l of readerLines(reader)) {
      if (!/^WORKER_(STOPPED|REFUSED)\b/.test(l)) continue;
      said = l;
      return;
    }
  })();
  // its answer and its ssh's exit, waitMs at most together: a child of that ssh may hold stderr after the answer
  const ended = await settle([p], [reader], Promise.all([answer, p.exited]), waitMs);
  log(`HEAVY_HELPER_STOP ${label} ${h.name}: ${said ?? (ended ? `no answer (ssh exited ${p.exitCode ?? p.signalCode})` : `no answer within ${waitMs / 1000} s`)}${ended ? "" : "; dori heavy ends without waiting on the stop"}`);
  return !ended;
};

// ---- the helper's side

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

// what a run's job folder records for `stop`: its caller, label and the worker as started; its id is the folder's name
export const markRun = (dir: string, caller: string, label: string): string => {
  writeFileSync(join(dir, WHO), `${caller} ${label} ${procId(process.pid) ?? "-"}`);
  return basename(dir);
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
export const stopRuns = (execRoot: string, slotsDir: string, caller: string, label: string, run?: string): number => {
  let n = 0;
  const ls = (d: string): string[] => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
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
    for (const s of ls(slotsDir).filter((x) => /^slot\.\d+$/.test(x))) {
      let owner = "";
      try {
        owner = readFileSync(join(slotsDir, s, "owner"), "utf8");
      } catch {
        continue;
      }
      if (owner.split(" ")[0] === String(pid)) rmSync(join(slotsDir, s), { recursive: true, force: true });
    }
    removeRun(join(execRoot, d));
    n++;
  }
  return n;
};
