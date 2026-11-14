import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The one place a caller's upload is listed (the lead after review 6 of #479: not a guard per input kind). Every path any
// --sync root, --tools tree, working folder sent along or link brings in is walked here, each read through realpath and
// held against heavyNoShip; one hit refuses the whole upload. tar then gets this list itself (--no-recursion -T -) and
// never a tree to walk, and the same list is read again after tar ended: a folder swapped for a link meanwhile (tar opens
// the names again: challenge of the r7 plan) throws the archive away before a byte is sent.
// Threat model (the lead, 2026-11-14): heavyNoShip keeps a trusted dori of this account from sending ~/data out by mistake
// (a config, a link, a relative path, an input kind). Someone who swaps files on purpose while the upload is made is out of
// scope: the re-read by device and inode is a cheap net, not a guarantee. Not caught: a hard link to a file under
// heavyNoShip (it has its own realpath), and a swap that puts the same inode back while tar runs (docs/follow-ups.md).
// noShip: the config's heavyNoShip; unset means the default ["~/data"], only an explicit [] blocks nothing (lead).
export const NO_SHIP_DEFAULT = ["~/data"];
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
type Entry = { readonly path: string; readonly real: string; readonly dev: number; readonly ino: number };
const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const blockedOf = (noShip: readonly string[] | undefined): string[] => (noShip ?? NO_SHIP_DEFAULT).map((b) => (b === "~" ? homedir() : b.startsWith("~/") ? join(homedir(), b.slice(2)) : b)).map((b) => realOr(b) ?? b);
// kind: blocked, a heavyNoShip hit; name, a name that is not UTF-8 (it cannot be listed as it is: review 7 of #479); read,
// a path that could not be read
export type ListWhy = { readonly why: string; readonly kind: "blocked" | "name" | "read" };
export const archiveList = (roots: readonly string[], noShip: readonly string[] | undefined): { readonly entries: readonly Entry[] } | ListWhy => {
  const blocked = blockedOf(noShip);
  const entries: Entry[] = [];
  let kind: ListWhy["kind"] = "read";
  const walk = (p: string): string | undefined => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch (e) {
      return (e as { code?: string }).code === "ENOENT" ? undefined : `${p} could not be read to archive it (${(e as { code?: string }).code ?? String(e).slice(0, 80)})`;
    }
    const real = realOr(p) ?? p;
    const at = blocked.find((b) => inside(real, b) || inside(b, real));
    if (at) kind = "blocked";
    if (at) return `${p}${st.isSymbolicLink() ? " is a link into" : real === p ? " is or holds" : ` is ${real}, in`} ${at}, a heavyNoShip path that never leaves this host`;
    entries.push({ path: p, real, dev: st.dev, ino: st.ino });
    if (!st.isDirectory()) return undefined;
    let names: Buffer[];
    try {
      names = readdirSync(p, { encoding: "buffer" }).sort(Buffer.compare);
    } catch (e) {
      return `${p} could not be read to archive it (${(e as { code?: string }).code ?? String(e).slice(0, 80)})`;
    }
    for (const b of names) {
      const n = b.toString("utf8");
      if (!Buffer.from(n).equals(b)) {
        kind = "name";
        return `${p} holds a name that is not UTF-8, so it cannot be listed to send it (rename it, or run it here with --local)`;
      }
      const why = walk(join(p, n));
      if (why) return why;
    }
    return undefined;
  };
  for (const r of roots) {
    const why = walk(r);
    if (why) return { why, kind };
  }
  return { entries };
};
// why the archive may not go: an entry whose realpath is no longer what was checked, or one gone or another file (its
// device and inode) after tar read it (review 7 of #479: a link put in and taken away again while tar ran)
const sameAs = (e: Entry): boolean => {
  try {
    const st = lstatSync(e.path);
    return st.dev === e.dev && st.ino === e.ino;
  } catch {
    return false;
  }
};
export const movedOf = (entries: readonly Entry[]): string | undefined => {
  const moved = entries.find((e) => { const now = realOr(e.path); return now !== undefined && now !== e.real; });
  if (moved) return `${moved.path} changed into another path while it was archived`;
  const gone = entries.find((e) => !sameAs(e));
  return gone && `${gone.path} was gone or another file after it was archived`;
};
// tar of exactly the listed names, read from stdin, NUL-separated, never walking a folder on its own
export const TAR_LIST = ["-cf", "-", "-C", "/", "--null", "--no-recursion", "-T", "-"];
