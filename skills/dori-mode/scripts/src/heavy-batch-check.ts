import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { BatchJob } from "./heavy-batch.ts";
import { fmtMem } from "./heavy-mem.ts";
import { shipMissing, type ShipFile, type ShipSeen } from "./heavy-ship.ts";
import { nearestExisting, spreadPlan, within, type Plan, type SpreadJob } from "./heavy-spread.ts";

// What refuses a dori heavy --items batch before any item (HEAVY_BATCH_REFUSED, exit 2), and which hosts it may use.

// --on HOST,... names the hosts a batch may use, --not-on HOST,... the ones it may not (gongdori 2026-11-14, #dori-pair
// 1571035412586168382: only the machines that passed the same-answer check); neither lifts a helper's batch: false
export const allowedHost = (b: Pick<BatchJob, "onHosts" | "notOn">, name: string): boolean => (!b.onHosts || b.onHosts.includes(name)) && !b.notOn?.includes(name);

// hosts: every helper's name and this host's; usable: the ones the batch may take (allowedHost, batch: false left out)
export const refusal = (b: BatchJob, plans: readonly Plan[], hosts: { readonly known: readonly string[]; readonly usable: readonly string[]; readonly here: string }): string | undefined => {
  if (b.memCap !== undefined && b.memPerWorker !== undefined && b.memCap < b.memPerWorker) return `--mem ${fmtMem(b.memCap)} is less than one worker's --mem-per-worker ${fmtMem(b.memPerWorker)}`;
  // a helper named like this host would take --local's items (review 9 of #479): ambiguous, so refused, never guessed
  if (hosts.known.filter((n) => n === hosts.here).length > 1) return `heavyQueue.helpers has a helper named ${hosts.here}, this host's own name, so --local, --on and --not-on cannot tell them apart; rename that helper`;
  const unknown = [...(b.onHosts ?? []), ...(b.notOn ?? [])].filter((n) => !hosts.known.includes(n));
  if (unknown.length) return `--on/--not-on name ${unknown.join(", ")}, which is no host here (known: ${hosts.known.join(", ")})`;
  if (!hosts.usable.length) return `--on/--not-on leave no host the batch may use (a helper with batch: false is never one)`;
  const stuck = plans.findIndex((p) => !p.ok);
  if (stuck >= 0 && !hosts.usable.includes(hosts.here)) return `item #${stuck + 1} can run only on this host (${(plans[stuck] as { why: string }).why}), which --on/--not-on leave out`;
  // --out read through realpath, fail closed: through a link it could lie in an upload whatever its words say
  const at = nearestExisting(resolve(b.out));
  if (realpathSync(at) !== at) return `--out ${b.out} goes through a link (${at} is ${realpathSync(at)}); give a real folder outside the --sync paths`;
  const inSync = [...b.sync, ...plans.flatMap((p) => (p.ok ? p.sync : []))].find((s) => within(b.out, s) || within(s, b.out));
  return inSync ? `--out ${b.out} and the --sync path ${inSync} hold one another, so uploads would carry the batch's own files; give --out a folder outside them` : undefined;
};

// each item's job and plan, with what goes along (heavy-ship.ts): every item that may leave this host gets one --sync list,
// the batch's paths and every folder or file any item sends along, so the batch makes one archive and every helper item
// runs on the same bytes (review 1 of #479: a list per item archived the common tree again for each); stops: why no item
// may run (a path that may not go along, or more than heavyShipMaxMb sent along in all)
export const shipItems = (b: BatchJob, jobs: readonly SpreadJob[], who: { readonly uid: number; readonly home: string; readonly path?: string }): { readonly items: { readonly job: SpreadJob; readonly plan: Plan }[]; readonly stops: string[]; readonly shipped: Map<string, ShipFile[]> } => {
  const stops: string[] = [];
  const shipped = new Map<string, ShipFile[]>();
  if (!b.ship) return { items: jobs.map((job) => ({ job, plan: spreadPlan(job, who) })), stops, shipped };
  const { noShip, maxBytes } = b.ship;
  // one walk and one inventory per path for the whole batch, shared by its items (review 5 of #479)
  const seen: ShipSeen = new Map();
  const each = jobs.map((job, i) => {
    const s = shipMissing(job, who, noShip, maxBytes, seen);
    if ("refuse" in s && s.refuse) stops.push(`#${i + 1}: ${s.why}`);
    if ("job" in s) for (const p of s.shipped) if (!shipped.has(p)) shipped.set(p, s.files.filter((f) => within(f.path, p)));
    return s;
  });
  const bytes = [...new Map([...shipped.values()].flat().map((f) => [f.path, f.bytes])).values()].reduce((n, x) => n + x, 0);
  if (bytes > maxBytes) stops.push(`the folders and files the items send along hold over ${Math.round(maxBytes / 1024 ** 2)}M in all (heavyShipMaxMb)`);
  const sync = [...new Set([...b.sync, ...shipped.keys()])];
  return {
    items: jobs.map((job, i) => {
      const s = each[i]!;
      if ("why" in s) return { job, plan: { ok: false, why: s.why } };
      const one = { ...job, sync };
      return { job: one, plan: spreadPlan(one, who) };
    }),
    stops,
    shipped,
  };
};
