import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { sharedDirProblem } from "./shared-dir.ts";

// dori heavy hold-local: a window in which no new heavy job of any account takes a heavy slot on this host. zzangdori
// 2026-11-08 (#dori-pair): while 0a83 measured and ran its regression, other Doris' jobs took 0a83's slot whenever every
// helper was busy, and the window broke five times. One file per account in heavyHoldDir, a directory every account writes
// in (shared-dir.ts), since each account's heavy slots are its own: a job of any account reads them all before it takes a
// slot here (heavy-slot.ts acquire), and goes to a helper or waits instead. Jobs already running go on.
// Trust (#408, the way Kubernetes cordon or Slurm DRAIN keep a hold in one authorized place, here a shared directory):
// - every Dori account on this host may set and clear its own hold, and any hold stops every account's new local jobs;
// - the account that made the directory owns it and could drop every hold by replacing it, or make it unreadable;
// - an entry in another account's place is hostile input: no reader may hang on it, follow a link through it, read
//   past 4 KiB of it, crash on it, or miss a valid hold because of it, and a file that cannot be opened or parsed holds
//   at most a day from its write (its times come from a look before the open); an entry or a directory that cannot
//   even be looked at holds until it can (only the directory's owner can cause that), with a line naming it.
// A broker daemon that would remove the shared directory is a follow-up (docs/follow-ups.md).
export type Hold = { readonly by: string; readonly reason: string; readonly until: number };

// a hold ends a day after its file was written at the latest, whatever its until says: a forgotten or forged hold never
// keeps this host's slots for longer
const MAX_MS = 24 * 3_600_000;
const UNREADABLE = "(its file cannot be read)";
// a hold file is a few hundred bytes (a 200-character reason and two times); one bigger is not a hold this code wrote
const MAX_BYTES = 4096;
// the account of a file's owner, so a hold names who set it whatever the file says
const accountOf = (uid: number): string => {
  let passwd = "";
  try {
    passwd = readFileSync("/etc/passwd", "utf8");
  } catch {
    // a name only labels the hold; without one it still holds
  }
  const line = passwd.split("\n").find((l) => l.split(":")[2] === String(uid));
  return line?.split(":")[0] ?? `uid ${uid}`;
};

// code of a filesystem error, for the fail-closed reasons
const codeOf = (e: unknown): string => (e instanceof Error && "code" in e ? String(e.code) : String(e));
const failClosed = (reason: string, now: number): Hold => ({ by: "?", reason, until: now + 60_000 });

// afterLook: a test's hook between the look at an entry and its open, where another account may swap its own entry
const holdOf = (base: string, shown: string, name: string, now: number, afterLook?: (file: string) => void, again = true): Hold | undefined => {
  const file = join(base, name);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e) {
    return codeOf(e) === "ENOENT" ? undefined : failClosed(`${join(shown, name)} cannot be read here (${codeOf(e)}); the hold directory must be mode 1777`, now);
  }
  // a link, FIFO, socket or device in an account's place only drops that account's own hold
  if (!st.isFile()) return undefined;
  // its owner can set mtime to any time, never ctime (set by the kernel at each write, rename or touch of the file)
  const cap = Math.min(st.mtimeMs, st.ctimeMs) + MAX_MS;
  // an ended one is not opened at all, and a live one read only as far as a hold can be long: any account may write here
  if (cap <= now) return undefined;
  const unreadable: Hold = { by: accountOf(st.uid), reason: UNREADABLE, until: cap };
  afterLook?.(file);
  // one open, no waiting for a FIFO's writer and no link followed; what is read must be the file looked at
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    return ["ENOENT", "ELOOP", "ENXIO"].includes(codeOf(e)) ? undefined : unreadable;
  }
  try {
    const fst = fstatSync(fd);
    // a FIFO, socket or device swapped in only drops its owner's own hold
    if (!fst.isFile()) return undefined;
    // another regular file than the one looked at: holdOn renews a hold by renaming a new file over it, so look once
    // more; an entry that keeps changing holds, as one that cannot be read
    if (fst.ino !== st.ino || fst.dev !== st.dev) return again ? holdOf(base, shown, name, now, afterLook, false) : unreadable;
    const capNow = Math.min(cap, Math.min(fst.mtimeMs, fst.ctimeMs) + MAX_MS);
    if (capNow <= now) return undefined;
    let parsed: { reason?: unknown; until?: unknown } = {};
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const v: unknown = fst.size <= MAX_BYTES ? JSON.parse(buf.toString("utf8", 0, readSync(fd, buf, 0, MAX_BYTES, 0))) : undefined;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) parsed = v as typeof parsed;
    } catch {
      // a file cut off while written, or not JSON: it holds, for the longest a hold may
    }
    const until = typeof parsed.until === "string" && !Number.isNaN(Date.parse(parsed.until)) ? Math.min(Date.parse(parsed.until), capNow) : capNow;
    const reason = typeof parsed.reason === "string" && typeof parsed.until === "string" ? parsed.reason : UNREADABLE;
    return until > now ? { by: accountOf(fst.uid), reason, until } : undefined;
  } catch {
    return unreadable;
  } finally {
    closeSync(fd);
  }
};

