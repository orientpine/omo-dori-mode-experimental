import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrSessions } from "../src/herdr-sessions.ts";
import { findLead } from "../src/lead.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
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
  // back in the first session (/resume): a new child carries it, and omo writes its log again
  world.ps += "\n4004 4001 bash -c true";
  envs[4004] = `bash -c true PI_SESSION_ID=${first} PI_SESSION_FILE=${firstLog}`;
  written(firstLog, "2026-11-09T11:50:00Z");
  expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: first, model: "kimi-coding/k3.1-pro:max", log: firstLog });
  // that child ended: the kernel still shows the other session, whose log is older
  world.ps = world.ps.replace("\n4004 4001 bash -c true", "");
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
