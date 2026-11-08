// dori migrate: upstream dori-superagent #157 (https://github.com/sisyphuslabs/dori-superagent/commit/501676610eef882b03114fe3bd2c76ae134760f6,
// its src/migrate.ts; licences in NOTICE) moves a Dori's sessions to another session runtime. Here it is a plan over the
// fork's own handovers, which already open the replacement, verify it and close or roll back the old one: the config's
// runtime is switched first, so each lane handover opens its new session on the target, and the lead goes last through its
// own dori handover (its summary note is its to write). Upstream's journal, inbox forwarding and duty and hourly loops
// have no counterpart in the fork (its loops are systemd units that run on any runtime). Running it again moves only
// what is not on the target yet; dori migrate --to herdr is the way back.
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isHcPane } from "./hc-pane.ts";
import type { RuntimeKind } from "./runtime/types.ts";

export type MigrateLane = { readonly key: string; readonly pane?: string | undefined; readonly status?: string | undefined };
export type MigratePlan = { readonly moving: readonly MigrateLane[]; readonly lines: readonly string[] };

const kindOf = (pane: string): RuntimeKind => (isHcPane(pane) ? "hc" : "herdr");
const isOpen = (l: MigrateLane): boolean => !!l.pane && l.status !== "done" && l.status !== "lost";

export const migratePlan = (lanes: readonly MigrateLane[], leadPane: string, current: RuntimeKind, to: RuntimeKind, only: readonly string[] = []): MigratePlan => {
  const open = lanes.filter(isOpen);
  for (const key of only) if (!open.some((l) => l.key === key)) throw new Error(`no open lane ${key} with a session`);
  const chosen = only.length ? open.filter((l) => only.includes(l.key)) : open;
  const lines = [current === to ? `MIGRATE_SKIP config runtime already ${to}` : `MIGRATE_PLAN config runtime ${current} -> ${to}`];
  const moving: MigrateLane[] = [];
  for (const l of chosen) {
    const pane = l.pane ?? "";
    if (kindOf(pane) === to) lines.push(`MIGRATE_SKIP lane ${l.key} ${pane} already on ${to}`);
    else {
      moving.push(l);
      lines.push(`MIGRATE_PLAN lane ${l.key} ${pane} -> ${to} (lane handover)`);
    }
  }
  if (leadPane) lines.push(kindOf(leadPane) === to ? `MIGRATE_SKIP lead ${leadPane} already on ${to}` : `MIGRATE_PLAN lead ${leadPane} -> ${to} (after the lanes: the lead's own dori handover, with its summary note)`);
  return { moving, lines };
};

// Why a run cannot start, or undefined. As upstream, it names its scope: --lane K or --all, never both and never none. A
// DORI_RUNTIME naming the other runtime is refused: it outranks the config's runtime the run writes, so this process and
// every handover started with that environment would reopen sessions on the runtime being left.
export const migrateRefusal = (to: RuntimeKind, env: Readonly<Record<string, string | undefined>>, scope: { readonly all: boolean; readonly lane?: string | undefined }): string | undefined => {
  if (scope.all === !!scope.lane) return "give --lane K or --all";
  const pinned = env["DORI_RUNTIME"]?.trim();
  if (pinned && pinned !== to) return `DORI_RUNTIME=${pinned} overrides the config's runtime; unset it, or set it to ${to}, then run dori migrate again`;
  return undefined;
};

export type LaneMove = (key: string) => Promise<{ readonly code: number; readonly retry?: boolean | undefined }>;

// The lanes of the plan through their handovers, one at a time. The first that fails stops the run: the lanes before it
// stay moved, the rest are not tried, and running again (or --to <from> to go back) picks up from there.
export const moveLanes = async (moving: readonly MigrateLane[], from: RuntimeKind, to: RuntimeKind, move: LaneMove, log: (line: string) => void): Promise<number> => {
  for (const lane of moving) {
    log(`MIGRATE_LANE ${lane.key} ${lane.pane ?? ""} -> ${to}`);
    const r = await move(lane.key);
    if (r.code !== 0) {
      log(`MIGRATE_STOPPED lane ${lane.key}: its handover exited ${r.code}${r.retry ? " (busy: run dori migrate again once it is ready)" : ""}; the lanes before it moved, the rest wait; dori migrate --to ${from} --all --approved-by REF goes back`);
      return r.code;
    }
  }
  return 0;
};

// The config file with its "runtime" set to `to`, the rest as it was; the copy it had before is kept beside it.
export const writeRuntime = (path: string, to: RuntimeKind, stamp: string): string => {
  const before = readFileSync(path, "utf8");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(before) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`config ${path} is not JSON (${e instanceof Error ? e.message : String(e)}); nothing was written`);
  }
  const backup = `${path}.bak-migrate-${stamp}`;
  copyFileSync(path, backup);
  writeFileSync(`${path}.new`, `${JSON.stringify({ ...raw, runtime: to }, null, 2)}\n`);
  renameSync(`${path}.new`, path);
  return backup;
};
