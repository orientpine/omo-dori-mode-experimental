import type { Proc } from "./session-id.ts";

// upstream sisyphuslabs/dori-superagent#225: close and session lookup share the existing tree walk.
export const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  const seen = new Set([root]);
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};
