import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingTokens, slackWatchOptions, writeEnvValues } from "../../setups/discord-aoe/slack-watch.ts";

const WATCH = join(import.meta.dir, "../../setups/discord-aoe/slack-watch.ts");
import { loadEnvFile } from "../src/config.ts";
import { homeEnv } from "../src/home-env.ts";

const APP = ["xapp", "FIXTURE"].join("-");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-watch-token-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The env a handed-over or revived lead runs the watcher in: production homeEnv (token file, blanked token), then dori.env.
const leadEnv = async (mode: number): Promise<Record<string, string | undefined>> => {
  const file = join(dir, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE-file\n");
  chmodSync(file, mode);
  writeFileSync(join(dir, "dori.env"), `DORI_SLACK_APP_TOKEN=${APP}\nDORI_SLACK_TOKEN=xoxb-FIXTURE-envfile\n`);
  const env: Record<string, string | undefined> = { ...homeEnv({ stateDir: dir }, { DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: join(dir, "dori.env") }) };
  await loadEnvFile(join(dir, "dori.env"), env);
  return env;
};

test.skipIf(process.platform === "win32")("the Slack watcher reads the bot token from the lead's token file, not the blanked variable (#201 review 3)", async () => {
  // Given: a lead env from production homeEnv with this home's owner-only token file
  const options = slackWatchOptions(await leadEnv(0o600), dir);
  // Then: the watcher has the file's bot token and nothing is missing
  expect({ bot: options.botToken, why: missingTokens(options) }).toEqual({ bot: "xoxb-FIXTURE-file", why: "" });
});

test.skipIf(process.platform === "win32")("a token file open to others keeps the watcher off with the file's reason, naming the path, never the value", async () => {
  const why = missingTokens(slackWatchOptions(await leadEnv(0o644), dir));
  expect(why).toBe(`DORI_SLACK_TOKEN_FILE ${join(dir, "slack-token")} is open to group or others (mode 644); chmod 600 it`);
  expect(why).not.toContain("FIXTURE");
});

test.skipIf(process.platform === "win32")("--wait started by a lead with a token file signs in with the file's bot token once the app token appears (#201 challenge)", async () => {
  // Given: a fake Slack that records the bearer of auth.test, and a lead env from production homeEnv with an owner-only token file
  const bearer = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname.endsWith("auth.test")) bearer.resolve(req.headers.get("authorization") ?? "");
      return Response.json({ ok: false, error: "fixture_stop" });
    },
  });
  const file = join(dir, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE-file\n");
  chmodSync(file, 0o600);
  const envFile = join(dir, "dori.env");
  // the fake API sits in dori.env, so no reload can reach slack.com
  writeFileSync(envFile, `DORI_SLACK_API=http://127.0.0.1:${server.port}/api\n`);
  const env: Record<string, string | undefined> = { ...process.env, ...homeEnv({ stateDir: dir }, { DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: envFile }), DORI_SLACK_WAIT_MS: "100" };
  for (const k of ["DORI_SLACK_APP_TOKEN", "DORI_SLACK_API"]) delete env[k];
  const proc = Bun.spawn(["bun", WATCH, "--wait"], { env, stdout: "pipe", stderr: "pipe" });
  const waiting = Promise.withResolvers<void>();
  let out = "";
  void (async () => {
    for await (const chunk of proc.stdout) {
      out += new TextDecoder().decode(chunk);
      if (out.includes("SLACK_WATCH_WAIT")) waiting.resolve();
    }
  })();
  const deadline = (ms: number, what: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} not seen in ${ms} ms; output: ${out}`)), ms));
  try {
    await Promise.race([waiting.promise, deadline(10_000, "SLACK_WATCH_WAIT")]);
    // When: the app token is written to dori.env while the watcher waits
    writeEnvValues(envFile, { DORI_SLACK_APP_TOKEN: APP });
    // Then: the reload signs in with the token file's bot token, and no token value is printed
    expect(await Promise.race([bearer.promise, deadline(10_000, "auth.test")])).toBe("Bearer xoxb-FIXTURE-file");
    expect(out).not.toContain("FIXTURE");
  } finally {
    proc.kill();
    await proc.exited;
    server.stop(true);
  }
}, 30_000);
