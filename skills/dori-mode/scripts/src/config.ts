import { homedir } from "node:os";
import { join } from "node:path";
import { isOmoExecutable } from "./executable.ts";
import { isRuntimeKind, type Ran, run, type Runner, type RunOptions } from "./run.ts";
import { supervisionProblem } from "./supervision.ts";
import type { ArgvTemplate, DoriConfig } from "./config-types.ts";
import { defaultConfig } from "./config-defaults.ts";
import { OWNER_SPEECHES } from "./config-discord.ts";
import { heavyQueueProblem } from "./config-heavy.ts";
import { compactionTrialProblem, ConfigError, researchTextProblem } from "./config-validation.ts";
import { configPath, expandHome } from "./config-env.ts";

export * from "./config-heavy.ts";
export * from "./config-discord.ts";
export * from "./config-workflow-types.ts";
export * from "./config-types.ts";
export * from "./config-defaults.ts";
export * from "./config-validation.ts";
export * from "./config-env.ts";

type Raw = Record<string, Record<string, unknown> | undefined>;

// Keys this consolidation replaced (the stuck ladder, one reviewer list, the attempt patterns' names). An old key still
// works where it has a new home, moved there unless the new key is set too; one with none is ignored. Each gives one
// CONFIG_OLD_KEY line, so a config can be fixed at leisure.
export const migrateOldKeys = (input: Raw): { readonly raw: Raw; readonly warnings: readonly string[] } => {
  const raw: Raw = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? { ...v } : v]));
  const warnings: string[] = [];
  const section = (name: string): Record<string, unknown> => (raw[name] ??= {});
  const take = (from: string, key: string): unknown => {
    const s = raw[from];
    if (!s || !(key in s)) return undefined;
    const v = s[key];
    delete s[key];
    return v;
  };
  const move = (from: string, key: string, to: string, toKey: string, convert: (v: unknown) => unknown = (v) => v): void => {
    const v = take(from, key);
    if (v === undefined) return;
    const target = section(to);
    const kept = toKey in target;
    if (!kept) target[toKey] = convert(v);
    warnings.push(`CONFIG_OLD_KEY ${from}.${key} -> ${to}.${toKey}${kept ? " (both set: the new key wins)" : ""}; rename it in the config`);
  };
  const drop = (from: string, key: string, why: string): void => {
    if (take(from, key) !== undefined) warnings.push(`CONFIG_OLD_KEY ${from}.${key} is no longer read: ${why}; remove it from the config`);
  };
  const hypothesesAt = Number(raw["stuck"]?.["hypothesesAt"] ?? raw["explore"]?.["hypothesesFrom"] ?? 2);
  const userReviewers = "models" in (input["reviewers"] ?? {});
  move("sameFix", "after", "stuck", "fixatedAfter");
  drop("sameFix", "sendToLane", "the stuck ladder sends a lane research at rung 3 and a re-read only when the lead confirms it (stuck.rereadText)");
  drop("sameFix", "laneText", "stuck.rereadText is the text the lead confirms");
  move("explore", "hypothesesFrom", "stuck", "hypothesesAt");
  // researchAt counted stuck signals (1 = the first attempt that needed hypotheses); stuck.researchAt counts failed attempts
  move("explore", "researchAt", "stuck", "researchAt", (v) => Number(v) + hypothesesAt - 1);
  drop("explore", "driftBelow", "dori intent-check reads the owner's words with a reviewer model instead of counting shared words");
  // 2026-11-02 (owner card Q442): the periodic owner check is gone; its stage ordering with it
  drop("explore", "stagePattern", "the periodic check of lane reports it ordered was removed; lanes run dori intent-check at each stage change");
  drop("handover", "laneRepeats", "a stuck lane is due for a rollover at rung 4 of the stuck ladder");
  drop("discord", "doneText", "a close posts the lane's own summary for the owner (dori claim-done --summary, or one a model writes from its last report and REPORT.md), and a lane with a thread does not close without one");
  // owner 2026-11-04 "이거 뭐야? 시간도 안맞고 말이야 도움도 안돼": freshness posts nothing in the owner's thread on its own
  for (const key of ["quietText", "postRawReports"]) drop("discord", key, "dori freshness posts nothing in the owner's thread on its own; a silent lane's last report goes to the lead, who tells the owner in one plain line if he needs it");
  // owner 2026-10-20 "이건 왜 아직 기계적 구문 생성이 남아있어?": the rollover message is written, not filled in
  for (const key of ["reportText", "frozenText", "sizeText"]) drop("handover", key, "the owner's rollover message is one or two plain sentences the scripts write in discord.locale's language (what moved, why, nothing for him to do); panes and the thaw command are in the watch log");
  drop("handover", "proposalOptions", "dori rollover-propose no longer posts an owner card; the lead decides");
  drop("autoSignals", "repeatAfter", "the inferred count is one input of the stuck ladder (stuck.researchAt)");
  move("signals", "attemptPattern", "signals", "numberedAttemptPattern");
  move("autoSignals", "attemptPattern", "autoSignals", "inferAttemptPattern");
  move("explore", "challengeModels", "reviewers", "models");
  // the periodic owner check was removed on 2026-11-02 (owner card Q442): its shared reviewer settings live in reviewers,
  // what intent-check reads in autoSignals.intentCheck, and its schedule keys are no longer read
  const oc = raw["autoSignals"]?.["ownerCheck"] as Record<string, unknown> | undefined;
  if (oc && typeof oc === "object") {
    delete section("autoSignals")["ownerCheck"];
    const old = "autoSignals.ownerCheck";
    const to = (key: string, target: Record<string, unknown>, where: string): void => {
      if (!(key in oc)) return;
      const kept = key in target;
      if (!kept) target[key] = oc[key];
      warnings.push(`CONFIG_OLD_KEY ${old}.${key} -> ${where}.${key}${kept ? " (both set: the new key wins)" : ""}; rename it in the config`);
    };
    const models = oc["models"];
    if (Array.isArray(models)) {
      // both old lists set: one list holding both (challenge order first); only a reviewers.models the config sets itself wins
      const moved = section("reviewers")["models"];
      if (!userReviewers) section("reviewers")["models"] = [...new Set([...(Array.isArray(moved) ? moved : []), ...models, ...(Array.isArray(moved) ? [] : defaultConfig().reviewers.models)])];
      if (models[0] && !("first" in oc) && !("first" in section("reviewers"))) section("reviewers")["first"] = models[0];
      warnings.push(`CONFIG_OLD_KEY ${old}.models -> reviewers.models (one list) and reviewers.first; rename it in the config`);
    }
    for (const key of ["first", "command", "minutes"]) to(key, section("reviewers"), "reviewers");
    const autoSignals = section("autoSignals");
    autoSignals["intentCheck"] ??= {};
    const intent = autoSignals["intentCheck"] as Record<string, unknown>;
    for (const key of ["reports", "maxReports", "relays"]) to(key, intent, "autoSignals.intentCheck");
    for (const key of ["enabled", "minIntervalMin", "maxPerDay", "perTick"]) if (key in oc) warnings.push(`CONFIG_OLD_KEY ${old}.${key} is no longer read: the periodic check of lane reports was removed; remove it from the config`);
  }
  return { raw, warnings };
};


