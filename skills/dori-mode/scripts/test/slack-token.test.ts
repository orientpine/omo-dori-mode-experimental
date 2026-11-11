import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootCheck, envSlackCheck } from "../src/boot.ts";
import { laneHomeEnv } from "../src/home-env.ts";
import { slackToken, TokenFileError } from "../src/slack-token.ts";
import { bootDeps, newWorld } from "./boot-fixtures.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-token-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tokenFile = (name: string, text: string, mode: number): string => {
  const file = join(dir, name);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

test("a nonempty DORI_SLACK_TOKEN is read first, then the trimmed token file when the variable is unset or empty", () => {
  const file = tokenFile("t", "  xoxb-FIXTURE-file\n", 0o600);
  expect(slackToken({ DORI_SLACK_TOKEN: "xoxb-FIXTURE-env", DORI_SLACK_TOKEN_FILE: file }, "linux")).toBe("xoxb-FIXTURE-env");
  expect(slackToken({ DORI_SLACK_TOKEN: "", DORI_SLACK_TOKEN_FILE: file }, "linux")).toBe("xoxb-FIXTURE-file");
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toBe("xoxb-FIXTURE-file");
  expect(slackToken({ DORI_SLACK_TOKEN: "" }, "linux")).toBeUndefined();
  expect(slackToken({}, "linux")).toBeUndefined();
});

test.skipIf(process.platform === "win32")("a token file open to group or others is refused with chmod 600 on POSIX; Windows has no mode bits to check", () => {
  const file = tokenFile("open", "xoxb-FIXTURE-open\n", 0o644);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toThrow(`DORI_SLACK_TOKEN_FILE ${file} is open to group or others (mode 644); chmod 600 it`);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: tokenFile("group", "x", 0o640) }, "darwin")).toThrow(TokenFileError);
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "win32")).toBe("xoxb-FIXTURE-open");
});

test("a missing or empty token file is refused by path, never read as no token and never showing a value", () => {
  const absent = join(dir, "absent");
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: absent }, "linux")).toThrow(`DORI_SLACK_TOKEN_FILE ${absent} cannot be read`);
  const empty = tokenFile("empty", " \n", 0o600);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: empty }, "linux")).toThrow(`DORI_SLACK_TOKEN_FILE ${empty} is empty`);
});

test("a lane home env adds the token file path and an empty token only when the file exists, and aoe gets nothing", () => {
  const config = join(dir, "config.json");
  const none = laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: config, DORI_SLACK_TOKEN: "xoxb-FIXTURE-env" });
  expect(Object.keys(none).filter((k) => k.startsWith("DORI_SLACK"))).toEqual([]);
  const file = tokenFile("slack-token", "xoxb-FIXTURE-file\n", 0o600);
  const withFile = laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: config, DORI_SLACK_TOKEN: "xoxb-FIXTURE-env" });
  expect(withFile).toMatchObject({ DORI_SLACK_TOKEN_FILE: file, DORI_SLACK_TOKEN: "", DORI_CONFIG: config });
  expect(JSON.stringify(withFile)).not.toContain("FIXTURE");
  expect(laneHomeEnv({ stateDir: join(dir, "state"), backend: "aoe" }, { DORI_CONFIG: config })).toEqual({});
});

test("an explicit DORI_SLACK_TOKEN_FILE goes to the lane with the token blanked even when the file is missing, so the lane reports it (#201 review 1)", () => {
  const absent = join(dir, "absent-token");
  const env = laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: join(dir, "config.json"), DORI_SLACK_TOKEN_FILE: absent, DORI_SLACK_TOKEN: "xoxb-FIXTURE-env" });
  expect(env).toMatchObject({ DORI_SLACK_TOKEN_FILE: absent, DORI_SLACK_TOKEN: "" });
  expect(() => slackToken(env, "linux")).toThrow(`DORI_SLACK_TOKEN_FILE ${absent} cannot be read`);
});

test.skipIf(process.platform === "win32")("boot prints a bad token file as a failed SLACK token-file line, still runs its other checks, and shows no token", async () => {
  // Given: a token file open to group and others, and a path with no file
  const open = tokenFile("wide", "xoxb-FIXTURE-secret\n", 0o644);
  const mode = (statSync(open).mode & 0o777).toString(8);
  const absent = join(dir, "absent");
  const client = () => {
    throw new Error("no Slack client is made for a bad token file");
  };
  // When: boot runs with each
  const wide = await bootCheck({ ...bootDeps(newWorld(), dir), slack: envSlackCheck(client, { DORI_SLACK_TOKEN_FILE: open }, "linux") });
  const missing = await bootCheck({ ...bootDeps(newWorld(), dir), slack: envSlackCheck(client, { DORI_SLACK_TOKEN_FILE: absent }, "linux") });
  // Then: each names the file, the local checks ran, boot is incomplete, and the value never shows
  expect(wide.lines).toContain(`SLACK token-file: DORI_SLACK_TOKEN_FILE ${open} is open to group or others (mode ${mode}); chmod 600 it`);
  expect(missing.lines).toContain(`SLACK token-file: DORI_SLACK_TOKEN_FILE ${absent} cannot be read`);
  for (const r of [wide, missing]) {
    expect(r.lines.some((l) => l.startsWith("RUNTIME "))).toBe(true);
    expect(r.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).not.toContain("FIXTURE");
  }
});
