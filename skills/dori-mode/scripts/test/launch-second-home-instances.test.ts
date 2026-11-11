import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { Registry } from "../src/registry.ts";
import { depsFor, fakeClock, launchReadyPath, newWorld, withState, type World } from "./fakes.ts";

// Real dori CLI children can exceed Bun's 5 s default on a loaded host.
setDefaultTimeout(30_000);

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const CLI = join(import.meta.dir, "../src/cli.ts");
const REPO = resolve(import.meta.dir, "../../../..");
const SECOND = "222222222222222222";
const HOST = "111111111111111111";
const botToken = (bot: string): string => `${Buffer.from(bot).toString("base64").replace(/=+$/, "")}.fake.token`;

let state: ReturnType<typeof withState>;
let world: World;
let restorePath: () => void;
let savedConfig: string | undefined;
let savedState: string | undefined;
let savedEnvFile: string | undefined;
let savedCwd: string;

beforeEach(() => {
  savedCwd = process.cwd();
  savedConfig = process.env["DORI_CONFIG"];
  savedState = process.env["DORI_STATE_DIR"];
  savedEnvFile = process.env["DORI_ENV_FILE"];
  restorePath = launchReadyPath();
  state = withState();
  world = newWorld();
});

afterEach(() => {
  for (const [name, value] of [["DORI_CONFIG", savedConfig], ["DORI_STATE_DIR", savedState], ["DORI_ENV_FILE", savedEnvFile]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  state.done();
  restorePath();
  process.chdir(savedCwd);
});

const secondAndHost = () => {
  const secondState = join(state.dir, "second", "state");
  const secondConfig = join(state.dir, "second", "config.json");
  const secondEnvFile = join(state.dir, "second", "dori.env");
  const hostHome = join(state.dir, "host");
  const hostState = join(hostHome, ".dori", "state");
  mkdirSync(join(hostHome, ".dori"), { recursive: true });
  mkdirSync(join(state.dir, "second"), { recursive: true });
  writeFileSync(secondConfig, JSON.stringify({ stateDir: secondState, update: { repo: REPO }, discord: { botId: SECOND } }));
  writeFileSync(join(hostHome, ".dori", "config.json"), JSON.stringify({ stateDir: hostState, update: { repo: REPO }, discord: { botId: HOST } }));
  writeFileSync(secondEnvFile, `DORI_DISCORD_TOKEN=${botToken(SECOND)}\nDORI_DISCORD_CHANNEL=second-channel\nDORI_DISCORD_PAIR_BOT=${HOST}\n`);
  writeFileSync(join(hostHome, ".dori", "dori.env"), `DORI_DISCORD_TOKEN=${botToken(HOST)}\nDORI_DISCORD_CHANNEL=host-channel\nDORI_DISCORD_PAIR_BOT=${SECOND}\n`);
  process.chdir(state.dir);
  process.env["DORI_CONFIG"] = relative(process.cwd(), secondConfig);
  process.env["DORI_ENV_FILE"] = relative(process.cwd(), secondEnvFile);
  delete process.env["DORI_STATE_DIR"];
  return { secondState, secondConfig, secondEnvFile, hostHome, hostState };
};

const laneChildEnv = (hostHome: string, launchedEnv: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !["DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "HOME"].includes(name)) env[name] = value;
  }
  env["HOME"] = hostHome;
  for (const [name, value] of Object.entries(launchedEnv)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
};

const runLaneCommand = async (argv: readonly string[], env: Record<string, string>, cwd: string) => {
  const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

const expectCheckpointOnlyInSecond = (paths: { readonly secondState: string; readonly hostState: string }, scenario: { readonly key: string; readonly step: string }, result: { readonly stdout: string; readonly stderr: string; readonly code: number }): void => {
  const second = join(paths.secondState, "lane-state", scenario.key, "checkpoints.jsonl");
  const host = join(paths.hostState, "lane-state", scenario.key, "checkpoints.jsonl");
  expect({ code: result.code, stdout: result.stdout, stderr: result.stderr, second: existsSync(second), host: existsSync(host) }).toEqual({
    code: 0,
    stdout: expect.any(String),
    stderr: "",
    second: true,
    host: false,
  });
  expect(readFileSync(second, "utf8")).toContain(`"step":"${scenario.step}"`);
};

test.skipIf(process.platform === "win32")("second dori home: herdr --use-gpu makes relative selectors absolute and keeps the instance env file (#435)", async () => {
  const paths = secondAndHost();
  const laneCwd = join(state.dir, "lane-cwd-herdr");
  mkdirSync(laneCwd);
  world.ps = "4000 1 bash\n4001 4000 omo --model m";
  const key = "second-home-herdr-relative";
  const brief = join(state.dir, "herdr-relative-brief.md");
  await Bun.write(brief, "# brief\n");
  const base = depsFor(world, fakeClock(T0), relative(process.cwd(), paths.secondState), {
    agentCommand: [process.execPath, CLI, "checkpoint", key, "--step", "herdr-relative", "--result", "ok", "--evidence", "test"],
    launchEnv: { CUDA_VISIBLE_DEVICES: "" },
  });
  let command = "";
  const deps: FlowDeps = {
    ...base,
    readGoal: async () => ({ status: "active" }),
    run: async (argv, opts) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w9:p9" }, tab_id: "w9:t9" } }), err: "" };
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") command = argv[4] ?? "";
      return base.run(argv, opts);
    },
  };
  const launched = await launchLane(deps, { noThread: "test lane", model: "test/model", key, title: key, brief, done: "file /tmp/ok", cwd: laneCwd, useGpu: true });
  expect(launched.startup).toStartWith("STARTUP_OK");
  await new Registry(paths.hostState).write(launched.lane);

  const checkpoint = await runLaneCommand(["bash", "-c", command], laneChildEnv(paths.hostHome, {}), laneCwd);

  expectCheckpointOnlyInSecond(paths, { key, step: "herdr-relative" }, checkpoint);
  expect(command).toContain("-u CUDA_VISIBLE_DEVICES");
  expect(command).toContain(`DORI_CONFIG=${paths.secondConfig}`);
  expect(command).toContain(`DORI_STATE_DIR=${paths.secondState}`);
  expect(command).toContain(`DORI_ENV_FILE=${paths.secondEnvFile}`);
});
