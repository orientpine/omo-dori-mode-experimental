import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The one place a caller's upload is listed (the lead after review 6 of #479: not a guard per input kind). Every path any
// --sync root, --tools tree, working folder sent along or link brings in is walked here, each read through realpath and
// held against heavyNoShip; one hit refuses the whole upload. tar then gets this list itself (--no-recursion -T -) and
// never a tree to walk, and the same list is read again after tar ended: a folder swapped for a link meanwhile (tar opens
// the names again: challenge of the r7 plan) throws the archive away before a byte is sent. Not caught (threat model): a
// hard link to a file under heavyNoShip (it has its own realpath), and a swap put back while tar still runs.
// noShip: the config's heavyNoShip; unset means the default ["~/data"], only an explicit [] blocks nothing (lead).
export const NO_SHIP_DEFAULT = ["~/data"];
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
type Entry = { readonly path: string; readonly real: string };
const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const blockedOf = (noShip: readonly string[] | undefined): string[] => (noShip ?? NO_SHIP_DEFAULT).map((b) => (b === "~" ? homedir() : b.startsWith("~/") ? join(homedir(), b.slice(2)) : b)).map((b) => realOr(b) ?? b);
// blocked: the why is a heavyNoShip hit (else a path that could not be read)
export const archiveList = (roots: readonly string[], noShip: readonly string[] | undefined): { readonly entries: readonly Entry[] } | { readonly why: string; readonly blocked?: true } => {
  const blocked = blockedOf(noShip);
  const entries: Entry[] = [];
  let blockedHit = false;
  const walk = (p: string): string | undefined => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch (e) {
      return (e as { code?: string }).code === "ENOENT" ? undefined : `${p} could not be read to archive it (${(e as { code?: string }).code ?? String(e).slice(0, 80)})`;
    }
    const real = realOr(p) ?? p;
    const at = blocked.find((b) => inside(real, b) || inside(b, real));
    blockedHit = !!at;
    if (at) return `${p}${st.isSymbolicLink() ? " is a link into" : real === p ? " is or holds" : ` is ${real}, in`} ${at}, a heavyNoShip path that never leaves this host`;
    entries.push({ path: p, real });
    if (!st.isDirectory()) return undefined;
    let names: string[];
    try {
      names = readdirSync(p).sort();
    } catch (e) {
      return `${p} could not be read to archive it (${(e as { code?: string }).code ?? String(e).slice(0, 80)})`;
    }
    for (const n of names) {
      const why = walk(join(p, n));
      if (why) return why;
    }
    return undefined;
  };
  for (const r of roots) {
    const why = walk(r);
    if (why) return blockedHit ? { why, blocked: true } : { why };
  }
  return { entries };
};
// the first entry whose realpath is no longer what was checked (one gone is not: tar said so, exit 1)
export const movedOf = (entries: readonly Entry[]): string | undefined => entries.find((e) => { const now = realOr(e.path); return now !== undefined && now !== e.real; })?.path;
// tar of exactly the listed names, read from stdin, NUL-separated, never walking a folder on its own
export const TAR_LIST = ["-cf", "-", "-C", "/", "--null", "--no-recursion", "-T", "-"];
