import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrSessions } from "../src/herdr-sessions.ts";
import { findLead } from "../src/lead.ts";
import { run as realRun, type Runner } from "../src/run.ts";
import { procTable, sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";

let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "session-current-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", ...patch });

// omo can move to another session inside the same process (/new, /resume): its arguments keep naming the session it
// started with, while each child it starts carries the session it runs at that moment (zzangdori lead w1:p37, 2026-11-09).
// Of the sessions they name, the one omo wrote last is the one it runs.
test.if(process.platform === "linux")("a lead that switched sessions inside its agent is the session its log was written last, not the one its --session names, with that session's model, also once the child that showed it ended", async () => {
  const first = "78fa9242-a7a1-4d0c-90df-adeb47cf582b";
  const now = "01a1c001-ae4e-76d5-a979-6684c040e257";
  const sessions = join(dir, "sessions");
  const folder = sessionDirFor(sessions, dir);
  mkdirSync(folder, { recursive: true });
  const ran = (provider: string, model: string, level: string) => `${JSON.stringify({ type: "model_change", provider, modelId: model })}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: level, provider, modelId: model })}\n`;
  const firstLog = join(folder, `2026-11-09T01-11-47-404Z_${first}.jsonl`);
  const nowLog = join(folder, `2026-11-09T11-11-38-062Z_${now}.jsonl`);
  writeFileSync(firstLog, ran("kimi-coding", "k3.1-pro", "max"));
  writeFileSync(nowLog, ran("anthropic-subscription", "claude-opus-5-5", "medium"));
  const written = (log: string, at: string) => utimesSync(log, new Date(at), new Date(at));
  written(firstLog, "2026-11-09T09:22:05Z");
  written(nowLog, "2026-11-09T11:43:49Z");
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  // a kernel started before the switch and one after it
  world.ps = `4000 1 -bash\n4001 4000 omo --session ${firstLog}\n4002 4001 bun process-entry.js\n4003 4001 python3 -u prelude.py`;
  const envs: Record<string, string> = { 4002: `bun process-entry.js PI_SESSION_ID=${first} PI_SESSION_FILE=${firstLog}`, 4003: `python3 -u prelude.py PI_SESSION_ID=${now} PI_SESSION_FILE=${nowLog}` };
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => {
    const pid = argv.at(-1) ?? "";
    if (argv[0] === "ps" && argv[1] === "eww" && envs[pid]) return { code: 0, out: envs[pid], err: "" };
    return base.run(argv, o);
  };
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: now, model: "anthropic-subscription/claude-opus-5-5:medium", log: nowLog });
  // the child that showed the move ended and no other shows it: the session recorded for this same agent still counts
  world.ps = world.ps.replace("\n4003 4001 python3 -u prelude.py", "");
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: now, model: "anthropic-subscription/claude-opus-5-5:medium" });
  // back in the first session (/resume): a new child carries it, and omo writes its log again
  world.ps += "\n4004 4001 bash -c true";
  envs[4004] = `bash -c true PI_SESSION_ID=${first} PI_SESSION_FILE=${firstLog}`;
  written(firstLog, "2026-11-09T11:50:00Z");
  expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: first, model: "kimi-coding/k3.1-pro:max", log: firstLog });
  // that child ended: the kernel still shows the other session, whose log is older
  world.ps = world.ps.replace("\n4004 4001 bash -c true", "");
  world.ps += "\n4003 4001 python3 -u prelude.py";
  expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: first, model: "kimi-coding/k3.1-pro:max", log: firstLog });
});