const NOT_PLAIN = "is not a plain directory of mode 1777; fix or remove it";

/** The live holds on this host, the one ending first first. afterDirLook / afterLook: a test's hooks between a look and its use. */
export const liveHolds = (dir: string, now: number, hooks: { readonly afterDirLook?: () => void; readonly afterLook?: (file: string) => void } = {}): Hold[] => {
  // the directory is opened once (no link followed) and everything in it is reached through that descriptor, so one
  // swapped after the check is never read; nothing in a directory that is a link or not shared as it must be is opened
  let dfd: number;
  try {
    dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (e) {
    return codeOf(e) === "ENOENT" ? [] : [failClosed(`the hold directory ${dir} ${NOT_PLAIN} (${codeOf(e)})`, now)];
  }
  try {
    const st = fstatSync(dfd);
    if (!st.isDirectory() || (st.mode & 0o1777) !== 0o1777) return [failClosed(`the hold directory ${dir} ${NOT_PLAIN}`, now)];
    hooks.afterDirLook?.();
    const base = existsSync(`/proc/self/fd/${dfd}`) ? `/proc/self/fd/${dfd}` : dir;
    return readdirSync(base).filter((n) => n.endsWith(".json")).flatMap((n) => holdOf(base, dir, n, now, hooks.afterLook) ?? []).sort((a, b) => a.until - b.until);
  } catch (e) {
    // a directory this account cannot list may hold another account's hold: it holds until it can be read
    return [failClosed(`the hold directory ${dir} cannot be read here (${codeOf(e)}); it must be mode 1777`, now)];
  } finally {
    closeSync(dfd);
  }
};

export const holdLine = (h: Hold, now: number): string => `by ${h.by} until ${new Date(h.until).toISOString()} (${Math.ceil((h.until - now) / 60_000)} min left): ${h.reason}`;
export const holdNote = (dir: string, now: number): string | undefined => liveHolds(dir, now).map((h) => holdLine(h, now)).join("; ") || undefined;

// --until: minutes (30, 30m), hours (2h), a clock time on this host's clock (03:10, the next one) or an ISO time
export const parseUntil = (s: string, now: number): { readonly at: number } | { readonly why: string } => {
  const n = /^(\d+)(m|h)?$/.exec(s);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  let at: number;
  if (n) at = now + Number(n[1]) * (n[2] === "h" ? 3_600_000 : 60_000);
  else if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    at = d.getTime() <= now ? d.getTime() + 24 * 3_600_000 : d.getTime();
  } else if (/^\d{4}-\d\d-\d\dT/.test(s) && !Number.isNaN(Date.parse(s))) at = Date.parse(s);
  else return { why: `--until takes minutes (30), hours (2h), a time on this host's clock (03:10) or an ISO time (2026-11-09T04:45+09:00), not "${s}"` };
  if (at <= now) return { why: `--until ${s} is not ahead of now` };
  if (at - now > MAX_MS) return { why: `--until ${s} is more than 24 h ahead; a hold is for a measuring window` };
  return { at };
};

