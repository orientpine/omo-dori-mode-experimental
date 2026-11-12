import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { homeEnv } from "../src/home-env.ts";
import { laneTokenEnv, OUTSIDE_HOME_FLAG, RESOLVED_HOME, RESOLVED_MARK, TokenFileError } from "../src/slack-token.ts";
import { withState } from "./fakes.ts";

// From upstream https://github.com/sisyphuslabs/dori-superagent/pull/219 (the #204 -> #208 -> #211 -> #213 -> #218 token
// stack, squash 49fba4dc), test/slack-token.test.ts: the token env a lane gets and the home it is checked against. The
// launch-level cases are in launch-slack-token.test.ts (the fork's hc rig); the fork's homeEnv carries upstream's
// laneLaunchEnv (DORI_CONFIG for the lane).
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

// The lane gets the real path (links resolved, e.g. macOS /var -> /private/var); every path here is under state.dir.
const real = (p: string): string => join(realpathSync(state.dir), relative(state.dir, p));

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

test("the home's own slack-token is passed even when missing, so the lane never falls back to the core's token", () => {
  const home = join(state.dir, "named-home");
  mkdirSync(home, { recursive: true });
  const absent = join(home, "slack-token");
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: absent }, join(home, "config.json"))).toMatchObject({ DORI_SLACK_TOKEN_FILE: real(absent), DORI_SLACK_TOKEN: "" });
});

test("any other named token file that does not exist yet is refused: a link later put there is what the lane would follow", () => {
  const home = join(state.dir, "absent-home");
  mkdirSync(home, { recursive: true });
  const other = join(home, "named", "slack-token");
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, join(home, "config.json"))).toThrow(/does not exist/);
});

test("an inherited DORI_SLACK_TOKEN_FILE outside this home is refused unless the flag says it is meant", () => {
  const home = join(state.dir, "own-home");
  const config = join(home, "config.json");
  tokenFile(home, "xoxb-FIXTURE-own\n", 0o600);
  const other = tokenFile(join(state.dir, "other-home"), "xoxb-FIXTURE-other\n", 0o600);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(TokenFileError);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(/is outside this home/);
  // Allowed by the flag, and the flag is passed empty so the lane does not carry the permission onward.
  const ok = (file: string) => ({ DORI_SLACK_TOKEN_FILE: real(file), [RESOLVED_MARK]: real(file), [RESOLVED_HOME]: real(home), DORI_SLACK_TOKEN: "", [OUTSIDE_HOME_FLAG]: "" });
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other, [OUTSIDE_HOME_FLAG]: "1" }, config)).toEqual(ok(other));
  // Unset, the home's own file is used; a file inside the home is passed as named.
  expect(laneTokenEnv({}, config)).toEqual(ok(join(home, "slack-token")));
  const nested = tokenFile(join(home, "keys"), "xoxb-FIXTURE-nested\n", 0o600);
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: nested }, config)).toEqual(ok(nested));
  // A file whose name starts with ".." is still inside the home.
  const dotted = join(home, "..slack-token");
  writeFileSync(dotted, "xoxb-FIXTURE-dotted\n");
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: dotted }, config)).toEqual(ok(dotted));
  // A link inside the home to another home's file is outside: links are resolved before the check.
  const link = join(home, "linked-token");
  symlinkSync(other, link);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: link }, config)).toThrow(/is outside this home/);
});

test("the home's own slack-token gets the same link check, and an inherited allow flag never reaches a lane", () => {
  const other = tokenFile(join(state.dir, "far-home"), "xoxb-FIXTURE-far\n", 0o600);
  const linked = join(state.dir, "linked-home");
  mkdirSync(linked, { recursive: true });
  symlinkSync(other, join(linked, "slack-token"));
  expect(() => laneTokenEnv({}, join(linked, "config.json"))).toThrow(/links outside this home/);
  // With no token file at all, nothing is added except emptying an inherited allow flag.
  const bare = join(state.dir, "bare-home", "config.json");
  expect(laneTokenEnv({}, bare)).toEqual({});
  expect(laneTokenEnv({ [OUTSIDE_HOME_FLAG]: "1" }, bare)).toEqual({ [OUTSIDE_HOME_FLAG]: "" });
  // The lane gets the resolved path: a link inside the home that is later swapped to another home's file is not used.
  const homeL = join(state.dir, "relink-home");
  const target = tokenFile(join(homeL, "keys"), "xoxb-FIXTURE-own\n", 0o600);
  symlinkSync(target, join(homeL, "slack-token"));
  expect(laneTokenEnv({}, join(homeL, "config.json"))["DORI_SLACK_TOKEN_FILE"]).toBe(realpathSync(target));
  const named = laneTokenEnv({ DORI_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
  expect(named["DORI_SLACK_TOKEN_FILE"]).toBe(realpathSync(target));
  // The path is resolved once: the string checked is the string passed, so no swap between two resolutions reaches the lane.
  const spy = spyOn(fs.realpathSync, "native");
  try {
    laneTokenEnv({ DORI_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
    expect(spy.mock.calls.filter(([p]) => String(p).endsWith("relink-home/slack-token")).length).toBe(1);
  } finally {
    spy.mockRestore();
  }
  // A named link whose target does not exist yet is refused: the lane would follow it wherever it later points.
  const dangling = join(homeL, "dl");
  symlinkSync(join(state.dir, "not-yet", "slack-token"), dangling);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: dangling }, join(homeL, "config.json"))).toThrow(/is a link whose target does not exist/);
});

const laneConfig = (raw: string): string | undefined => homeEnv({ stateDir: join(state.dir, "state") }, { DORI_CONFIG: raw })["DORI_CONFIG"];

test("a relative DORI_CONFIG reaches the lane with the cwd put in front as text, '..' kept for the OS to resolve", () => {
  const home = join(state.dir, "dotdot-home");
  mkdirSync(join(home, "sub"), { recursive: true });
  const plain = relative(process.cwd(), join(home, "config.json"));
  expect(laneConfig(plain)).toBe(`${process.cwd()}${sep}${plain}`);
  const dotted = `${relative(process.cwd(), join(home, "sub"))}${sep}..${sep}config.json`;
  expect(laneConfig(dotted)).toBe(`${process.cwd()}${sep}${dotted}`);
});

test("an absolute DORI_CONFIG reaches the lane unchanged, so a link in it resolves for the lane as it did for the launcher", () => {
  const raw = `${join(state.dir, "abs-home")}/sub/../config.json`;
  expect(laneConfig(raw)).toBe(raw);
});

test("a DORI_CONFIG whose home moves when normalized (empty, '.', '..') is refused instead of moving the home up", () => {
  for (const raw of ["", ".", ".."]) expect(() => laneConfig(raw)).toThrow(/does not name a config file/);
});
