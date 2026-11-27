import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { withLaneLock } from "./lane-lifecycle.ts";
import type { Lane } from "./registry.ts";

export type WriteOptions = { readonly relocate?: boolean };

// Registry.write (split out for the line cap), under the lane's lock so no other write or revive lands between its read
// and its rename. A lane's sessions are history: whatever path changes its session (a handover, dori sync --write, a
// revive), the outgoing one is kept in priorSessions, so its cost counts every session it had (supervision.ts
// laneSessionUsage). A revive (and a launch or adopt that makes the record) is a relocation: a new pane revision. A
// record read before the last relocation and written back keeps the pane on disk; a write built from a fresh read (a
// handover's, any sweep's) carries the revision on disk and moves the pane as before (review 11 of #535).
export const writeLane = (dir: string, path: string, read: (key: string) => Promise<Lane | null>, upgrade: (lane: Lane) => Lane, given: Lane, opts: WriteOptions): Promise<void> =>
  withLaneLock(dirname(dir), given.key, (ms) => Bun.sleep(ms), Date.now, async () => {
    mkdirSync(dir, { recursive: true });
    let lane = given;
    const before = await read(lane.key).catch(() => null);
    const outgoing = before?.session && before.session !== lane.session ? [before.session] : [];
    const prior = [...new Set([...(before?.priorSessions ?? []), ...(lane.priorSessions ?? []), ...outgoing])].filter((s) => s !== lane.session);
    if (prior.length) lane = { ...lane, priorSessions: prior };
    const rev = before?.paneRev ?? 0;
    if (opts.relocate) lane = { ...lane, paneRev: rev + 1 };
    // nor does such an old read open again a lane closed since (review 12 of #535)
    else if (before && (lane.paneRev ?? 0) < rev) lane = { ...lane, pane: before.pane, tab: before.tab, paneRev: rev, ...(before.closedAt && !lane.closedAt ? { closedAt: before.closedAt, status: before.status, receipt: before.receipt, history: before.history } : {}) };
    lane = upgrade(lane);
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, path);
  });
