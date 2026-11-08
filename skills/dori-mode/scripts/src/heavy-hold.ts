import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedDirProblem } from "./shared-dir.ts";

// dori heavy hold-local: a window in which no new heavy job of any account takes a heavy slot on this host. zzangdori
// 2026-11-08 (#dori-pair): while 0a83 measured and ran its regression, other Doris' jobs took 0a83's slot whenever every
// helper was busy, and the window broke five times. One file per account in heavyHoldDir, a directory every account writes
// in (shared-dir.ts), since each account's heavy slots are its own: a job of any account reads them all before it takes a
// slot here (heavy-slot.ts acquire), and goes to a helper or waits instead. Jobs already running go on.
// Any account writes in that directory, so every read of it fails closed and bounded: what cannot be listed, stat'd,
// read or parsed holds (for a minute at a time, or a day from its file's write at most), and nothing is read past 4 KiB
// or past a file's day.
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

const holdOf = (dir: string, name: string, now: number): Hold | undefined => {
  const file = join(dir, name);
  const failed = (e: unknown): Hold | undefined => {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    // a link or a FIFO, socket or device put in its owner's place only drops that owner's own hold
    if (e instanceof Error && "code" in e && e.code === "ELOOP") return undefined;
    // a hold file this account cannot open or stat holds while it cannot
    const code = e instanceof Error && "code" in e ? String(e.code) : String(e);
    return { by: "?", reason: `${file} cannot be read here (${code}); the hold directory must be mode 1777`, until: now + 60_000 };
  };
  // one descriptor for everything: no waiting for a FIFO's writer, no following a link, and what is read is what was
  // stat'd (another account may swap its own entry between a stat of the path and an open of it)
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    return failed(e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    // its owner can set mtime to any time, never ctime (set by the kernel at each write, rename or touch of the file)
    const cap = Math.min(st.mtimeMs, st.ctimeMs) + MAX_MS;
    // an ended one is not read at all, and a live one only as far as a hold can be long: any account may write here
    if (cap <= now) return undefined;
    let parsed: { reason?: unknown; until?: unknown } = {};
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const v: unknown = st.size <= MAX_BYTES ? JSON.parse(buf.toString("utf8", 0, readSync(fd, buf, 0, MAX_BYTES, 0))) : undefined;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) parsed = v as typeof parsed;
    } catch {
      // a file cut off while written, or not JSON: it holds, for the longest a hold may
    }
    const until = typeof parsed.until === "string" && !Number.isNaN(Date.parse(parsed.until)) ? Math.min(Date.parse(parsed.until), cap) : cap;
    const reason = typeof parsed.reason === "string" && typeof parsed.until === "string" ? parsed.reason : UNREADABLE;
    return until > now ? { by: accountOf(st.uid), reason, until } : undefined;
  } catch (e) {
    return failed(e);
  } finally {
    closeSync(fd);
  }
};

/** The live holds on this host, the one ending first first. */
export const liveHolds = (dir: string, now: number): Hold[] => {
  let names: string[];
  try {
    // nothing in a hold directory that is a link (to /dev, say) or not shared like it must be is opened at all
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o1777) !== 0o1777) return [{ by: "?", reason: `the hold directory ${dir} is not a plain directory of mode 1777; fix or remove it`, until: now + 60_000 }];
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    // a directory this account cannot read may hold another account's hold: it holds until it can be read
    const code = e instanceof Error && "code" in e ? String(e.code) : String(e);
    return [{ by: "?", reason: `the hold directory ${dir} cannot be read here (${code}); it must be mode 1777`, until: now + 60_000 }];
  }
  return names.flatMap((n) => holdOf(dir, n, now) ?? []).sort((a, b) => a.until - b.until);
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
export const holdOn = (dir: string, user: string, until: number, reason: string, now: number): string | undefined => {
  let unsafe: string | undefined;
  try {
    unsafe = sharedDirProblem(dir) ?? ((lstatSync(dir).mode & 0o1777) !== 0o1777 ? "is not mode 1777, so other accounts could not read or write their holds" : undefined);
  } catch (e) {
    unsafe = `cannot be made or checked: ${String(e).slice(0, 200)}`;
  }
  if (unsafe) return `the hold directory ${dir} ${unsafe}`;
  const tmp = join(dir, `.${user}.${process.pid}.${now}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ reason, until: new Date(until).toISOString(), at: new Date(now).toISOString() }), { flag: "wx" });
    // readable by every account whatever this process's umask, so their jobs see it
    chmodSync(tmp, 0o644);
    renameSync(tmp, fileOf(dir, user));
    return undefined;
  } catch (e) {
    rmSync(tmp, { force: true });
    return `could not write ${fileOf(dir, user)}: ${String(e).slice(0, 200)}`;
  }
};

/** Ends this account's hold; another account's ends at its time or with its own off. */
export const holdOff = (dir: string, user: string): boolean => {
  const had = holdOf(dir, `${user}.json`, Date.now()) !== undefined;
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
