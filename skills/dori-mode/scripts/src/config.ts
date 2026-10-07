import { homedir } from "node:os";
import { join } from "node:path";

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

// "words" marks status as [working] / [waiting] / [done]; "emoji" uses 🔄 / ⏸ / ✅ (and ⏳ / ✅ in progress text).
export type StatusStyle = "words" | "emoji";

// Words the Discord helpers write: thread status words, question-card labels, and how answer times are shown.
export type DiscordWords = {
  readonly statusStyle: StatusStyle;
  readonly working: string;
  readonly waiting: string;
  readonly done: string;
  readonly other: string;
  readonly answered: string;
  readonly ownerOnly: string;
  readonly byButton: string;
  readonly byText: string;
  readonly locale: string;
  readonly timeZone: string;
};

export const defaultDiscordWords: DiscordWords = {
  statusStyle: "words",
  working: "working",
  waiting: "waiting",
  done: "done",
  other: "Write my own",
  answered: "answered",
  ownerOnly: "Only the owner can answer this.",
  byButton: "button",
  byText: "typed",
  locale: "en-US",
  timeZone: "UTC",
};

export type DoriConfig = {
  readonly backend: Backend;
  readonly stateDir: string;
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
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  backend: "herdr",
  stateDir: join(home, ".dori", "state"),
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
  const merged: DoriConfig = { ...base, ...raw, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, discord: { ...base.discord, ...raw.discord } };
  return {
    ...merged,
    stateDir: expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env.DORI_LEAD_PANE ?? merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
