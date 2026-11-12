import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InstanceRef } from "./config-types.ts";
import { homeOf, RESOLVED_HOME, RESOLVED_MARK } from "./slack-token.ts";

export const envFilePath = (): string => process.env["DORI_ENV_FILE"] ?? join(homedir(), ".dori", "dori.env");

// What one Dori's dori.env sets: bot tokens, channel, inbox, card store, lead, voice, Google, Kakao, usage. A process can
// inherit another Dori's set: a tmux server started by a unit that loaded dori.env hands it to every pane it opens, and a
// lane's pane inherits its herdr server's or hc core's env. DORI_LEAD_PANE, DORI_DISCORD_SHADOW_INBOX and
// DORI_SLACK_WAIT_MS choose how this run works (set by its unit or caller), not instance values.
const instanceVar = (name: string): boolean => /^DORI_(DISCORD|SLACK|TELEGRAM|LEAD|ASR|GOOGLE|KAKAO|USAGE)_/.test(name) && !["DORI_LEAD_PANE", "DORI_DISCORD_SHADOW_INBOX", "DORI_SLACK_WAIT_MS"].includes(name);

// KEY=VALUE lines (tokens, Discord ids) for every dori command. Instance values never come from the inherited environment,
// only from this home's dori.env (absent there means unset, and defaults then derive from this home's stateDir): with the
// Slack token passed to a lane as a file, no differing token shows that an inherited set is another home's (#201 reviews
// 5-7), so every inherited instance variable is dropped first. Kept: a token file the caller set, unless dori launch chose
// it for another home (DORI_SLACK_TOKEN_HOME is not this run's config, as when a lane of one home calls another home's
// wrapper, review 2), with the blanked DORI_SLACK_TOKEN and the marker launch passes with a file of this home, so
// dori.env's token does not replace it. Other variables (selectors, run knobs) still win over the file. The marker is the
// token home as upstream #219 resolves it (homeOf: the directory of the config the OS opens), never the config path on
// paper, where `link/../config.json` of one home reads as another's; a home that cannot be resolved matches no marker.
export const loadEnvFile = async (path: string, env: Record<string, string | undefined> = process.env): Promise<void> => {
  const marked = env[RESOLVED_HOME];
  const config = env["DORI_CONFIG"] ?? configPath();
  // a lane launched before upstream #219's port carries the old marker, this config's path (review 1 of #474): its file,
  // blanked token and that marker are kept, so every later load keeps them too (review 2), but never a resolved-path mark,
  // so the reader home-checks the file under the new rule
  const legacy = marked !== undefined && marked === resolve(config);
  const home = marked === undefined || legacy ? undefined : tokenHome(config);
  const file = marked === undefined || legacy || marked === home ? env["DORI_SLACK_TOKEN_FILE"] : undefined;
  const ours = file !== undefined && marked !== undefined && !legacy && marked === home;
  const keep = new Set([...(file ? ["DORI_SLACK_TOKEN_FILE"] : []), ...(ours ? [RESOLVED_HOME, RESOLVED_MARK] : []), ...(file && legacy ? [RESOLVED_HOME] : []), ...(file && (ours || legacy) && env["DORI_SLACK_TOKEN"] === "" ? ["DORI_SLACK_TOKEN"] : [])]);
  for (const name of Object.keys(env)) if (instanceVar(name) && !keep.has(name)) delete env[name];
  const envFile = Bun.file(path);
  if (!(await envFile.exists())) return;
  for (const [name, value] of envFileEntries(await envFile.text())) if (env[name] === undefined) env[name] = value;
};

// A dori.env's KEY=VALUE lines: the first value of each name, its quotes taken off.
export const envFileEntries = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [, name, value] = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line) ?? [];
    if (name && value !== undefined && !values.has(name)) values.set(name, value.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return values;
};

const tokenHome = (configFile: string): string | undefined => {
  try {
    return homeOf(configFile);
  } catch {
    return undefined;
  }
};

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// A dori command run without DORI_CONFIG and DORI_ENV_FILE inside another Dori's directory (the defaultCwd of a config
// listed under `instances` in ~/.dori/config.json, reached through a symlink or not) takes that Dori's config and
// dori.env. Returns the config path it chose.
export const resolveInstance = async (cwd: string, env: Record<string, string | undefined> = process.env, home = homedir()): Promise<string | undefined> => {
  if (env["DORI_CONFIG"] !== undefined || env["DORI_ENV_FILE"] !== undefined) return undefined;
  const main = Bun.file(join(home, ".dori", "config.json"));
  if (!(await main.exists())) return undefined;
  const here = realOr(cwd);
  for (const ref of ((await main.json()) as { instances?: InstanceRef[] }).instances ?? []) {
    const config = expandHome(ref.config, home);
    const file = Bun.file(config);
    const dir = (await file.exists()) ? ((await file.json()) as { defaultCwd?: string }).defaultCwd : undefined;
    if (!dir) continue;
    const root = realOr(expandHome(dir, home));
    if (here !== root && !here.startsWith(`${root}/`)) continue;
    env["DORI_CONFIG"] = config;
    env["DORI_ENV_FILE"] = expandHome(ref.envFile ?? join(dirname(config), "dori.env"), home);
    return config;
  }
  return undefined;
};

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
