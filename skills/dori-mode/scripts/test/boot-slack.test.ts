import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck, envSlackCheck, slackAuthCheck } from "../src/boot.ts";
import { WIN32_ACL_NOTICE } from "../src/slack-token.ts";
import { Slack } from "../src/messenger/slack.ts";
import { bootDeps, newWorld, T0 } from "./boot-fixtures.ts";
import { fakeClock, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());
const depsFor = (world: World, slack?: () => Promise<{ userId: string; teamId: string } | null>) => bootDeps(world, state.dir, slack);

test("Slack is optional, and a failed check never prints the provider error", async () => {
  const world = newWorld();
  const skipped = await bootCheck(depsFor(world));
  const failed = await bootCheck(depsFor(world, async () => { throw new Error("FIXTURE_TOKEN"); }));
  expect(skipped.lines).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(skipped.exitCode).toBe(0);
  expect(failed.lines).toContain("SLACK auth failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.lines.join("\n")).not.toContain("FIXTURE_TOKEN");
});

test("the Slack step reads auth.test through the client and fails when it returns no user or team id", async () => {
  const slackWith = (body: Record<string, unknown>) => {
    const calls: string[] = [];
    const http = async (req: { url: string }) => {
      calls.push(req.url);
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    };
    return { slack: new Slack(http, fakeClock(T0), { token: "xoxp-FIXTURE" }, "https://slack.test/api"), calls };
  };
  const ok = slackWith({ ok: true, user_id: "U_FIXTURE", team_id: "T_FIXTURE" });
  const partial = slackWith({ ok: true, user_id: "U_FIXTURE" });
  const world = newWorld();
  const good = await bootCheck({ ...depsFor(world), slack: slackAuthCheck(ok.slack) });
  const bad = await bootCheck({ ...depsFor(world), slack: slackAuthCheck(partial.slack) });
  expect(ok.calls).toEqual(["https://slack.test/api/auth.test"]);
  expect(good.lines).toContain("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(bad.lines).toContain("SLACK auth failed");
  expect(bad.exitCode).toBe(1);
  expect(await slackAuthCheck(null)()).toBeNull();
});

test("Slack runs after the local checks and a stalled auth.test ends at the deadline", async () => {
  const world = newWorld();
  let localCallsFirst = -1;
  const stalled = async () => {
    localCallsFirst = world.calls.length;
    return await new Promise<never>(() => {});
  };
  const result = await bootCheck({ ...depsFor(world, stalled), slackDeadlineMs: 20 });
  expect(localCallsFirst).toBe(1);
  expect(result.lines).toContain("SLACK auth.test timed out after 20 ms");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("the Slack deadline cancels a retry wait and its request signal", async () => {
  const calls: { url: string; signal?: AbortSignal }[] = [];
  const http = async (req: { url: string; signal?: AbortSignal }) => {
    calls.push(req);
    return { status: 429, headers: { "retry-after": "60" }, body: JSON.stringify({ ok: false, error: "ratelimited" }) };
  };
  const slack = new Slack(http, fakeClock(T0), { token: "xoxp-FIXTURE" }, "https://slack.test/api");
  const result = await bootCheck({ ...depsFor(newWorld()), slack: slackAuthCheck(slack), slackDeadlineMs: 20 });
  expect(result.lines).toContain("SLACK auth.test timed out after 20 ms");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.signal?.aborted).toBe(true);
});

// From upstream https://github.com/sisyphuslabs/dori-superagent/pull/219 (token stack squash 49fba4dc), boot-slack.test.ts.
test("on Windows boot reads the token file and says its ACL is not checked", async () => {
  const file = join(state.dir, "win-token");
  writeFileSync(file, "xoxb-FIXTURE_SECRET\n");
  const client = () => ({ call: async () => ({ ok: true, user_id: "U1", team_id: "T1" }) });
  const r = await bootCheck({ ...depsFor(newWorld()), slack: envSlackCheck(client, { DORI_SLACK_TOKEN_FILE: file }, "win32", join(state.dir, "config.json")) });
  expect(r.lines.some((l) => l.startsWith("SLACK authenticated user=U1 team=T1"))).toBe(true);
  expect(r.lines).toContain(`SLACK token-file: ${WIN32_ACL_NOTICE}`);
  expect(r.lines.join("\n")).not.toContain("FIXTURE_SECRET");
});

test.skipIf(process.platform === "win32")("boot refuses a token file outside this home, as launch does, before reading it", async () => {
  const other = join(state.dir, "other-home");
  mkdirSync(other, { recursive: true });
  const file = join(other, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE_SECRET\n");
  chmodSync(file, 0o600);
  const client = () => {
    throw new Error("no Slack client is made for a refused token file");
  };
  const r = await bootCheck({ ...depsFor(newWorld()), slack: envSlackCheck(client, { DORI_SLACK_TOKEN_FILE: file }, "linux", join(state.dir, "home", "config.json")) });
  expect(r.lines.some((l) => l.startsWith(`SLACK token-file: DORI_SLACK_TOKEN_FILE ${realpathSync(file)} is outside this home`))).toBe(true);
  expect(r.exitCode).toBe(1);
  expect(r.lines.join("\n")).not.toContain("FIXTURE_SECRET");
});
