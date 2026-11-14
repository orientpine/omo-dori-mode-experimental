import { accessSync, appendFileSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { spreadPlan, within, type Plan, type SpreadJob } from "./heavy-spread.ts";

// dori heavy --kind: a job whose working folder or job file lies outside its --sync paths no longer runs on this host in
// silence. Owner 2026-11-14 ("Doriterm 연결된 모든 리소스 효율적으로 쓰게 만들어 놨는데 왜 이번에 동작 안 했는지 확인하고
// 개선해"): gongdori's jobs of 2026-11-12 said HEAVY_LOCAL "... is not in a --sync path" and ran on 0a83 alone while five
// helpers sat idle, and one died at its cap on 11/14. Now the missing folder or file goes along (HEAVY_SHIP, one
// HEAVY_SHIP_FILE line per file in heavy.log) when it holds at most heavyShipMaxMb and nothing of a no-ship path
// (heavyNoShip, default ~/data: gongdori's raw expert data may never leave this host, only the reduced trajectory file
// the owner allowed, #dori-pair 1571030089280266255), read through realpath, links inside it too. Otherwise the job
// stops before it runs (HEAVY_LOCAL_REFUSED); --local asks for this host on purpose.

export type ShipFile = { readonly path: string; readonly bytes: number };
export type Shipped = { readonly job: SpreadJob; readonly plan: Extract<Plan, { ok: true }>; readonly shipped: readonly string[]; readonly files: readonly ShipFile[] };
// the working folder, then each file the command names: a plan says one missing path at a time; past ROUNDS the job is
// refused, never sent back to this host in silence (review 1 of #479)
const ROUNDS = 32;

const home = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

// the files under p (p itself when it is a file), or why p may not leave this host: it is or holds a no-ship path, a link
// under it leads into one, or it holds more than maxBytes
export const shipFiles = (p: string, noShip: readonly string[], maxBytes: number): { readonly files: ShipFile[] } | { readonly why: string } => {
  const blocked = noShip.map(home).map((b) => realOr(b) ?? b);
  const hit = (real: string): string | undefined => blocked.find((b) => within(real, b) || within(b, real));
  const top = realOr(p) ?? p;
  const at = hit(top);
  if (at) return { why: `${p} is or holds ${at}, a heavyNoShip path that never leaves this host` };
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
  return why ? { why } : { files };
};

// the job with every missing folder or file it may take along added to its --sync paths, and its plan; refuse: a missing
// path that may not go along (the job stops); else why it stays here for a reason of its own, as before (HEAVY_LOCAL:
// a .dori-heavy-local file, a git checkout synced in part, a link out of --sync)
export type NotShipped = { readonly why: string; readonly refuse: boolean };
export const shipMissing = (job: SpreadJob, who: { readonly uid: number; readonly home: string; readonly path?: string }, noShip: readonly string[], maxBytes: number): Shipped | NotShipped => {
  let j = job;
  const shipped: string[] = [];
  const files: ShipFile[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    const plan = spreadPlan(j, who);
    if (plan.ok) return { job: j, plan, shipped, files };
    const miss = plan.missing;
    if (!miss) return { why: plan.why, refuse: false };
    if (round === ROUNDS) return { why: `${plan.why}; it is not sent along: more than ${ROUNDS} paths outside --sync, give them with --sync`, refuse: true };
    const f = shipFiles(miss, noShip, maxBytes - files.reduce((n, x) => n + x.bytes, 0));
    if ("why" in f) return { why: `${plan.why}; it is not sent along: ${f.why}`, refuse: true };
    shipped.push(miss);
    files.push(...f.files);
    j = { ...j, sync: [...j.sync, miss] };
  }
  return { why: "unreachable", refuse: false };
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
