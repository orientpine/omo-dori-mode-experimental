import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./run.ts";

export type UpdateService = {
  readonly unit: string;
  readonly paths: readonly string[];
  readonly log: string;
  readonly ready: string;
};
export type UpdateConfig = {
  readonly repo: string;
  readonly services: readonly UpdateService[];
  readonly readyTimeoutSec: number;
  readonly alertPane: string;
  readonly announce: string;
};

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type Backend = "herdr" | "aoe";

// "words" marks status as [working] / [waiting] / [done]; "emoji" uses 🔄 / ⏸️ / ✅ (and ⏳ / ✅ in progress text).
export type StatusStyle = "words" | "emoji";

// Words the Discord helpers write: thread status words, question-card labels, and how answer times are shown.
// autoUnEye: the listener takes its eyes reaction off the owner's earlier messages once its bot writes in that channel.
// quietText ({min} = minutes since the lane's last report) and doneText are what freshness and the automatic close post in
// the owner's thread (hooks.threadReply / threadDone, any messenger), instead of the lane's own report or claim, which are
// notes for the lead. postRawReports brings back posting those notes as they are. laneStartText is the first message
// dori launch posts in a discord:<id> work thread that has none ({title}, {goal}, {brief}, {done}, {key}, {pane}; a line
// whose placeholder is empty is left out).
export type DiscordWords = {
  readonly statusStyle: StatusStyle;
  readonly autoUnEye: boolean;
  readonly quietText: string;
  readonly laneStartText: string;
  readonly doneText: string;
  readonly postRawReports: boolean;
  readonly working: string;
  readonly waiting: string;
  readonly done: string;
  readonly other: string;
  readonly pick: string;
  readonly recommended: string;
  readonly answered: string;
  readonly ownerOnly: string;
  readonly byButton: string;
  readonly byText: string;
  readonly locale: string;
  readonly timeZone: string;
};

export const defaultDiscordWords: DiscordWords = {
  statusStyle: "words",
  autoUnEye: true,
  quietText: "Still working on it. The last report came {min} min ago; I'll sum it up for you soon.",
  laneStartText: "{title}\nGoal, in your words: {goal}\n{brief}\nDone when: {done}\nLane {key}, pane {pane}",
  doneText: "Done: the checks passed and the work is closed. I'll sum up what changed for you soon.",
  postRawReports: false,
  working: "working",
  waiting: "waiting",
  done: "done",
  other: "Write my own",
  pick: "Pick {n}",
  recommended: "recommended",
  answered: "answered",
  ownerOnly: "Only the owner can answer this.",
  byButton: "button",
  byText: "typed",
  locale: "en-US",
  timeZone: "UTC",
};

// SAME_FIX_3: from the `after`-th fix attempt on one metric with one hypothesis the lead is told; the lane gets laneText
// ({n}, {metric}, {hypothesis} filled in) only when sendToLane is true.
export type SameFix = { readonly after: number; readonly sendToLane: boolean; readonly laneText: string };

// dori scorecard: where the day's numbers come from and how the card reads. Empty paths leave that line as n/a.
export type Scorecard = {
  readonly timeZone: string;
  readonly language: "en" | "ko";
  // session files whose cost line ① counts; empty means sessionsDir (every session on the host)
  readonly sessions: string;
  readonly lanesLog: string;
  readonly leadSessions: string;
  readonly inbox: string;
  readonly replyPattern: string;
  readonly leadSendPattern: string;
  readonly postTo: string;
  // days of <stateDir>/scorecard/YYYY-MM-DD.json kept; older files are removed when a new one is written
  readonly keepDays: number;
};

// dori signals: the failure record of earlier lanes. launchLanes caps how many lanes the "Past signals" section of a new
// brief lists. A report or lead message matching attemptPattern (group 1 = the attempt number) is a numbered fix attempt;
// one matching rootCausePattern after the first attempt is the switch to a root-cause hunt.
export type Signals = { readonly launchLanes: number; readonly attemptPattern: string; readonly rootCausePattern: string };

// Exploration when a lane is stuck (dori fix-attempt, tree, challenge, fork-explore, research-hint, intent-check).
// hypothesesFrom: from this attempt on one metric with no improvement, fix-attempt needs minHypotheses competing hypotheses,
// each with a cheap discriminating test. researchAt: the stuck signal (1 = the first attempt that needed hypotheses) that
// adds an external-search step; researchText goes to the lane when sendResearchToLane is on ({n}, {metric}, {key}).
// stagePattern: a milestone report matching it announces a new stage, and the lead is told to run dori intent-check.
// driftBelow: intent-check flags drift when the direction shares less than this share of the goal's word pairs.
// challengeModels: reviewers for dori challenge in order, by default the best GPT, then Claude, then Grok model, then a
// second model of each family; the first of another family than the lane's model that writes a review wins (--all: one
// review per family). Before a call each id is checked against modelsCommand (the host's models) and authCommand
// ({provider}: is it logged in); an id the host cannot call is skipped or moved to a logged-in provider of the same model.
// challengeCommand / branchCommand: argv templates ({model}, {prompt}, and {system}, the reviewer's system prompt, for
// challengeCommand); branchMinutes: time limit per fork-explore branch.
export type Explore = {
  readonly hypothesesFrom: number;
  readonly minHypotheses: number;
  readonly researchAt: number;
  readonly sendResearchToLane: boolean;
  readonly researchText: string;
  readonly stagePattern: string;
  readonly driftBelow: number;
  readonly treeLines: number;
  readonly challengeModels: readonly string[];
  readonly modelsCommand: ArgvTemplate;
  readonly authCommand: ArgvTemplate;
  readonly challengeCommand: ArgvTemplate;
  readonly challengeMinutes: number;
  readonly branchCommand: ArgvTemplate;
  readonly branchMinutes: number;
};

