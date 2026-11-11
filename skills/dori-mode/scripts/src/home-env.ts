import { resolve } from "node:path";
import { configPath, envFilePath, type DoriConfig } from "./config.ts";
import { laneTokenEnv } from "./slack-token.ts";

// The launching instance's selectors (#197), absolute so a lane cwd cannot redirect them, and this home's Slack token as
// its file's path when it has one (#201), so a lane, launched or revived, posts as this home's bot without the token on a
// command line.
export const homeEnv = (config: Pick<DoriConfig, "stateDir">, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => {
  const configFile = resolve(env["DORI_CONFIG"] ?? configPath());
  return {
    DORI_CONFIG: configFile,
    DORI_STATE_DIR: resolve(config.stateDir),
    DORI_ENV_FILE: resolve(env["DORI_ENV_FILE"] ?? envFilePath()),
    ...laneTokenEnv(env, configFile),
  };
};

// herdr and hc only: an aoe session's env goes through the global tmux update-environment, where a home selector would
// reach every session on that server, so aoe stays as it was (its migration is in docs/follow-ups.md).
export const laneHomeEnv = (config: Pick<DoriConfig, "stateDir" | "backend">, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => (config.backend === "aoe" ? {} : homeEnv(config, env));
