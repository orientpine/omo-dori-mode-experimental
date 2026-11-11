import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { laneHomeEnv } from "../src/home-env.ts";
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

// A lane's dori send slack as launch leaves it (production laneHomeEnv for home A: its dori.env, the token file's path,
// DORI_SLACK_TOKEN blanked), optionally through another home's wrapper, which sets only that home's three selectors.
const laneSend = async (doriEnv: string, inherited: readonly string[], wrapper?: { readonly doriEnv: string; readonly text?: string }) => {
  const envFile = join(state.dir, "dori.env");
  // the fake Slack API is in dori.env too, so an isolation that drops inherited Slack variables cannot reach slack.com
  const api = `DORI_SLACK_API=http://127.0.0.1:${server.port}/api\n`;
  writeFileSync(envFile, `${doriEnv}${api}`);
  const file = join(state.dir, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE-file\n");
  chmodSync(file, 0o600);
  const lane = laneHomeEnv({ stateDir: state.dir, backend: "herdr" }, { DORI_CONFIG: join(state.dir, "config.json"), DORI_ENV_FILE: envFile });
  const home = { ...lane };
  if (wrapper) {
    const other = join(state.dir, "home-b");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "dori.env"), `${wrapper.doriEnv}${api}`);
    Object.assign(home, { DORI_CONFIG: join(other, "config.json"), DORI_ENV_FILE: join(other, "dori.env"), DORI_STATE_DIR: join(other, "state") });
  }
  return await run(["env", ...Object.entries(home).map(([k, v]) => `${k}=${v}`), `DORI_SLACK_API=http://127.0.0.1:${server.port}/api`, ...inherited,
    process.execPath, CLI, "send", "slack", "--to", "C1", "--text", wrapper?.text ?? "hello"], { timeoutMs: 20_000 });
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

test.skipIf(process.platform === "win32")("another home's wrapper called from a lane drops the lane's token file, so that home posts with its own token (#201 review 2)", async () => {
  // Given: a home-A lane with A's token file, calling home B's wrapper, once with B's Discord bot (foreign) and once with the same one
  const foreign = await laneSend("DORI_DISCORD_TOKEN=a-discord\n", ["DORI_DISCORD_TOKEN=a-discord"], { doriEnv: "DORI_DISCORD_TOKEN=b-discord\nDORI_SLACK_TOKEN=xoxb-FIXTURE-homeb\n" });
  const same = await laneSend("", [], { doriEnv: "DORI_SLACK_TOKEN=xoxb-FIXTURE-homeb\n", text: "hello again" });
  // Then: both post with home B's token, never with home A's file
  expect({ foreign: foreign.code, same: same.code, seen }).toEqual({ foreign: 0, same: 0, seen: ["Bearer xoxb-FIXTURE-homeb", "Bearer xoxb-FIXTURE-homeb"] });
});
