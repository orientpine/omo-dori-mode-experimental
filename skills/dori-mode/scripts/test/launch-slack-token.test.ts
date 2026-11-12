import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";
import { CORE, flowRig } from "./hc-flow-rig.ts";

// Synthetic values only: no real token is ever a fixture here.
const LAUNCHER_TOKEN = "xoxb-FIXTURE-launcher";
const FILE_TOKEN = "xoxb-FIXTURE-file";
let dir: string;
const ENV = ["PATH", "DORI_RUNTIME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "HC_SESSION", "HC_FLOW_ROOT", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"] as const;
let saved: (string | undefined)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "launch-slack-token-"));
  saved = ENV.map((k) => process.env[k]);
  process.env["PATH"] = `${dir}:${process.env["PATH"]}`;
  process.env["DORI_RUNTIME"] = "hc";
  process.env["DORI_CONFIG"] = join(dir, "second", "config.json");
  process.env["DORI_ENV_FILE"] = join(dir, "second", "dori.env");
  process.env["DORI_SLACK_TOKEN"] = LAUNCHER_TOKEN;
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  delete process.env["DORI_STATE_DIR"];
  process.env["HC_FLOW_ROOT"] = dir;
  mkdirSync(join(dir, "second"));
  writeFileSync(join(dir, "second", "dori.env"), `HC_SESSION=${CORE}\n`);
});
afterEach(() => {
  ENV.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  rmSync(dir, { recursive: true, force: true });
});

const tokenFile = (path: string): string => {
  writeFileSync(path, `${FILE_TOKEN}\n`);
  chmodSync(path, 0o600);
  return path;
};

// The hc lane's agent line (typed into its terminal) and every hc argv the launch ran.
const launchOnHc = async (key: string, rig = flowRig(dir)): Promise<{ line: string; argv: string[] }> => {
  const base = depsFor(newWorld(), fakeClock(Date.parse("2026-11-09T00:00:00Z")), join(dir, "second", "state"), { runtime: "hc", backend: "herdr", leadPane: "hc:t1" });
  const deps: FlowDeps = { ...base, run: rig.run, readGoal: async () => ({ status: "active" }) };
  const brief = join(dir, `${key}.md`);
  writeFileSync(brief, "# brief\n");
  await launchLane(deps, { noThread: "test lane", model: "test/model", key, title: key, brief, done: "file /tmp/ok", cwd: dir });
  const core = rig.read();
  return { line: core.sent.find((s) => s.id !== "t1" && s.text.includes("omo"))?.text ?? "", argv: [...core.calls.flat(), ...core.sent.map((s) => s.text)] };
};

test.skipIf(process.platform === "win32")("an hc lane gets the slack-token file next to its config by path and an empty DORI_SLACK_TOKEN, never a token value (#201)", async () => {
  // Given: a launcher holding a token in its env, and this home's owner-only slack-token next to its config
  const file = tokenFile(join(dir, "second", "slack-token"));
  // When: the lane is launched on hc, whose launch line is a command line that ps and hc show
  const { line, argv } = await launchOnHc("token-lane");
  // Then: the line names the file and blanks DORI_SLACK_TOKEN, and no hc argv or typed text holds either token
  expect(line).toContain(`DORI_SLACK_TOKEN_FILE=${file}`);
  expect(line).toMatch(/(^| )DORI_SLACK_TOKEN=('')?( |$)/);
  expect(argv.filter((a) => a.includes("FIXTURE"))).toEqual([]);
  // and #197's home selectors are still there
  expect(line).toContain(`DORI_CONFIG=${join(dir, "second", "config.json")}`);
});

test.skipIf(process.platform === "win32")("the launcher's own DORI_SLACK_TOKEN_FILE wins over the file next to the config, as an absolute path", async () => {
  tokenFile(join(dir, "second", "slack-token"));
  // inside this home: one outside it is refused (upstream #219, token stack)
  const own = tokenFile(join(dir, "second", "own-token"));
  process.env["DORI_SLACK_TOKEN_FILE"] = own;
  const { line, argv } = await launchOnHc("own-lane");
  expect(line).toContain(`DORI_SLACK_TOKEN_FILE=${own}`);
  expect(argv.filter((a) => a.includes("FIXTURE"))).toEqual([]);
});

// From upstream https://github.com/sisyphuslabs/dori-superagent/pull/219 (token stack squash 49fba4dc): a launch with a
// token file outside this home is refused before any session is created.
test.skipIf(process.platform === "win32")("a launch with a token file outside this home is refused before any session is created", async () => {
  process.env["DORI_SLACK_TOKEN_FILE"] = tokenFile(join(dir, "other-token"));
  const rig = flowRig(dir);
  await expect(launchOnHc("outside-lane", rig)).rejects.toThrow(/^token file refused: DORI_SLACK_TOKEN_FILE .* is outside this home/);
  expect(rig.read().calls.some((c) => c.includes("run") || c.includes("new"))).toBe(false);
});

// From upstream #219 test/slack-token-home.test.ts, with real links: 'near/link/../config.json' opens far's config, so far
// is the token home for launcher and lane alike, whether that config exists yet or not.
test.skipIf(process.platform === "win32")("with a real link, 'link/../config.json' makes far the token home, and the lane gets that DORI_CONFIG as text", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  const near = join(dir, "near");
  const far = join(dir, "far");
  mkdirSync(join(far, "a"), { recursive: true });
  mkdirSync(near);
  const farToken = tokenFile(join(far, "slack-token"));
  tokenFile(join(near, "slack-token"));
  symlinkSync(join(far, "a"), join(near, "link"));
  const raw = `${relative(process.cwd(), near)}${sep}link${sep}..${sep}config.json`;
  process.env["DORI_CONFIG"] = raw;
  const missing = (await launchOnHc("nolink-lane")).line;
  writeFileSync(join(far, "config.json"), "{}");
  const existing = (await launchOnHc("link-lane")).line;
  for (const line of [missing, existing]) {
    expect(line).toContain(`DORI_SLACK_TOKEN_FILE=${realpathSync(farToken)}`);
    expect(line).toContain(`DORI_CONFIG=${process.cwd()}${sep}${raw}`);
  }
});

test.skipIf(process.platform === "win32")("with no token file the lane gets neither variable, as in a single-home setup", async () => {
  const { line, argv } = await launchOnHc("plain-lane");
  expect(line).toContain("omo");
  expect(line).not.toContain("DORI_SLACK_TOKEN");
  expect(argv.filter((a) => a.includes("FIXTURE"))).toEqual([]);
});