// ps eww prints a process's arguments and then its environment: only what follows the arguments is environment
test.if(process.platform === "linux")("a PI_SESSION_ID= in a child's arguments is no session: its environment after them counts", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const other = "99999999-2222-4333-8444-555555555555";
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id}\n4002 4001 bash -c echo PI_SESSION_ID=${other}`;
  let env = `bash -c echo PI_SESSION_ID=${other} HOME=/h PI_SESSION_ID=${id}`;
  const base = omo({ leadPane: "w1:p1", sessionsDir: join(dir, "sessions") });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: env, err: "" } : base.run(argv, o));
  expect(await findLead(run, base.config)).toBe(`${id} w1:p1`);
  // an environment that cannot be read leaves only the arguments: no session from them
  env = `bash -c echo PI_SESSION_ID=${other}`;
  expect(await findLead(run, base.config)).toBe(`${id} w1:p1`);
});

// a child that shows only PI_SESSION_ID: its log is looked for where the session's logs are
test.if(process.platform === "linux")("a child's session without PI_SESSION_FILE has its log found in sessionsDir, so a newer one beats the launch session", async () => {
  const first = "11111111-2222-4333-8444-555555555555";
  const now = "22222222-2222-4333-8444-555555555555";
  const sessions = join(dir, "sessions");
  const folder = sessionDirFor(sessions, dir);
  mkdirSync(folder, { recursive: true });
  const firstLog = join(folder, `2026-11-09T01-00-00-000Z_${first}.jsonl`);
  const nowLog = join(folder, `2026-11-09T11-00-00-000Z_${now}.jsonl`);
  writeFileSync(firstLog, "");
  writeFileSync(nowLog, "");
  utimesSync(firstLog, new Date("2026-11-09T09:00:00Z"), new Date("2026-11-09T09:00:00Z"));
  utimesSync(nowLog, new Date("2026-11-09T11:30:00Z"), new Date("2026-11-09T11:30:00Z"));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${first}\n4002 4001 python3 -u prelude.py`;
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${now}`, err: "" } : base.run(argv, o));
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
});

// COLUMNS in the environment cuts ps's command column to that width unless -ww asks for all of it: a cut command is no
// boundary between a child's arguments and its environment
test.if(process.platform === "linux")("the process table keeps whole command lines when COLUMNS is set", async () => {
  const long = "x".repeat(300);
  const child = Bun.spawn(["python3", "-c", "import time; time.sleep(30)", long], { stdout: "ignore", stderr: "ignore" });
  const columns = process.env["COLUMNS"];
  process.env["COLUMNS"] = "80";
  try {
    const row = (await procTable(realRun)).find((p) => p.pid === child.pid);
    expect(row?.cmd.endsWith(long)).toBe(true);
  } finally {
    if (columns === undefined) delete process.env["COLUMNS"];
    else process.env["COLUMNS"] = columns;
    child.kill();
    await child.exited;
  }
});

// an agent started with no session selector at all: once a child showed the session it moved to, the record kept for that
// same agent still names it after every session-bearing child is gone, instead of the start-time file naming the old one
test.if(process.platform === "linux")("a selector-free agent keeps the session recorded for it after the child that showed it ended", async () => {
  const first = "11111111-2222-4333-8444-555555555555";
  const now = "22222222-2222-4333-8444-555555555555";
  const sessions = join(dir, "sessions");
  const folder = sessionDirFor(sessions, dir);
  mkdirSync(folder, { recursive: true });
  const entry = (level: string) => `${JSON.stringify({ type: "thinking_level_change", thinkingLevel: level, provider: "p", modelId: "m" })}\n`;
  const firstLog = join(folder, `2026-11-09T11-00-00-000Z_${first}.jsonl`);
  const nowLog = join(folder, `2026-11-09T11-11-38-062Z_${now}.jsonl`);
  writeFileSync(firstLog, entry("max"));
  writeFileSync(nowLog, entry("medium"));
  utimesSync(firstLog, new Date("2026-11-09T11:05:00Z"), new Date("2026-11-09T11:05:00Z"));
  utimesSync(nowLog, new Date("2026-11-09T11:43:49Z"), new Date("2026-11-09T11:43:49Z"));
  world.agentStart = "Mon Nov  9 11:00:00 2026";
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo\n4002 4001 python3 -u prelude.py`;
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${now} PI_SESSION_FILE=${nowLog}`, err: "" } : base.run(argv, o));
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: now, model: "p/m:medium" });
  world.ps = "4000 1 -bash\n4001 4000 omo";
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: now, model: "p/m:medium" });
});

// the launch session's log can live in the agent's own --session-dir, spaces included: it is found with the arguments'
// real word boundaries, so after /resume its newer log beats the one a leftover child of the other session names
test.if(process.platform === "linux")("a --session-dir with spaces has the launch session's log found, so its newer write beats the other session's", async () => {
  const first = "11111111-2222-4333-8444-555555555555";
  const now = "22222222-2222-4333-8444-555555555555";
  const sessions = join(dir, "sessions");
  const own = join(dir, "my sessions");
  mkdirSync(sessionDirFor(sessions, dir), { recursive: true });
  mkdirSync(own, { recursive: true });
  const firstLog = join(own, `2026-11-09T01-00-00-000Z_${first}.jsonl`);
  const nowLog = join(sessionDirFor(sessions, dir), `2026-11-09T11-00-00-000Z_${now}.jsonl`);
  writeFileSync(firstLog, "");
  writeFileSync(nowLog, "");
  utimesSync(firstLog, new Date("2026-11-09T11:50:00Z"), new Date("2026-11-09T11:50:00Z"));
  utimesSync(nowLog, new Date("2026-11-09T11:00:00Z"), new Date("2026-11-09T11:00:00Z"));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${first} --session-dir ${own}\n4002 4001 python3 -u prelude.py`;
  world.cmdlines = { 4001: ["omo", "--session-id", first, "--session-dir", own] };
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${now} PI_SESSION_FILE=${nowLog}`, err: "" } : base.run(argv, o));
  expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
});

// where ps loses the arguments' word boundaries (macOS), a path option read from a whitespace split would point at the
// wrong folder: only the default session folder and exactly known logs count there
test.if(process.platform === "linux")("on macOS a spaced --session-dir is not read from a whitespace split, so it cannot send the lookup to a wrong folder", async () => {
  const first = "11111111-2222-4333-8444-555555555555";
  const now = "22222222-2222-4333-8444-555555555555";
  const sessions = join(dir, "sessions");
  const folder = sessionDirFor(sessions, dir);
  mkdirSync(folder, { recursive: true });
  const firstLog = join(folder, `2026-11-09T01-00-00-000Z_${first}.jsonl`);
  const nowLog = join(folder, `2026-11-09T11-00-00-000Z_${now}.jsonl`);
  writeFileSync(firstLog, "");
  writeFileSync(nowLog, "");
  utimesSync(firstLog, new Date("2026-11-09T11:50:00Z"), new Date("2026-11-09T11:50:00Z"));
  utimesSync(nowLog, new Date("2026-11-09T11:00:00Z"), new Date("2026-11-09T11:00:00Z"));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${first} --session-dir "${join(dir, "custom sessions")}"\n4002 4001 python3 -u prelude.py`;
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${now} PI_SESSION_FILE=${nowLog}`, err: "" } : base.run(argv, o));
  const own = Object.getOwnPropertyDescriptor(process, "platform");
  if (!own) throw new Error("process.platform has no descriptor");
  Object.defineProperty(process, "platform", { ...own, value: "darwin" });
  try {
    expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
  } finally {
    Object.defineProperty(process, "platform", own);
  }
});