export const loadConfig = async (path = configPath(), home = homedir(), warn: (line: string) => void = (line) => console.error(line)): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const migrated = migrateOldKeys((await file.exists()) ? ((await file.json()) as Raw) : {});
  for (const w of migrated.warnings) warn(`${w} (${path})`);
  const raw = migrated.raw as Partial<DoriConfig>;
  const merged: DoriConfig = { ...base, ...raw, update: { ...base.update, ...raw.update }, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, discord: { ...base.discord, ...raw.discord }, stuck: { ...base.stuck, ...raw.stuck }, reviewers: { ...base.reviewers, ...raw.reviewers }, mergeGate: { ...base.mergeGate, ...raw.mergeGate }, scorecard: { ...base.scorecard, ...raw.scorecard }, signals: { ...base.signals, ...raw.signals }, explore: { ...base.explore, ...raw.explore }, autoSignals: { ...base.autoSignals, ...raw.autoSignals, intentCheck: { ...base.autoSignals.intentCheck, ...raw.autoSignals?.intentCheck } }, handover: { ...base.handover, ...raw.handover }, supervision: { ...base.supervision, ...raw.supervision }, compactionTrial: { ...base.compactionTrial, ...raw.compactionTrial }, related: { ...base.related, ...raw.related }, stateGit: { ...base.stateGit, ...raw.stateGit, backup: { ...base.stateGit.backup, ...raw.stateGit?.backup } }, heavyQueue: { ...base.heavyQueue, ...raw.heavyQueue }, backlog: { ...base.backlog, ...raw.backlog } };
  if (merged.backlog.pairRepairPattern && merged.backlog.writeNeedsOwnerLink) warn(`CONFIG_BACKLOG_REPAIR_EXEMPT backlog.pairRepairPattern and backlog.writeNeedsOwnerLink are both on: #dori-pair repair requests start without an owner message link, because the owner's standing rule that faults of the Dori base go to the maintenance Dori is their approval (${path})`);
  if (raw.runtime !== undefined && !isRuntimeKind(raw.runtime)) throw new ConfigError(`${path}: runtime must be "herdr" or "hc" (unset: detected), not ${JSON.stringify(raw.runtime)}`);
  const supervisionBad = supervisionProblem((raw as { supervision?: unknown }).supervision);
  if (supervisionBad) throw new ConfigError(`${path}: invalid ${supervisionBad}`);
  const trialBad = compactionTrialProblem((raw as { compactionTrial?: unknown }).compactionTrial);
  if (trialBad) throw new ConfigError(`${path}: invalid ${trialBad}`);
  // dori state-git loop sleeps everyMin: Bun.sleep(NaN) and any Bun.sleep under 1 ms return at once, so it would commit back
  // to back (the --loop check of upstream #131/#134, https://github.com/sisyphuslabs/dori-superagent/pull/134)
  const everyMin: unknown = merged.stateGit.everyMin;
  if (!(typeof everyMin === "number" && Number.isFinite(everyMin) && (everyMin === 0 || everyMin * 60_000 >= 1))) throw new ConfigError(`${path}: stateGit.everyMin must be a number of minutes: 0 turns it off, or 1 ms (0.0000167) or more, not ${JSON.stringify(everyMin)}`);
  const heavyProblem = heavyQueueProblem(merged.heavyQueue);
  if (heavyProblem) throw new ConfigError(`${path}: ${heavyProblem}`);
  // DORI_HEAVY_HOLD_DIR: the suite's own (test/preload.ts), so no test reads a hold this host really has on
  const heavyHoldDir: unknown = process.env["DORI_HEAVY_HOLD_DIR"] ?? merged.heavyHoldDir;
  if (typeof heavyHoldDir !== "string" || !heavyHoldDir.startsWith("/")) throw new ConfigError(`${path}: heavyHoldDir (or DORI_HEAVY_HOLD_DIR) must be an absolute path every account on this host shares, not ${JSON.stringify(heavyHoldDir)}`);
  if (!OWNER_SPEECHES.includes(merged.discord.ownerSpeech)) throw new ConfigError(`${path}: discord.ownerSpeech must be "" (follow discord.locale), "casual" or "polite", not ${JSON.stringify(merged.discord.ownerSpeech)}`);
  if (typeof merged.update.maintainer !== "boolean") throw new ConfigError(`${path}: update.maintainer must be true or false, not ${JSON.stringify(merged.update.maintainer)}`);
  const researchProblem = researchTextProblem(merged.explore.researchText);
  if (researchProblem) throw new ConfigError(`${path}: ${researchProblem}`);
  const env: unknown = merged.launchEnv;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) throw new ConfigError(`${path}: launchEnv must map variable names to strings, e.g. {"CUDA_VISIBLE_DEVICES": ""}`);
  const stateDir = expandHome(process.env["DORI_STATE_DIR"] ?? merged.stateDir, home);
  const leadPane = process.env["DORI_LEAD_PANE"] ?? merged.leadPane;
  const repo = raw.update?.repo ? expandHome(raw.update.repo, home) : (await run(["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"])).out || base.update.repo;
  return {
    ...merged,
    stateDir,
    heavyHoldDir,
    watchLog: expandHome(raw.watchLog ?? join(stateDir, "lanes.log"), home),
    update: { ...merged.update, repo, alertPane: raw.update?.alertPane ?? leadPane, services: merged.update.services.map((s) => ({ ...s, paths: s.paths ?? ["skills/dori-mode/scripts/src/"], log: expandHome(s.log ?? "", home), ready: s.ready ?? "" })) },
    defaultCwd: expandHome(merged.defaultCwd, home),
    directives: { common: expandHome(raw.directives?.common ?? base.directives.common, home), local: expandHome(raw.directives?.local ?? "", home), links: expandHome(raw.directives?.links ?? "", home), linkPeers: raw.directives?.linkPeers ?? [], memory: expandHome(raw.directives?.memory ?? "", home), dailyAudit: raw.directives?.dailyAudit !== false , pickModel: raw.directives?.pickModel ?? base.directives.pickModel},
    sessionsDir: expandHome(merged.sessionsDir, home),
    // only a nonnegative number is a wait: a string or null would end every launch at its first check
    startupWaitSeconds: typeof raw.startupWaitSeconds === "number" && Number.isFinite(raw.startupWaitSeconds) && raw.startupWaitSeconds >= 0 ? raw.startupWaitSeconds : base.startupWaitSeconds,
    scorecard: { ...merged.scorecard, sessions: expandHome(merged.scorecard.sessions || merged.sessionsDir, home), lanesLog: expandHome(merged.scorecard.lanesLog || (raw.watchLog ?? join(stateDir, "lanes.log")), home), leadSessions: expandHome(merged.scorecard.leadSessions, home), inbox: expandHome(merged.scorecard.inbox, home) },
    handover: { ...merged.handover, inbox: expandHome(merged.handover.inbox, home), cwd: expandHome(merged.handover.cwd, home) },
    stateGit: {
      ...merged.stateGit,
      dirs: merged.stateGit.dirs.map((d) => expandHome(d, home)),
      backup: { ...merged.stateGit.backup, ...Object.fromEntries((["dirs", "secretFiles", "messageFiles"] as const).map((k) => [k, merged.stateGit.backup[k].map((d) => expandHome(d, home))])) },
    },
    leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));

