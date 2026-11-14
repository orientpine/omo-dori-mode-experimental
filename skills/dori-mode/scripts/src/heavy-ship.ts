import { accessSync, appendFileSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { spreadPlan, within, type Plan, type SpreadJob } from "./heavy-spread.ts";

// dori heavy --kind: a job whose working folder or job file lies outside its --sync paths no longer runs on this host in
// silence. Owner 2026-11-14 ("Doriterm 연결된 모든 리소스 효율적으로 쓰게 만들어 놨는데 왜 이번에 동작 안 했는지 확인하고
// 개선해"): gongdori's jobs of 2026-11-12 said HEAVY_LOCAL "... is not in a --sync path" and ran on 0a83 alone while five
// helpers sat idle, and one died at its cap on 11/14. Now the working folder (or its git checkout) goes along (HEAVY_SHIP, one
// HEAVY_SHIP_FILE line per file in heavy.log) when it holds at most heavyShipMaxMb and nothing of a no-ship path
// (heavyNoShip, default ~/data: gongdori's raw expert data may never leave this host, only the reduced trajectory file
// the owner allowed, #dori-pair 1571030089280266255), read through realpath, links inside it too. Otherwise the job
// stops before it runs (HEAVY_LOCAL_REFUSED); --local asks for this host on purpose.

export type ShipFile = { readonly path: string; readonly bytes: number };
export type Shipped = { readonly job: SpreadJob; readonly plan: Extract<Plan, { ok: true }>; readonly shipped: readonly string[]; readonly files: readonly ShipFile[] };
// the working folder, then its checkout: at most two paths are sent along; past that the job is refused, never sent back
// to this host in silence (review 1 of #479)
const ROUNDS = 2;

const home = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

// the heavyNoShip path real (a realpath of) p is in or holds
const hitOf = (noShip: readonly string[]): ((real: string) => string | undefined) => {
  const blocked = noShip.map(home).map((b) => realOr(b) ?? b);
  return (real) => blocked.find((b) => within(real, b) || within(b, real));
};
const KEEP = "it never leaves this host: run it here with --local";

// why a declared --sync path may not leave this host: it is or holds a heavyNoShip path, or a link under it leads into one
// (review 5 of #479: the guard held only for what went along unasked). Nothing is kept: tar reads the same tree anyway.
const noShipWhy = (p: string, hit: (real: string) => string | undefined): string | undefined => {
  const at = hit(realOr(p) ?? p);
  if (at) return `${p} is or holds ${at}, a heavyNoShip path`;
  const walk = (f: string): string | undefined => {
    let names: string[];
    try {
      const st = lstatSync(f);
      if (st.isSymbolicLink()) {
        const into = hit(realOr(f) ?? f);
        return into ? `the link ${f} leads into ${into}, a heavyNoShip path` : undefined;
      }
      names = st.isDirectory() ? readdirSync(f) : [];
    } catch {
      return undefined; // what cannot be read cannot be archived either
    }
    for (const e of names) {
      const why = walk(join(f, e));
      if (why) return why;
    }
    return undefined;
  };
  return walk(p);
};

// the files under p (p itself when it is a file), or why p may not leave this host: it is or holds a no-ship path, a link
// under it leads into one (keep: no --sync fixes that), or it holds more than maxBytes
export const shipFiles = (p: string, noShip: readonly string[], maxBytes: number): { readonly files: ShipFile[] } | { readonly why: string; readonly keep?: true } => {
  const hit = hitOf(noShip);
  const top = realOr(p) ?? p;
  const at = hit(top);
  if (at) return { why: `${p} is or holds ${at}, a heavyNoShip path that never leaves this host`, keep: true };
  let keep = false;
  const files: ShipFile[] = [];
  let total = 0;
  // a path that is not there yet, or that cannot be read, is a reason to stop, not a throw (review 1 of #479)
  const unread = (f: string, e: unknown): string => {
    const code = (e as { code?: string }).code ?? String(e).slice(0, 80);
    return f === p && code === "ENOENT" ? `${p} does not exist on this host, so it cannot go along (one the job makes? put it under a --sync folder)` : `${p} could not be read here to send it along (${code} at ${f})`;
  };
  const walk = (f: string): string | undefined => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(f);
    } catch (e) {
      return unread(f, e);
    }
    if (st.isSymbolicLink()) {
      const to = realOr(f);
      const into = to && hit(to);
      keep = !!into;
      return into ? `the link ${f} leads into ${into}, a heavyNoShip path that never leaves this host` : undefined;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(f);
      } catch (e) {
        return unread(f, e);
      }
      for (const e of names) {
        const why = walk(join(f, e));
        if (why) return why;
      }
      return undefined;
    }
    if (!st.isFile()) return undefined;
    try {
      accessSync(f, constants.R_OK);
    } catch (e) {
      return unread(f, e);
    }
    total += st.size;
    files.push({ path: f, bytes: st.size });
    return total > maxBytes ? `${p} holds over ${Math.round(maxBytes / 1024 ** 2)}M (heavyShipMaxMb)` : undefined;
  };
  const why = walk(p);
  return why ? { why, ...(keep ? { keep: true as const } : {}) } : { files };
};

