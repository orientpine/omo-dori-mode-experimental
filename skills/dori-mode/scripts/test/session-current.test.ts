import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// started with, while each child it starts carries the session it runs at that moment (zzangdori lead w1:p37, 2026-11-09)
test.if(process.platform === "linux")("a lead that switched sessions inside its agent is the session its newest child carries, not the one its --session names, with that session's model", async () => {
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
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  // a kernel started before the switch and one after it
  world.ps = `4000 1 -bash\n4001 4000 omo --session ${firstLog}\n4002 4001 bun process-entry.js\n4003 4001 python3 -u prelude.py`;
  const envs: Record<string, string> = { 4002: `bun process-entry.js PI_SESSION_ID=${first} PI_SESSION_FILE=${firstLog}`, 4003: `python3 -u prelude.py PI_SESSION_ID=${now} PI_SESSION_FILE=${nowLog}` };
  const starts: Record<string, string> = { 4002: "Mon Nov  9 09:22:00 2026", 4003: "Mon Nov  9 11:24:51 2026" };
  const base = omo({ leadPane: "w1:p1", sessionsDir: sessions });
  const run: Runner = async (argv, o) => {
    const pid = argv.at(-1) ?? "";
    if (argv[0] === "ps" && argv[1] === "eww" && envs[pid]) return { code: 0, out: envs[pid], err: "" };
    if (argv[0] === "ps" && argv.includes("lstart=") && starts[pid]) return { code: 0, out: starts[pid], err: "" };
    return base.run(argv, o);
  };
  expect(await findLead(run, base.config)).toBe(`${now} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: now, model: "anthropic-subscription/claude-opus-5-5:medium", log: nowLog });
  // back in the first session (/resume): the newest child carries it again
  world.ps += "\n4004 4001 bash -c true";
  envs[4004] = `bash -c true PI_SESSION_ID=${first} PI_SESSION_FILE=${firstLog}`;
  starts[4004] = "Mon Nov  9 11:50:00 2026";
  expect(await findLead(run, base.config)).toBe(`${first} w1:p1`);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: first, model: "kimi-coding/k3.1-pro:max", log: firstLog });
});
