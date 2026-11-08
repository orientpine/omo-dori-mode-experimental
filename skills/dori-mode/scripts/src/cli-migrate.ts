// dori migrate --to hc|herdr: the plan of src/migrate.ts run through the fork's own handovers (upstream #157's command).
import { copyFileSync } from "node:fs";
import { currentTmuxSession } from "./aoe.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";
import { configPath, loadConfig } from "./config.ts";
import { laneHandover } from "./lane-handover.ts";
import { migratePlan, writeRuntime } from "./migrate.ts";
import { isRuntimeKind, run, runtimeChoice, useConfiguredRuntime } from "./run.ts";
import type { RuntimeKind } from "./runtime/types.ts";

const USAGE = "usage: dori migrate --to hc|herdr --approved-by REF [--lane K] [--dry-run]";

const migrateCommand: Command = async (context) => {
  const { opt, config, flags, deps } = context;
  const wanted = opt("to");
  if (!isRuntimeKind(wanted)) return die(USAGE);
  const to: RuntimeKind = wanted;
  if (config.backend === "aoe") die("MIGRATE_REFUSED an aoe Dori runs its lanes on tmux; dori migrate moves herdr and hc sessions");
  const from = runtimeChoice(config, process.env).kind;
  const only = opt("lane") ? [opt("lane") ?? ""] : [];
  const plan = await Promise.resolve(deps.registry.list()).then((lanes) => migratePlan(lanes, config.leadPane, from, to, only)).catch((e: unknown) => die(`MIGRATE_REFUSED ${e instanceof Error ? e.message : String(e)}`));
  for (const line of plan.lines) console.log(line);
  if (flags.values["dry-run"]) return;
  const approvedBy = opt("approved-by")?.trim() || die(`--approved-by is needed (the lane handovers take it): ${USAGE}`);
  if (from !== to) {
    const path = configPath();
    const backup = writeRuntime(path, to, new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""));
    const loaded = await loadConfig(path, undefined, () => {}).catch((e: unknown) => e);
    if (loaded instanceof Error) {
      copyFileSync(backup, path);
      die(`MIGRATE_REFUSED the config with "runtime": "${to}" does not load (${loaded.message}); put back from ${backup}`);
    }
    console.log(`MIGRATE_CONFIG ${path} runtime ${from} -> ${to} (backup ${backup})`);
    useConfiguredRuntime(to);
  }
  const here = await currentTmuxSession(run);
  const { laneDepsFor } = makeHandoverDeps(context);
  for (const lane of plan.moving) {
    console.log(`MIGRATE_LANE ${lane.key} ${lane.pane ?? ""} -> ${to}`);
    const r = await laneHandover(laneDepsFor(), lane.key, here, { approvedBy });
    if (r.code !== 0) {
      console.log(`MIGRATE_STOPPED lane ${lane.key}: its handover exited ${r.code}${r.retry ? " (busy: run dori migrate again once it is ready)" : ""}; the lanes before it moved, the rest wait; dori migrate --to ${from} --approved-by REF goes back`);
      process.exit(r.code);
    }
  }
  const leadNext = plan.lines.find((l) => l.startsWith("MIGRATE_PLAN lead"));
  if (leadNext) console.log(`MIGRATE_LEAD_NEXT the lead moves to ${to} last, through its own handover: dori handover --approved-by "${approvedBy}" --note <its summary>`);
  console.log(`MIGRATE_DONE ${plan.moving.length} lane(s) on ${to}${leadNext ? "; the lead is next" : ""}`);
};

export const migrateCommands: Readonly<Record<string, Command>> = { migrate: migrateCommand };
