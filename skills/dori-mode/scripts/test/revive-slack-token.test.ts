import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { herdrShellPid } from "../src/herdr.ts";
import { recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import type { Runner } from "../src/run.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, launchReadyPath, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const SESSION = "11111111-2222-4333-8444-555555555555";
const KEYS = ["DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"] as const;
let state: ReturnType<typeof withState>;
let world: World;
let restorePath: () => void;
let saved: (string | undefined)[];
beforeEach(() => {
  saved = KEYS.map((k) => process.env[k]);
  restorePath = launchReadyPath();
  state = withState();
  world = newWorld();
});
afterEach(() => {
  KEYS.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  state.done();
  restorePath();
});

test.skipIf(process.platform === "win32")("a herdr lane launched with this home's slack-token keeps the file path and the blanked token when revived (#201 review 1)", async () => {
  // Given: a second home with an owner-only slack-token next to its config, and a launcher holding another token
  const home = join(state.dir, "second");
  mkdirSync(home, { recursive: true });
  const file = join(home, "slack-token");
  writeFileSync(file, "xoxb-FIXTURE-file\n");
  chmodSync(file, 0o600);
  process.env["DORI_CONFIG"] = join(home, "config.json");
  process.env["DORI_ENV_FILE"] = join(home, "dori.env");
  process.env["DORI_SLACK_TOKEN"] = "xoxb-FIXTURE-launcher";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  delete process.env["DORI_STATE_DIR"];
  world.ps = "4000 1 bash\n4001 4000 omo --model m";
  const stateDir = join(home, "state");
  const base = depsFor(world, fakeClock(T0), stateDir, { backend: "herdr" });
  let launchLine = "";
  const deps: FlowDeps = {
    ...base,
    readGoal: async () => ({ status: "active" }),
    run: async (argv, opts) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w9:p9" }, tab_id: "w9:t9" } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") launchLine = argv[4] ?? "";
      return base.run(argv, opts);
    },
  };
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");

  // When: the lane is launched, its agent dies, and the lead revives it in the same pane
  await launchLane(deps, { noThread: "test lane", model: "test/model", key: "revive-token", title: "revive-token", brief, done: "file /tmp/ok", cwd: state.dir });
  recordHerdrSession(stateDir, "w9:p9", { session: SESSION, cwd: state.dir, model: "m/x", at: new Date(0).toISOString() });
  world.herdrDead = ["w9:p9"];
  world.ps = newWorld().ps;
  world.panes = [{ pane_id: "w9:p9", workspace_id: "w9", cwd: state.dir }];
  world.calls.length = 0;
  const revived = await reviveHerdr(base.run, base.clock, base.config, "w9:p9", "", async () => true);
  const reviveLine = world.calls.find((c) => c[0] === "herdr" && c[2] === "run")?.[4] ?? "";

  // Then: both agent lines name the file and blank DORI_SLACK_TOKEN, and neither holds a token value
  expect(revived).toStartWith("REVIVE_OK w9:p9");
  for (const line of [launchLine, reviveLine]) {
    expect(line).toContain(`DORI_SLACK_TOKEN_FILE=${file}`);
    expect(line).toMatch(/ DORI_SLACK_TOKEN=('')? /);
    expect(line).not.toContain("FIXTURE");
  }
});

test("a revive that blanks DORI_SLACK_TOKEN is refused on pwsh before 7.5, which would drop the empty value, as a fresh launch is (#201 review 2)", async () => {
  // Given: a stopped herdr agent whose pane shell is pwsh 7.4, and a launcher with an explicit token file
  process.env["DORI_SLACK_TOKEN_FILE"] = join(state.dir, "slack-token");
  const base = depsFor(world, fakeClock(T0), state.dir, { backend: "herdr" });
  recordHerdrSession(state.dir, "w9:p9", { session: SESSION, cwd: state.dir, model: "m/x", at: new Date(0).toISOString() });
  world.herdrDead = ["w9:p9"];
  world.panes = [{ pane_id: "w9:p9", workspace_id: "w9", cwd: state.dir }];
  const pid = await herdrShellPid(base.run, "w9:p9");
  const pwsh74: Runner = async (argv, opts) =>
    argv[0] === "powershell" ? { code: 0, err: "", out: JSON.stringify([{ ProcessId: pid, ParentProcessId: 1, CommandLine: "pwsh.exe", ExecutablePath: "pwsh.exe" }]) }
      : argv[0] === "pwsh.exe" ? { code: 0, err: "", out: "7.4.6" }
      : base.run(argv, opts);
  // When: the lead revives it on Windows
  const line = await reviveHerdr(pwsh74, base.clock, base.config, "w9:p9", "", async () => true, "win32");
  // Then: it is refused, naming the variable, and no agent line is run
  expect(line).toMatch(/^REVIVE_FAIL w9:p9: .*DORI_SLACK_TOKEN needs pwsh 7\.5\+/);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "run")).toBe(false);
});
