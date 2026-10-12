import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findLead, LeadError } from "../src/lead.ts";
import type { Runner } from "../src/run.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

const ID = "12345678-abcd";
const TMUX = "aoe_Dori_12345678";

test("lead uses a matching env id and env tmux before configured leadPane", async () => {
  const world = newWorld();
  const lead = await findLead(fakeRunner(world), { leadPane: "other-pane" }, { DORI_LEAD_TMUX: TMUX, DORI_LEAD_AOE_ID: ID });
  expect({ lead, calls: world.calls }).toEqual({ lead: `${ID} ${TMUX}`, calls: [["tmux", "has-session", "-t", `=${TMUX}`]] });
});

test("lead resolves a stale env id from aoe list using the configured pane", async () => {
  const world = newWorld();
  world.aoe = [{ id: ID, title: "Dori", path: "/repo" }];
  const lead = await findLead(fakeRunner(world), { leadPane: TMUX }, { DORI_LEAD_AOE_ID: "deadbeef-old" });
  expect({ lead, calls: world.calls }).toEqual({ lead: `${ID} ${TMUX}`, calls: [["tmux", "has-session", "-t", `=${TMUX}`], ["aoe", "list", "--json"]] });
});

test("lead refuses a missing pane or an unmatched aoe session", async () => {
  const world = newWorld();
  const missing = await findLead(fakeRunner(world), { leadPane: "" }, {}).catch((e: unknown) => e instanceof LeadError);
  const unmatched = await findLead(fakeRunner(world), { leadPane: TMUX }, {}).catch((e: unknown) => e instanceof LeadError);
  expect({ missing, unmatched }).toEqual({ missing: true, unmatched: true });
});

// at boot the lead's tmux session does not exist yet; dori-lead.service and dori.sh start it from this id
test("a lead whose tmux session is not running still resolves, marked stopped, from a matching env id or from aoe list", async () => {
  const noTmux = (aoe: object[]): Runner => async (argv) => (argv[0] === "tmux" ? { code: 1, out: "", err: "can't find session" } : argv[0] === "aoe" ? { code: 0, out: JSON.stringify(aoe), err: "" } : { code: 2, out: "", err: "" });
  const repro = "aoe_zzangdori_00000000";
  expect(await findLead(noTmux([{ id: "00000000aaaa", title: "zzangdori", path: "/home" }]), { leadPane: "" }, { DORI_LEAD_TMUX: repro, DORI_LEAD_AOE_ID: "8d429737ddd245c8" })).toBe(`00000000aaaa ${repro} stopped`);
  expect(await findLead(noTmux([]), { leadPane: TMUX }, { DORI_LEAD_AOE_ID: ID })).toBe(`${ID} ${TMUX} stopped`);
  expect(await findLead(noTmux([]), { leadPane: TMUX }, {}).catch((e: unknown) => (e as Error).message)).toBe(`no aoe session matches ${TMUX}`);
});

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const executable = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};

const leadCli = async (live: boolean, override = "") => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  executable(join(bin, "tmux"), `case "$*" in 'has-session -t =${TMUX}') exit ${live ? 0 : 1};; *) exit 2;; esac`);
  executable(join(bin, "aoe"), `case "$*" in 'list --json') printf '%s\\n' '[{"id":"${ID}","title":"Dori","path":"/repo"}]';; *) exit 2;; esac`);
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ leadPane: override ? "wrong-pane" : TMUX }));
  const envFile = join(state.dir, "dori.env");
  writeFileSync(envFile, "DORI_LEAD_AOE_ID=deadbeef-old\n");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DORI_CONFIG: config, DORI_ENV_FILE: envFile, DORI_STATE_DIR: state.dir, DORI_LEAD_TMUX: "", DORI_LEAD_AOE_ID: "" };
  // The env file must supply the stale id, not the host environment.
  delete env.DORI_LEAD_AOE_ID;
  if (override) env.DORI_LEAD_PANE = override;
  else delete env.DORI_LEAD_PANE;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "lead"], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
};

test("dori lead resolves a stale env-file id with fake aoe and tmux and honors DORI_LEAD_PANE", async () => {
  expect(await leadCli(true, TMUX)).toEqual({ code: 0, out: `${ID} ${TMUX}`, err: "" });
});

test("dori lead prints the stopped lead with exit 0 when fake tmux has no live session (boot)", async () => {
  expect(await leadCli(false)).toEqual({ code: 0, out: `${ID} ${TMUX} stopped`, err: "" });
});

test("the boot service executes the existing self-restart script in start mode", async () => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  const log = join(state.dir, "commands");
  const script = join(state.dir, ".dori/src/skills/dori-mode/setups/discord-aoe/self-restart.sh");
  mkdirSync(join(script, ".."), { recursive: true });
  executable(script, `printf '%s\\n' "self-restart.sh $*" >> "${log}"`);
  const service = readFileSync(join(import.meta.dir, "../../setups/discord-aoe/systemd/dori-lead.service"), "utf8");
  const command = (/^ExecStart=(.*)$/m.exec(service)?.[1] ?? "").replaceAll("%h", state.dir);
  const p = Bun.spawn(["bash", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DORI_LEAD_AOE_ID: "stale" }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await p.exited, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({ code: 0, commands: ["self-restart.sh --start"] });
});

const startScript = async (stopped: boolean, args: string[] = []) => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"\n[ "$1" != lead ] || printf '%s\\n' '${ID} ${TMUX}${stopped ? " stopped" : ""}'`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $*" >> "${log}"`);
  executable(join(bin, "tmux"), `printf '%s\\n' '❯'`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "agent"), "exit 0");
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ...args], {
    env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "agent", DORI_LEAD_AOE_ID: "stale", DORI_LEAD_TMUX: "wrong" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim(), commands: readFileSync(log, "utf8").trim().split("\n"), logged: existsSync(join(state.dir, ".dori/self-restart.log")) };
};

test("start mode leaves an already running lead untouched", async () => {
  expect(await startScript(false, ["--start"])).toEqual({ code: 0, out: `LEAD_ALREADY_RUNNING ${TMUX}`, err: "", commands: ["dori lead"], logged: false });
});

test("start mode starts a stopped lead then submits the default first message", async () => {
  const result = await startScript(true, ["--start"]);
  expect(result).toEqual({ code: 0, out: "", err: "", commands: ["dori lead", `aoe session start ${ID}`, `dori type ${TMUX} --text Dori mode`], logged: true });
});

test("default mode still restarts the lead and submits an explicit first message", async () => {
  const result = await startScript(false, [ID, TMUX, "configured first message"]);
  expect(result).toEqual({ code: 0, out: "", err: "", commands: [`aoe session restart ${ID}`, `dori type ${TMUX} --text configured first message`], logged: true });
});

test("no-argument self-restart resolves dori lead before checking the agent, without restarting in the check", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"\n[ "$1" != lead ] || printf '%s\\n' '${ID} ${TMUX}'`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $*" >> "${log}"\nexit 2`);
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh")], {
    env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "nonexistent-dori-test-agent", DORI_LEAD_AOE_ID: "stale", DORI_LEAD_TMUX: "wrong", DORI_DISCORD_CHANNEL: "fake" }, stdout: "pipe", stderr: "pipe",
  });
  const code = await p.exited;
  expect({ code, commands: readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" --")[0]) }).toEqual({ code: 1, commands: ["dori lead", "dori send discord"] });
});
