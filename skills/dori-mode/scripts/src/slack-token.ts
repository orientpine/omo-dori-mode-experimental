// From upstream https://github.com/sisyphuslabs/dori-superagent/pull/201 (#200): the Slack token without putting it on a
// command line. A lane's env is its agent line (`env K=V ... omo`), which ps, hc and herdr show, so a lane gets the path
// of an owner-only token file instead of the token itself.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// the token file a launcher finds next to its config when DORI_SLACK_TOKEN_FILE is not set
export const TOKEN_FILE_NAME = "slack-token";

export class TokenFileError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

// DORI_SLACK_TOKEN when set and not empty, else the trimmed contents of the file DORI_SLACK_TOKEN_FILE names, else
// undefined. The file must be owner-only (no group or other bits), checked on POSIX only: on Windows the mode bits do not
// reflect the NTFS ACL (stat reports 0666 or 0444 for every file), so there the ACL is the owner's to set. An error names
// the path, never the contents.
export const slackToken = (env: Env = process.env, platform: string = process.platform): string | undefined => {
  const token = env["DORI_SLACK_TOKEN"];
  if (token) return token;
  const path = env["DORI_SLACK_TOKEN_FILE"];
  if (!path) return undefined;
  let mode: number;
  let value: string;
  try {
    mode = statSync(path).mode;
    if (platform !== "win32" && (mode & 0o077) !== 0) throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} is open to group or others (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
    value = readFileSync(path, "utf8").trim();
  } catch (e) {
    throw e instanceof TokenFileError ? e : new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} cannot be read`);
  }
  if (!value) throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} is empty`);
  return value;
};

// The env a lane needs to find this home's token: the token file's absolute path, never the token. The file is the
// launcher's DORI_SLACK_TOKEN_FILE, else `slack-token` next to its config; with no such file nothing is added, as before.
// DORI_SLACK_TOKEN is passed empty: a lane's pane inherits its server's or core's env, which may hold another home's
// token, and a set DORI_SLACK_TOKEN is read before the file.
export const laneTokenEnv = (env: Env, configFile: string): Record<string, string> => {
  const file = resolve(env["DORI_SLACK_TOKEN_FILE"] || join(dirname(configFile), TOKEN_FILE_NAME));
  return existsSync(file) ? { DORI_SLACK_TOKEN_FILE: file, DORI_SLACK_TOKEN: "" } : {};
};