export type DoriConfig = {
  readonly backend: Backend;
  readonly stateDir: string;
  readonly watchLog: string;
  readonly update: UpdateConfig;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  readonly discord: DiscordWords;
  readonly sameFix: SameFix;
  readonly scorecard: Scorecard;
  readonly signals: Signals;
  readonly explore: Explore;
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  backend: "herdr",
  stateDir: join(home, ".dori", "state"),
  watchLog: join(home, ".dori", "state", "lanes.log"),
  update: { repo: resolve(import.meta.dir, "../../../.."), services: [], readyTimeoutSec: 60, alertPane: "", announce: "Tell the owner in your own channel, briefly, what changed and how your behaviour changes because of it." },
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  discord: defaultDiscordWords,
  sameFix: {
    after: 3,
    sendToLane: false,
    laneText: "[LEAD] This is fix attempt {n} on {metric} with the same hypothesis ({hypothesis}). Stop patching: reproduce the failure and read the logs for the root cause first, then report what you found.",
  },
  scorecard: {
    timeZone: "UTC",
    language: "en",
    sessions: "",
    lanesLog: "",
    leadSessions: "",
    inbox: "",
    replyPattern: "^(SENT|POSTED) \\d",
    leadSendPattern: "send-keys\\W+-t\\W+={pane}:\\W+-l|send-text\\W+{pane}\\b",
    postTo: "",
    keepDays: 30,
  },
  signals: {
    launchLanes: 5,
    attemptPattern: "(?:fix(?: attempt)?|attempt|adjustment|조정|땜질)\\s*#?(\\d{1,2})(?:\\s*/\\s*\\d+)?(?![\\d.a-z])",
    rootCausePattern: "root[ -]cause|근본 원인",
  },
  explore: {
    hypothesesFrom: 2,
    minHypotheses: 3,
    researchAt: 2,
    sendResearchToLane: true,
    researchText: "[LEAD] Stuck signal {n} on {metric}. Before the next patch, spend 10-15 minutes on an external search for this exact symptom: papers, GitHub issues, repos that hit it. dori research-hint {key} prints a search plan. Record each useful finding with dori tree add --lane {key} --kind finding --text '<source>: <what it says>', then report what it changes about your next step.",
    stagePattern: "\\b(?:stage|phase|pivot|switch(?:ing)? to|next step)\\b|단계|국면|방향 전환|다음 단계",
    driftBelow: 0.12,
    treeLines: 6,
    challengeModels: ["chatgpt-subscription/gpt-6-astra", "anthropic-subscription/claude-fable-5-1", "xai/grok-4.7", "chatgpt-subscription/gpt-6.1-sol", "anthropic-subscription/claude-opus-5-5", "xai/grok-4.6"],
    modelsCommand: ["omo", "--list-models"],
    authCommand: ["omo", "auth", "check", "--provider", "{provider}", "--json"],
    challengeCommand: ["omo", "-p", "--no-session", "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-context-files", "--omo-senpi-disabled", "--system-prompt", "{system}", "--model", "{model}", "{prompt}"],
    challengeMinutes: 10,
    branchCommand: ["omo", "-p", "--no-session", "--model", "{model}", "{prompt}"],
    branchMinutes: 15,
  },
});

export const envFilePath = (): string => process.env.DORI_ENV_FILE ?? join(homedir(), ".dori", "dori.env");

// KEY=VALUE lines (tokens, Discord ids) for every dori command; a variable already set wins over the file.
export const loadEnvFile = async (path: string, env: Record<string, string | undefined> = process.env): Promise<void> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  for (const line of (await file.text()).split("\n")) {
    const [, name, value] = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line) ?? [];
    if (name && value !== undefined && env[name] === undefined) env[name] = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
};

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  const merged: DoriConfig = { ...base, ...raw, update: { ...base.update, ...raw.update }, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, discord: { ...base.discord, ...raw.discord }, sameFix: { ...base.sameFix, ...raw.sameFix }, scorecard: { ...base.scorecard, ...raw.scorecard }, signals: { ...base.signals, ...raw.signals }, explore: { ...base.explore, ...raw.explore } };
  const stateDir = expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home);
  const leadPane = process.env.DORI_LEAD_PANE ?? merged.leadPane;
  const repo = raw.update?.repo ? expandHome(raw.update.repo, home) : (await run(["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"])).out || base.update.repo;
  return {
    ...merged,
    stateDir,
    watchLog: expandHome(raw.watchLog ?? join(stateDir, "lanes.log"), home),
    update: { ...merged.update, repo, alertPane: raw.update?.alertPane ?? leadPane, services: merged.update.services.map((s) => ({ ...s, paths: s.paths ?? ["skills/dori-mode/scripts/src/"], log: expandHome(s.log ?? "", home), ready: s.ready ?? "" })) },
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    scorecard: { ...merged.scorecard, sessions: expandHome(merged.scorecard.sessions || merged.sessionsDir, home), lanesLog: expandHome(merged.scorecard.lanesLog, home), leadSessions: expandHome(merged.scorecard.leadSessions, home), inbox: expandHome(merged.scorecard.inbox, home) },
    leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
