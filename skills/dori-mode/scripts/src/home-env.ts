import { resolve } from "node:path";
import { configPath, envFilePath, type DoriConfig } from "./config.ts";
import { laneTokenEnv } from "./slack-token.ts";

// The launching instance's selectors (#197), absolute so a lane cwd cannot redirect them.
export const homeEnv = (config: Pick<DoriConfig, "stateDir">, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => ({
  DORI_CONFIG: resolve(env["DORI_CONFIG"] ?? configPath()),
  DORI_STATE_DIR: resolve(config.stateDir),
  DORI_ENV_FILE: resolve(env["DORI_ENV_FILE"] ?? envFilePath()),
});

// herdr and hc only: an aoe session's env goes through the global tmux update-environment, where a home selector would
// reach every session on that server, so aoe stays as it was (its migration is in docs/follow-ups.md). This home's Slack
// token goes as its file's path when it has one (#201), so the lane posts as this home's bot without the token on a command line.
export const laneHomeEnv = (config: Pick<DoriConfig, "stateDir" | "backend">, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => {
  if (config.backend === "aoe") return {};
  const home = homeEnv(config, env);
  return { ...home, ...laneTokenEnv(env, home["DORI_CONFIG"] ?? configPath()) };
};
