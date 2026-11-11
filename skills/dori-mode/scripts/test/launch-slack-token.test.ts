import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const launchOnHc = async (key: string): Promise<{ line: string; argv: string[] }> => {
  const rig = flowRig(dir);
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
  const own = tokenFile(join(dir, "own-token"));
  process.env["DORI_SLACK_TOKEN_FILE"] = own;
  const { line, argv } = await launchOnHc("own-lane");
  expect(line).toContain(`DORI_SLACK_TOKEN_FILE=${own}`);
  expect(argv.filter((a) => a.includes("FIXTURE"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("with no token file the lane gets neither variable, as in a single-home setup", async () => {
  const { line, argv } = await launchOnHc("plain-lane");
  expect(line).toContain("omo");
  expect(line).not.toContain("DORI_SLACK_TOKEN");
  expect(argv.filter((a) => a.includes("FIXTURE"))).toEqual([]);
});
