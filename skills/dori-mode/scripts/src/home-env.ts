import { dirname, isAbsolute, resolve, sep } from "node:path";
import { configPath, envFilePath, type DoriConfig } from "./config.ts";
import { laneTokenEnv, TokenFileError } from "./slack-token.ts";

// The launching instance's selectors (#197), absolute so a lane cwd cannot redirect them, and this home's Slack token as
// its file's path when it has one (#201), so a lane, launched or revived, posts as this home's bot without the token on a
// command line.
// DORI_CONFIG as upstream #219's laneLaunchEnv gives it (https://github.com/sisyphuslabs/dori-superagent/pull/219, #218
// review LOWs): an absolute one unchanged and a relative one with the launcher's cwd put in front as text, never resolve()
// or path.join, which collapse `..` on paper, so the OS resolves links and `..` for the lane exactly as it did for the
// launcher and both find the same token home. One whose home moves when normalized (empty, `.`, `..`) names no config
// file and is refused rather than letting the home check move up a directory.
export const homeEnv = (config: Pick<DoriConfig, "stateDir">, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => {
  const raw = env["DORI_CONFIG"] ?? configPath();
  if (dirname(resolve(raw)) !== resolve(dirname(raw))) throw new TokenFileError(`DORI_CONFIG "${raw}" does not name a config file; set it to the config file's path`);
  const configFile = isAbsolute(raw) ? raw : `${process.cwd()}${sep}${raw}`;
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
