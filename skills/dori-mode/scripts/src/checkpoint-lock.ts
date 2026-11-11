import { randomUUID } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export class CheckpointError extends Error {}

type LockOwner = { readonly pid: number; readonly host: string; readonly at: string; readonly nonce: string };

// Fork change (reviews of orientpine#297): the writer lock is a kernel flock on the lock file, not a lock file whose
// owner record is checked and then deleted. A check and a delete on a pathname are never one step, so upstream's takeover
// of a stale lock could delete a live writer's lock and let two writers append at once. The kernel drops a flock when its
// process dies, so a writer killed mid-write never locks the lane and nothing is taken over by age.
const LOCK_EX = 2;
const LOCK_NB = 4;
// libc is opened on first use, not at import: every dori command imports this module, and native Windows has no libc
// (dlopen at import made the whole CLI fail there). Windows takes the lock its own way (takeWindowsLock below).
let libc: ReturnType<typeof openLibc> | undefined;
const openLibc = () => dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const flock = (fd: number, op: number): number => {
  libc ??= openLibc();
  return libc.symbols.flock(fd, op);
};

// Native Windows has no flock. The lock there is the lock file opened through CreateFileW without write sharing and with
// FILE_FLAG_DELETE_ON_CLOSE: a second taker's open fails with a sharing violation while the holder's handle is open, and
// Windows closes that handle (and so deletes the file) when the holder exits or dies, so, as with flock, a killed writer
// never locks the lane and nothing is taken over by age. Readers still read the owner record (read and delete are shared).
let kernel32: ReturnType<typeof openKernel32> | undefined;
const openKernel32 = () => dlopen("kernel32.dll", {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  WriteFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  FlushFileBuffers: { args: [FFIType.i64], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x00010000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_DELETE = 4;
const OPEN_ALWAYS = 4;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const ERROR_ACCESS_DENIED = 5; // the file is still being deleted after its holder closed it
const ERROR_SHARING_VIOLATION = 32;

const takeWindowsLock = (lock: string, record: string, busy: () => CheckpointError): (() => void) => {
  kernel32 ??= openKernel32();
  const k = kernel32.symbols;
  const name = Buffer.from(`${lock}\0`, "utf16le");
  const handle = k.CreateFileW(name, GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, null);
  if (handle === -1n) {
    const code = k.GetLastError();
    if (code === ERROR_SHARING_VIOLATION || code === ERROR_ACCESS_DENIED) throw busy();
    throw new Error(`lock ${lock}: CreateFileW failed (Windows error ${code})`);
  }
  const bytes = Buffer.from(record, "utf8");
  const written = new Uint32Array(1);
  if (!k.WriteFile(handle, bytes, bytes.length, written, null) || written[0] !== bytes.length || !k.FlushFileBuffers(handle)) {
    const code = k.GetLastError();
    k.CloseHandle(handle);
    throw new Error(`lock ${lock}: writing the owner record failed (Windows error ${code})`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    k.CloseHandle(handle);
  };
};

const ownerOf = (lock: string): LockOwner | null => {
  let raw: string;
  try {
    raw = readFileSync(lock, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const v = JSON.parse(raw) as Partial<LockOwner> | null;
    return typeof v?.pid === "number" && typeof v.host === "string" && typeof v.at === "string" && typeof v.nonce === "string" ? v as LockOwner : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // a writer stopped between taking the lock and writing its record
  }
};

/**
 * Take a lock and return its release. The lock is a flock on the lock file held by this open file: another holder, in this
 * process or another, is refused with the owner record (pid, host, time) the holder wrote. The release removes the lock
 * file while still holding it, so a taker that opened the old file finds it no longer at the path once it gets the flock,
 * and opens the path again. Also used for the one-time cost record of a lane (src/supervision.ts).
 */
export const takeLock = (lock: string, now: number, what: string, key: string): (() => void) => {
  const record = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(now).toISOString(), nonce: randomUUID() } satisfies LockOwner);
  const busy = () => {
    const owner = ownerOf(lock);
    const since = owner ? Date.parse(owner.at) : NaN;
    return new CheckpointError(`${what} locked: ${key} (${owner ? `pid ${owner.pid}` : "no owner record"}${Number.isFinite(since) ? `, ${Math.max(0, Math.round((now - since) / 1000))} s old` : ""})`);
  };
  if (process.platform === "win32") return takeWindowsLock(lock, record, busy);
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = openSync(lock, "a+", 0o600);
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      closeSync(fd);
      throw busy();
    }
    const named = statSync(lock, { throwIfNoEntry: false });
    if (!named || named.ino !== fstatSync(fd).ino) {
      closeSync(fd); // a release removed (or replaced) the file between our open and our flock
      continue;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, record);
    fsyncSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      rmSync(lock, { force: true });
      closeSync(fd);
    };
  }
  throw new CheckpointError(`${what} locked: ${key} (the lock file changed while taking it; retry)`);
};

/**
 * Run body while holding the lock, waiting while another holder has it (polled, since a blocking flock would stop the
 * event loop) up to waitMs, after which its CheckpointError stands. The lock file's folder is made first. The lane tree
 * takes it around load, change and save (src/explore.ts updateTree), so two `dori tree add` calls at once never read
 * one tree, hand out one F number twice and overwrite each other's entry (worklog 7d68e5b0: F183 twice).
 */
export const holdLock = async <T>(lock: string, what: string, key: string, body: () => Promise<T>, waitMs = 10_000): Promise<T> => {
  mkdirSync(dirname(lock), { recursive: true });
  const until = Date.now() + waitMs;
  let release: () => void;
  for (;;) {
    try {
      release = takeLock(lock, Date.now(), what, key);
      break;
    } catch (e) {
      if (!(e instanceof CheckpointError) || Date.now() > until) throw e;
      await Bun.sleep(20);
    }
  }
  try {
    return await body();
  } finally {
    release();
  }
};