// A prompt spawned as one argument stops the spawn with E2BIG before omo starts: Linux takes at most 128 KiB in one
// argument (MAX_ARG_STRLEN), Windows 32,767 UTF-16 units in the whole command line. A plan with the lane area's
// hypothesis tree (133,093 bytes in ~/.dori/src, 2026-11-09) failed every dori challenge reviewer that way. So an omo
// template's "{prompt}" argument longer than PROMPT_ARG_BYTES is given as "-" and the prompt goes to omo's stdin, which
// omo -p reads as the prompt (omo --help: "Wait for stdin to close and prepend it to the prompt"). A shorter prompt, a
// prompt inside a longer argument, and another program's template keep the argument as it is.
export const PROMPT_ARG_BYTES = 30_000;

export const runWithPrompt = (run: Runner, template: ArgvTemplate, values: Readonly<Record<string, string>>, opts: RunOptions = {}): Promise<Ran> => {
  const prompt = values["prompt"] ?? "";
  const at = template.indexOf("{prompt}");
  if (at < 0 || Buffer.byteLength(prompt) <= PROMPT_ARG_BYTES || !isOmoExecutable(template[0] ?? "")) return run(fill(template, values), opts);
  return run(fill(template.with(at, "-"), values), { ...opts, stdin: prompt });
};
