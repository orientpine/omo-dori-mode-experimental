import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { BatchJob } from "./heavy-batch.ts";
import { fmtMem } from "./heavy-mem.ts";
import { nearestExisting, within, type Plan } from "./heavy-spread.ts";

// What refuses a dori heavy --items batch before any item (HEAVY_BATCH_REFUSED, exit 2), and which hosts it may use.

// --on HOST,... names the hosts a batch may use, --not-on HOST,... the ones it may not (gongdori 2026-11-14, #dori-pair
// 1571035412586168382: only the machines that passed the same-answer check); neither lifts a helper's batch: false
export const allowedHost = (b: Pick<BatchJob, "onHosts" | "notOn">, name: string): boolean => (!b.onHosts || b.onHosts.includes(name)) && !b.notOn?.includes(name);

// hosts: every helper's name and this host's; usable: the ones the batch may take (allowedHost, batch: false left out)
export const refusal = (b: BatchJob, plans: readonly Plan[], hosts: { readonly known: readonly string[]; readonly usable: readonly string[]; readonly here: string }): string | undefined => {
  if (b.memCap !== undefined && b.memPerWorker !== undefined && b.memCap < b.memPerWorker) return `--mem ${fmtMem(b.memCap)} is less than one worker's --mem-per-worker ${fmtMem(b.memPerWorker)}`;
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
