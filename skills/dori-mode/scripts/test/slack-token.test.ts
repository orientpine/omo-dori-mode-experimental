import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootCheck, envSlackCheck } from "../src/boot.ts";
import { loadEnvFile } from "../src/config.ts";
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

const HOST = process.platform;

test("a nonempty DORI_SLACK_TOKEN is read first, then the trimmed token file when the variable is unset or empty", () => {
  const file = tokenFile("t", "  xoxb-FIXTURE-file\n", 0o600);
  expect(slackToken({ DORI_SLACK_TOKEN: "xoxb-FIXTURE-env", DORI_SLACK_TOKEN_FILE: file }, HOST)).toBe("xoxb-FIXTURE-env");
  expect(slackToken({ DORI_SLACK_TOKEN: "", DORI_SLACK_TOKEN_FILE: file }, HOST)).toBe("xoxb-FIXTURE-file");
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, HOST)).toBe("xoxb-FIXTURE-file");
  expect(slackToken({ DORI_SLACK_TOKEN: "" }, HOST)).toBeUndefined();
  expect(slackToken({}, HOST)).toBeUndefined();
});

test.skipIf(process.platform === "win32")("a token file open to group or others is refused with chmod 600 on POSIX; Windows has no mode bits to check", () => {
  const file = tokenFile("open", "xoxb-FIXTURE-open\n", 0o644);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toThrow(`DORI_SLACK_TOKEN_FILE ${file} is open to group or others (mode 644); chmod 600 it`);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: tokenFile("group", "x", 0o640) }, "darwin")).toThrow(TokenFileError);
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "win32")).toBe("xoxb-FIXTURE-open");
});

test("a missing or empty token file is refused by path, never read as no token and never showing a value", () => {
  const absent = join(dir, "absent");
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: absent }, HOST)).toThrow(`DORI_SLACK_TOKEN_FILE ${absent} cannot be read`);
  const empty = tokenFile("empty", " \n", 0o600);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: empty }, HOST)).toThrow(`DORI_SLACK_TOKEN_FILE ${empty} is empty`);
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
  expect(() => slackToken(env, HOST)).toThrow(`DORI_SLACK_TOKEN_FILE ${absent} cannot be read`);
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

test("a lane launched through another home's wrapper without a dori.env does not carry the first home's token file over (#201 review 3)", async () => {
  // Given: home A's lane env with A's token file, then home B's wrapper selectors, with no dori.env in home B
  tokenFile("slack-token", "xoxb-FIXTURE-a\n", 0o600);
  const env: Record<string, string | undefined> = { ...laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: join(dir, "config.json") }) };
  Object.assign(env, { DORI_CONFIG: join(dir, "home-b", "config.json"), DORI_ENV_FILE: join(dir, "home-b", "dori.env") });
  // When: the CLI starts in home B and launches a lane there
  await loadEnvFile(join(dir, "home-b", "dori.env"), env);
  const lane = laneHomeEnv({ stateDir: join(dir, "home-b", "state"), backend: "herdr" }, env);
  // Then: neither the run nor its lane names home A's token file
  expect([env["DORI_SLACK_TOKEN_FILE"], lane["DORI_SLACK_TOKEN_FILE"], lane["DORI_SLACK_TOKEN_HOME"]]).toEqual([undefined, undefined, undefined]);
});

test("another home's env is still isolated when a differing Slack token or another home's token marker shows it, so that home's inbox never wins (#201 review 6)", async () => {
  // Given: home B's dori.env with its Slack token and inbox; one env inheriting home A's Slack token and inbox, and one
  // that is home A's file-backed lane env (blanked token, marker A) calling home B's wrapper with A's inbox
  mkdirSync(join(dir, "home-b"));
  const envB = join(dir, "home-b", "dori.env");
  writeFileSync(envB, "DORI_SLACK_TOKEN=xoxb-FIXTURE-b\nDORI_DISCORD_INBOX=/b/inbox.jsonl\n");
  const configB = join(dir, "home-b", "config.json");
  tokenFile("slack-token", "xoxb-FIXTURE-a\n", 0o600);
  const byToken: Record<string, string | undefined> = { DORI_CONFIG: configB, DORI_SLACK_TOKEN: "xoxb-FIXTURE-a", DORI_DISCORD_INBOX: "/a/inbox.jsonl" };
  const byMarker: Record<string, string | undefined> = { ...laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: join(dir, "config.json") }), DORI_CONFIG: configB, DORI_DISCORD_INBOX: "/a/inbox.jsonl" };
  // When: each loads home B's dori.env
  await loadEnvFile(envB, byToken);
  await loadEnvFile(envB, byMarker);
  // Then: both read home B's inbox and token, and nothing of home A's token file is left
  expect([byToken, byMarker].map((e) => [e["DORI_DISCORD_INBOX"], slackToken(e, HOST), e["DORI_SLACK_TOKEN_FILE"]])).toEqual([
    ["/b/inbox.jsonl", "xoxb-FIXTURE-b", undefined],
    ["/b/inbox.jsonl", "xoxb-FIXTURE-b", undefined],
  ]);
});

test("a fresh file-backed lane of home B (its own marker, blanked token) on a server holding home A's inbox reads B's inbox: no instance setting is inherited (#201 review 7)", async () => {
  // Given: home B's dori.env with its inbox, and B's lane env as launch leaves it on a server whose env has A's inbox
  writeFileSync(join(dir, "dori.env"), "DORI_DISCORD_INBOX=/b/inbox.jsonl\n");
  tokenFile("slack-token", "xoxb-FIXTURE-b\n", 0o600);
  const env: Record<string, string | undefined> = { DORI_DISCORD_INBOX: "/a/inbox.jsonl", DORI_DISCORD_CHANNEL: "a-channel", ...laneHomeEnv({ stateDir: join(dir, "state"), backend: "herdr" }, { DORI_CONFIG: join(dir, "config.json") }) };
  // When: the lane loads its home's dori.env
  await loadEnvFile(join(dir, "dori.env"), env);
  // Then: B's inbox, no inherited channel (B's dori.env has none), and B's token file with its blanked token
  expect([env["DORI_DISCORD_INBOX"], env["DORI_DISCORD_CHANNEL"], slackToken(env, HOST)]).toEqual(["/b/inbox.jsonl", undefined, "xoxb-FIXTURE-b"]);
});
