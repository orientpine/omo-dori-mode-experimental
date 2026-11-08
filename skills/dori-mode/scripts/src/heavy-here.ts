import { type ScopedRun, spawnScoped } from "./heavy-mem.ts";
import { acquireSlot, releaseSlot, type SlotDeps } from "./heavy-slot.ts";

// A dori heavy job that runs here: in a heavy slot (the one heavySpread already took for it, else one it waits for) and
// its own scope. Its command and everything that command starts see DORI_HEAVY_JOB=<label> (a named --job's command too,
// heavy-job.ts runJob), and a dori heavy started under it (rv make inside dori heavy ... -- rv make without --no-heavy, a
// script or a named job that calls dori heavy itself) runs at once in that job's slot and scope (HEAVY_NESTED): waiting
// for a slot of its own while the job it runs in holds one never ended with the last slot taken (lead 2026-11-08,
// rv-actreverse-skip).
export const NESTED_ENV = "DORI_HEAVY_JOB";
export const heavyOuter = (): string | undefined => process.env[NESTED_ENV] || undefined;
export const nestedLine = (label: string): string => `HEAVY_NESTED ${label}: inside the heavy job ${heavyOuter()} here, so it runs now in that job's slot and scope`;

// spawnScoped without a scope of its own, for a job inside another: through sh's exec as spawnScoped starts it, so a
// command that is not there ends 127 and one that cannot run 126
export const spawnHere: typeof spawnScoped = async (r, opts, onStart) => {
  const p = Bun.spawn(["/bin/sh", "-c", 'exec "$@"', "dori-heavy-job", ...r.cmd], { ...opts });
  onStart?.(p.pid, p);
  return await p.exited;
};

export const runHere = async (deps: SlotDeps, r: ScopedRun, o: { readonly slot?: string | undefined; readonly env?: Record<string, string | undefined> }): Promise<number> => {
  const io = { stdout: "inherit", stderr: "inherit", stdin: "inherit" } as const;
  if (heavyOuter()) {
    r.log?.(nestedLine(r.label));
    return await spawnHere(r, { ...io, ...(o.env ? { env: o.env } : {}) });
  }
  const slot = o.slot ?? (await acquireSlot(deps, r.label, 15_000, r.needBytes ? r.needBytes / 1024 : undefined));
  try {
    return await spawnScoped(r, { ...io, env: { ...(o.env ?? process.env), [NESTED_ENV]: r.label } });
  } finally {
    releaseSlot(slot);
  }
};
