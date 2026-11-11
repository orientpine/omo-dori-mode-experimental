import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let seen: string[];
let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  state = withState();
  seen = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(req.headers.get("authorization") ?? "");
      return Response.json({ ok: true, channel: "C1", ts: "1.2", message: { text: "hello" } });
    },
  });
});
afterEach(() => {
  server.stop(true);
  state.done();
});

// A lane's dori send slack as launch leaves it: this home's dori.env, the token file's path, and DORI_SLACK_TOKEN blanked.
const laneSend = async (doriEnv: string, inherited: readonly string[]) => {
  const envFile = join(state.dir, "dori.env");
  // the fake Slack API is in dori.env too, so an isolation that drops inherited Slack variables cannot reach slack.com
  writeFileSync(envFile, `${doriEnv}DORI_SLACK_API=http://127.0.0.1:${server.port}/api\n`);
  const file = join(state.dir, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE-file\n");
  chmodSync(file, 0o600);
  return await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${envFile}`, `DORI_SLACK_API=http://127.0.0.1:${server.port}/api`, `DORI_SLACK_TOKEN_FILE=${file}`, "DORI_SLACK_TOKEN=", ...inherited,
    process.execPath, CLI, "send", "slack", "--to", "C1", "--text", "hello"], { timeoutMs: 20_000 });
};

test.skipIf(process.platform === "win32")("the token file a lane was given survives dori.env isolation when another messenger's token differs (#201 review 1)", async () => {
  // Given: an inherited Discord token of another home, so dori.env's own Discord token marks the env foreign
  const r = await laneSend("DORI_DISCORD_TOKEN=this-home-discord\n", ["DORI_DISCORD_TOKEN=other-home-discord"]);
  // Then: the foreign Discord token is dropped, the lane's token file and blanked token are kept, and the post goes out with the file's token
  expect({ code: r.code, seen }).toEqual({ code: 0, seen: ["Bearer xoxb-FIXTURE-file"] });
  expect(r.err).toBe(`DORI_ENV_FOREIGN dropped 2 inherited variables of another Dori (its bot token differs from ${join(state.dir, "dori.env")}): DORI_SLACK_API DORI_DISCORD_TOKEN`);
});

test.skipIf(process.platform === "win32")("a Slack token in dori.env does not override the launcher's token file and its deliberately empty DORI_SLACK_TOKEN", async () => {
  const r = await laneSend("DORI_SLACK_TOKEN=xoxb-FIXTURE-envfile\n", ["DORI_DISCORD_INBOX=/tmp/inherited-inbox"]);
  expect({ code: r.code, err: r.err, seen }).toEqual({ code: 0, err: "", seen: ["Bearer xoxb-FIXTURE-file"] });
});
