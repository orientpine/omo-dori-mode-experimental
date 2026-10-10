import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "./config.ts";
import { configKeys, knownConfigKeys } from "./config-keys.ts";
import type { Clock, Runner } from "./run.ts";
import { restartService } from "./update-ready.ts";
import { watchLog } from "./watch-log.ts";
import { announceChange, guidanceFiles, mergeTitles } from "./update-announce.ts";

export type UpdateState = { readonly applied: string; readonly keys: readonly string[] };
export type UpdateDeps = {
  readonly config: DoriConfig;
  readonly configPath: string;
  readonly git: Runner;
  readonly systemctl: Runner;
  readonly clock: Clock;
  readonly send: (pane: string, text: string) => Promise<boolean>;
  readonly print: (line: string) => void;
};
export type UpdateOptions = { readonly pull: boolean; readonly dryRun: boolean };
export class UpdateError extends Error {}

const readState = async (path: string): Promise<UpdateState | undefined> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const value: unknown = await file.json();
  if (value !== null && typeof value === "object" && "applied" in value && "keys" in value &&
      typeof value.applied === "string" && Array.isArray(value.keys) && value.keys.every((key: unknown) => typeof key === "string")) {
    return { applied: value.applied, keys: value.keys };
  }
  throw new UpdateError(`invalid update state: ${path}`);
};

export const applyUpdate = async (deps: UpdateDeps, options: UpdateOptions): Promise<boolean> => {
  const { config } = deps;
  const emit = (line: string): void => {
    deps.print(options.dryRun ? `DRY_RUN ${line}` : line);
    if (!options.dryRun) watchLog(config.watchLog, deps.clock, { source: "update", line });
  };
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await deps.git(["git", "-C", config.update.repo, ...args], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new UpdateError(`git ${args[0]}: ${result.err || result.out || `exit ${result.code}`}`);
    return result.out;
  };
  try {
    if (options.pull && !options.dryRun) await git(["pull", "--ff-only"]);
    if (options.pull && options.dryRun) deps.print("DRY_RUN git pull --ff-only (not executed)");
    const head = await git(["rev-parse", "HEAD"]);
    const path = join(config.stateDir, "update.json");
    const state = await readState(path);
    const keys = knownConfigKeys();
    if (state?.applied === head) { deps.print("UP_TO_DATE"); return true; }
    const save = async (): Promise<void> => {
      if (options.dryRun) return;
      mkdirSync(config.stateDir, { recursive: true });
      await Bun.write(path, `${JSON.stringify({ applied: head, keys }, null, 2)}\n`);
    };
    if (!state) {
      await save();
      emit(`UPDATED first-run ${head.slice(0, 7)}`);
      return true;
    }
    const file = Bun.file(deps.configPath);
    const raw: unknown = await file.exists() ? await file.json() : {};
    const set = new Set(configKeys(raw));
    const newKeys = keys.filter((key) => !state.keys.includes(key) && !set.has(key));
    const notices = newKeys.map((key) => `CONFIG_NEW_KEY ${key} unset in ${deps.configPath} (default used)`);
    const changed = (await git(["diff", "--name-only", state.applied, head])).split("\n").filter(Boolean);
    const range = `${state.applied}..${head}`;
    const titles = mergeTitles(await git(["log", "--merges", "--format=%s%n%b", "-z", range]));
    const summary = (titles.length ? titles : (await git(["log", "--format=%s", range])).split("\n").filter(Boolean)).join("\n");
    const restarted: string[] = [];
    const failures: string[] = [];
    const results: string[] = [];
    for (const line of notices) emit(line);
    for (const service of config.update.services) {
      if (!service.paths.some((prefix) => changed.some((name) => name.startsWith(prefix)))) continue;
      if (options.dryRun) { deps.print(`DRY_RUN restart ${service.unit} ${head.slice(0, 7)}`); continue; }
      let reason: string | undefined;
      try {
        reason = await restartService({ systemctl: deps.systemctl, clock: deps.clock, timeoutSec: config.update.readyTimeoutSec }, service);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        reason = error.message;
      }
      if (reason) {
        const line = `RESTART_FAIL ${service.unit} ${reason}`;
        failures.push(line);
        results.push(line);
        emit(line);
      } else {
        restarted.push(service.unit);
        const line = `RESTARTED ${service.unit} ${head.slice(0, 7)}`;
        results.push(line);
        emit(line);
      }
    }
    await save();
    emit(`UPDATED ${state.applied.slice(0, 7)}..${head.slice(0, 7)} changed=${changed.length} restarted=${restarted.join(",") || "-"}`);
    if (!options.dryRun) await announceChange(deps, { summary: summary || `${state.applied.slice(0, 7)}..${head.slice(0, 7)}`, files: guidanceFiles(changed), keys: newKeys, restarts: results.length ? results : ["No configured services matched changed paths."] });
    if (failures.length && config.update.alertPane) {
      const text = `[ALERT] dori update: ${[...failures, ...notices].join("; ")}`;
      if (!(await deps.send(config.update.alertPane, text))) emit(`UPDATE_FAIL alert did not reach ${config.update.alertPane}`);
    }
    return failures.length === 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const line = `UPDATE_FAIL ${error.message}`;
    emit(line);
    if (!options.dryRun && config.update.alertPane) {
      try {
        if (!(await deps.send(config.update.alertPane, `[ALERT] dori update: ${line}`))) emit(`UPDATE_FAIL alert did not reach ${config.update.alertPane}`);
      } catch (sendError) {
        if (!(sendError instanceof Error)) throw sendError;
        emit(`UPDATE_FAIL alert: ${sendError.message}`);
      }
    }
    return false;
  }
};
