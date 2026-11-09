import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tokenBotId } from "./messenger/discord.ts";
import type { InstanceRef } from "./config-types.ts";

export const envFilePath = (): string => process.env["DORI_ENV_FILE"] ?? join(homedir(), ".dori", "dori.env");

// What one Dori's dori.env sets: bot tokens, channel, inbox, card store, lead, voice, Google, Kakao, usage. A process can
// inherit another Dori's set: a tmux server started by a unit that loaded dori.env hands it to every pane it opens.
// DORI_LEAD_PANE and DORI_DISCORD_SHADOW_INBOX choose how this run works (set by its unit or caller), not instance values.
const instanceVar = (name: string): boolean => /^DORI_(DISCORD|SLACK|TELEGRAM|LEAD|ASR|GOOGLE|KAKAO|USAGE)_/.test(name) && name !== "DORI_LEAD_PANE" && name !== "DORI_DISCORD_SHADOW_INBOX";

// The bot a token signs in as: a Discord token's base64 user id before its first dot, a Telegram token's id before its
// colon, else the token itself. A rotated token of the same bot is the same bot.
const tokenIdentity = (name: string, token: string): string => {
  const t = token.trim();
  if (name === "DORI_DISCORD_TOKEN") return tokenBotId(t) ?? t;
  return name === "DORI_TELEGRAM_TOKEN" && /^\d+:/.test(t) ? t.split(":")[0] ?? t : t;
};

// KEY=VALUE lines (tokens, Discord ids) for every dori command; a variable already set wins over the file, except when
// the file names another bot than the inherited token. Then the environment is another Dori's: every inherited
// instance variable is dropped first, so this file and the defaults apply. Returns the dropped names.
export const loadEnvFile = async (path: string, env: Record<string, string | undefined> = process.env): Promise<string[]> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const values = envFileEntries(await file.text());
  const foreign = [...values].some(([name, value]) => {
    const inherited = env[name];
    return /^DORI_\w+_TOKEN$/.test(name) && value !== "" && inherited !== undefined && tokenIdentity(name, inherited) !== tokenIdentity(name, value);
  });
  const dropped = foreign ? Object.keys(env).filter((name) => instanceVar(name) && env[name] !== undefined) : [];
  for (const name of dropped) delete env[name];
  for (const [name, value] of values) if (env[name] === undefined) env[name] = value;
  return dropped;
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