// the job with its working folder (or that folder's whole git checkout) added to its --sync paths when that alone kept it
// here, and its plan. A helper gets only what is declared, the --sync paths, and that folder; never a path guessed from the
// command's arguments (review 3 of #479; Bazel and GNU parallel send only declared inputs too). refuse: the job stops
// before it runs (a path only --sync may send, or a folder that may not go along); else it runs here for a reason of its
// own (HEAVY_LOCAL: a .dori-heavy-local file, a git checkout synced in part)
// the fix line for a path only --sync may send, one that works (challenge of #479 r5): a path outside home and /tmp cannot
// be a --sync path at all, and one already given with --sync needs that path fixed, not added again
const syncFix = (p: string, sync: readonly string[], home: string, hit: (real: string) => string | undefined): string => {
  if (hit(realOr(p) ?? p)) return `${p} is in a heavyNoShip path: ${KEEP}`;
  const mayGo = (within(p, home) && p !== home) || (within(p, "/tmp") && p !== "/tmp");
  if (!mayGo) return "only paths in your home or /tmp go to a helper: copy it there and give that with --sync, or run it here with --local";
  return sync.includes(p) ? "it cannot go to a helper as given: fix that --sync path, or run it here with --local" : `a helper gets only the --sync paths and the working folder (add --sync ${p})`;
};
export type NotShipped = { readonly why: string; readonly refuse: boolean };
// what one batch already weighed, keyed by path: its items share one walk and one inventory (review 5 of #479)
export type ShipSeen = Map<string, string | undefined | ReturnType<typeof shipFiles>>;
export const shipMissing = (job: SpreadJob, who: { readonly uid: number; readonly home: string; readonly path?: string }, noShip: readonly string[], maxBytes: number, seen: ShipSeen = new Map()): Shipped | NotShipped => {
  const hit = hitOf(noShip);
  const once = <T extends string | undefined | ReturnType<typeof shipFiles>>(k: string, f: () => T): T => {
    if (!seen.has(k)) seen.set(k, f());
    return seen.get(k) as T;
  };
  let j = job;
  const shipped: string[] = [];
  let files: readonly ShipFile[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    const plan = spreadPlan(j, who);
    if (plan.ok) {
      for (const s of job.sync) {
        const why = once(`sync\0${s}`, () => noShipWhy(s, hit));
        if (why) return { why: `--sync ${why}; ${KEEP}`, refuse: true };
      }
      return { job: j, plan, shipped, files };
    }
    if (plan.kind === "sync") return { why: `${plan.why}; ${syncFix(plan.path ?? "", j.sync, who.home, hit)}`, refuse: true };
    if (plan.kind !== "ship" || !plan.path) return { why: plan.why, refuse: false };
    if (round === ROUNDS) return { why: `${plan.why}; it is not sent along: the working folder and its checkout are already sent`, refuse: true };
    const left = maxBytes - files.reduce((n, x) => n + x.bytes, 0);
    const path = plan.path;
    const f = once(`ship\0${left}\0${path}`, () => shipFiles(path, noShip, left));
    if ("why" in f) return { why: `${plan.why}; it is not sent along: ${f.why}; ${f.keep ? KEEP : "give the folders it needs with --sync instead"}`, refuse: true };
    shipped.push(plan.path);
    files = files.length ? [...files, ...f.files] : f.files;
    j = { ...j, sync: [...j.sync, plan.path] };
  }
  return { why: "unreachable", refuse: true };
};

// one HEAVY_SHIP line per folder or file sent along (stderr and heavy.log), and one HEAVY_SHIP_FILE line per file in heavy.log alone
export const logShip = (heavyLog: string, label: string, s: Pick<Shipped, "shipped" | "files">, log: (l: string) => void): void => {
  for (const p of s.shipped) {
    const fs = s.files.filter((f) => within(f.path, p));
    log(`HEAVY_SHIP ${label}: ${p} is not in a --sync path, so it goes along: ${fs.length} file(s), ${fs.reduce((n, f) => n + f.bytes, 0)} bytes`);
  }
  const at = new Date().toISOString();
  if (s.files.length) appendFileSync(heavyLog, s.files.map((f) => `${at} HEAVY_SHIP_FILE ${label}: ${f.path} ${f.bytes}\n`).join(""));
};