const fileOf = (dir: string, user: string): string => join(dir, `${user}.json`);

/** Sets this account's hold (one per account, a new one replaces it); a problem, or undefined. */
// afterWrite: a test's hook between the write of the temporary file and its rename, where the directory's owner may swap it
export const holdOn = (dir: string, user: string, until: number, reason: string, now: number, hooks: { readonly afterWrite?: (tmp: string) => void } = {}): string | undefined => {
  let unsafe: string | undefined;
  try {
    unsafe = sharedDirProblem(dir) ?? ((lstatSync(dir).mode & 0o1777) !== 0o1777 ? "is not mode 1777, so other accounts could not read or write their holds" : undefined);
  } catch (e) {
    unsafe = `cannot be made or checked: ${String(e).slice(0, 200)}`;
  }
  if (unsafe) return `the hold directory ${dir} ${unsafe}`;
  const tmp = join(dir, `.${user}.${process.pid}.${now}.tmp`);
  try {
    // written and made readable through the descriptor it was made with: the directory's owner can swap the name, and
    // a chmod through it would change whatever the name then leads to (another file of this account)
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(fd, JSON.stringify({ reason, until: new Date(until).toISOString(), at: new Date(now).toISOString() }));
      // readable by every account whatever this process's umask, so their jobs see it
      fchmodSync(fd, 0o644);
    } finally {
      closeSync(fd);
    }
    hooks.afterWrite?.(tmp);
    renameSync(tmp, fileOf(dir, user));
    return undefined;
  } catch (e) {
    rmSync(tmp, { force: true });
    return `could not write ${fileOf(dir, user)}: ${String(e).slice(0, 200)}`;
  }
};

/** Ends this account's hold; another account's ends at its time or with its own off. */
export const holdOff = (dir: string, user: string): boolean => {
  const had = holdOf(dir, dir, `${user}.json`, Date.now()) !== undefined;
  rmSync(fileOf(dir, user), { force: true });
  return had;
};

export const HOLD_USAGE = 'usage: dori heavy hold-local [on --until <minutes|2h|HH:MM|ISO> --reason "<why>" | off]';

/** dori heavy hold-local [on|off]: its HEAVY_HOLD_LOCAL lines and exit code. */
export const holdCommand = (dir: string, user: string, verb: string | undefined, until: string | undefined, reason: string, now: number): { readonly lines: string[]; readonly code: number } => {
  const others = (): string[] => liveHolds(dir, now).map((h) => `HEAVY_HOLD_LOCAL on ${holdLine(h, now)}`);
  if (verb === undefined) {
    const on = others();
    return { lines: on.length ? on : ["HEAVY_HOLD_LOCAL off: no hold on this host"], code: 0 };
  }
  if (verb === "off") return { lines: [holdOff(dir, user) ? `HEAVY_HOLD_LOCAL off by ${user}` : `HEAVY_HOLD_LOCAL off: ${user} held nothing`, ...others()], code: 0 };
  if (verb !== "on") return { lines: [HOLD_USAGE], code: 2 };
  const at = until === undefined ? { why: "--until is needed" } : parseUntil(until, now);
  const why = "why" in at ? at.why : !reason || reason.length > 200 || /[\n\r]/.test(reason) ? "--reason is needed: one line, up to 200 characters" : holdOn(dir, user, at.at, reason, now);
  if (why || !("at" in at)) return { lines: [`HEAVY_HOLD_LOCAL refused: ${why}`, HOLD_USAGE], code: 2 };
  const mine = { by: user, reason, until: at.at };
  return { lines: [`HEAVY_HOLD_LOCAL on ${holdLine(mine, now)}; new heavy jobs of every account on this host go to a helper or wait, running ones go on`, ...others().filter((l) => !l.includes(` by ${user} until `))], code: 0 };
};
