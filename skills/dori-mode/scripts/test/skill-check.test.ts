import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Registry, type Lane } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let lane: Lane;
let sessions: string;
const at = "2026-11-17T00:00:00Z";
const msg = (role: string, content: unknown) => ({ type: "message", timestamp: at, message: { role, content } });
const read = (skill: string) => msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: `/skills/${skill}/SKILL.md` } }]);
const transcript = (id: string, rows: unknown[]) => [{ type: "session", id, timestamp: at }, ...rows].map((r) => JSON.stringify(r)).join("\n");
const session = (rows: unknown[], id = "lane-session") => writeFileSync(join(sessions, `2026-11-17T00-00-00-000Z_${id}.jsonl`), transcript(id, rows));
const brief = (text: string) => writeFileSync(lane.brief, text);
const invoke = () => run(["env", "-u", "HC_TERMINAL_ID", "-u", "HERDR_PANE_ID", "-u", "TMUX", "-u", "DORI_DISCORD_TOKEN",
  `DORI_CONFIG=${join(state.dir, "config.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "empty.env")}`,
  process.execPath, join(import.meta.dir, "../src/cli.ts"), "claim-done", lane.key, "--evidence", "isolated proof"], { timeoutMs: 30_000 });
const log = async () => {
  const f = Bun.file(join(state.dir, "watch.log"));
  return await f.exists() ? await f.text() : "";
};

beforeEach(async () => {
  state = withState();
  lane = { key: "qa-skills", title: "Skill check", thread: "none", brief: join(state.dir, "brief.md"), done: "file /unused", cwd: state.dir, session: "lane-session", openedAt: at };
  sessions = sessionDirFor(join(state.dir, "sessions"), state.dir);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(state.dir, "empty.env"), "");
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({
    stateDir: state.dir, defaultCwd: state.dir, sessionsDir: join(state.dir, "sessions"), watchLog: join(state.dir, "watch.log"),
    hooks: {}, mergeGate: { repos: {} }, scorecard: { leadSessions: "" },
  }));
  await new Registry(state.dir).write(lane);
  brief("Read $bun first.");
});
afterEach(() => state.done());

test("missing named skill warns on stderr and watch log while the real claim succeeds unchanged", async () => {
  session([msg("assistant", "Finished without reading the skill.")]);
  const result = await invoke();
  expect(result.code).toBe(0);
  expect(result.out.trim()).toBe("LANE_DONE_CLAIMED qa-skills - isolated proof");
  expect(result.err).toContain("SKILL_NOT_READ qa-skills: bun");
  expect(result.err).toContain("(directive skill-check; a warning for now, refusal to be reviewed on 2026-12-01)");
  expect(await log()).toContain(` claim-done ${result.err.trim()}`);
  expect((await new Registry(state.dir).read(lane.key))?.status).toBe("done-claimed");
}, 40_000);

for (const text of ['load_skills: ["bun"]', '{"load_skills":["bun"]}', "$bun", "Use skill bun", "Read /skills/bun/SKILL.md"]) {
  test(`recognizes named skill in ${text}`, async () => {
    brief(text);
    session([msg("assistant", "done")]);
    const r = await invoke();
    expect(r.code).toBe(0);
    expect(r.err).toContain("SKILL_NOT_READ qa-skills: bun");
  }, 40_000);
}

test("a real skill read is clean; a prose mention and a user request to read it are not reads", async () => {
  session([read("bun")]);
  expect((await invoke()).err).toBe("");
  expect(await log()).toBe("");
  session([msg("assistant", "I read /skills/bun/SKILL.md"), msg("user", "Read /skills/bun/SKILL.md")]);
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
}, 40_000);

test("eval reads use the same file-read detection as research-start", async () => {
  session([msg("assistant", [{ type: "toolCall", name: "eval", arguments: { code: 'await tool.read({path: "/skills/bun/SKILL.md"})' } }])]);
  expect((await invoke()).err).toBe("");
}, 40_000);

test("a similarly named skill and SKILL.md suffix are not the requested skill", async () => {
  session([read("other-bun"), msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "/skills/bun/SKILL.md.bak" } }])]);
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
  session([msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "C:\\skills\\bun\\SKILL.md" } }])]);
  expect((await invoke()).err).toBe("");
}, 40_000);

test("ulw keywords attach a named skill; its custom pointer satisfies the check", async () => {
  brief("ulw research: investigate");
  session([msg("assistant", "done")]);
  expect((await invoke()).err).toContain("ulw-research");
  session([{ type: "custom_message", customType: "omo-ulw-research:skill-pointer", timestamp: at }]);
  expect((await invoke()).err).toBe("");
}, 40_000);

test("inline user pointers count, assistant quotations do not", async () => {
  session([msg("user", "<omo-bun-pointer>Read the attached skill.</omo-bun-pointer>")]);
  expect((await invoke()).err).toBe("");
  session([msg("assistant", "<omo-bun-pointer>")]);
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
}, 40_000);

test("other sessions cannot satisfy the lane; prior sessions can", async () => {
  session([msg("assistant", "done")]);
  session([read("bun")], "another-session");
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
  await new Registry(state.dir).write({ ...lane, priorSessions: ["another-session"] });
  expect((await invoke()).err).toBe("");
}, 40_000);

test("legacy lanes use their report marker and exclude the lead's copies", async () => {
  await new Registry(state.dir).write({ ...lane, session: undefined });
  session([msg("assistant", `[REPORT] ${lane.key} | done`)]);
  const lead = join(state.dir, "lead");
  mkdirSync(lead);
  writeFileSync(join(lead, "lead.jsonl"), transcript("lead", [msg("assistant", `[REPORT] ${lane.key} | copied`), read("bun")]));
  const cfg = await Bun.file(join(state.dir, "config.json")).json();
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ ...cfg, scorecard: { leadSessions: lead } }));
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
  session([msg("assistant", `[REPORT] ${lane.key} | done`), read("bun")]);
  expect((await invoke()).err).toBe("");
}, 40_000);

test("an identified lane in the shared lead folder warns before any lead handover", async () => {
  const cfg = await Bun.file(join(state.dir, "config.json")).json();
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ ...cfg, scorecard: { leadSessions: sessions } }));
  session([msg("assistant", "done without reading the skill")]);
  let r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toContain("SKILL_NOT_READ qa-skills: bun");
  session([read("bun")]);
  r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
}, 40_000);

test("an adopted lane finds its identified session outside the recorded cwd", async () => {
  const actual = sessionDirFor(join(state.dir, "sessions"), join(state.dir, "adopted-cwd"));
  mkdirSync(actual, { recursive: true });
  const file = join(actual, "2026-11-17T00-00-00-000Z_lane-session.jsonl");
  writeFileSync(file, transcript("lane-session", [msg("assistant", "done")]));
  let r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toContain("SKILL_NOT_READ qa-skills: bun");
  writeFileSync(file, transcript("lane-session", [read("bun")]));
  r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
}, 40_000);

test("a handover finds the prior skill read under a symlink's real path", async () => {
  const real = join(state.dir, "real-cwd");
  const linked = join(state.dir, "linked-cwd");
  mkdirSync(real);
  symlinkSync(real, linked, "dir");
  await new Registry(state.dir).write({ ...lane, cwd: linked, priorSessions: ["prior-session"] });
  sessions = sessionDirFor(join(state.dir, "sessions"), linked);
  mkdirSync(sessions, { recursive: true });
  session([msg("assistant", "done")]);
  const previous = sessionDirFor(join(state.dir, "sessions"), real);
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "2026-11-17T00-00-00-000Z_prior-session.jsonl"), transcript("prior-session", [read("bun")]));
  const r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
}, 40_000);

test("an unresolved prior session cannot prove a missing skill read", async () => {
  session([msg("assistant", "done")]);
  await new Registry(state.dir).write({ ...lane, priorSessions: ["unavailable-session"] });
  const r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
}, 40_000);

test("each unique missing skill warns once, while a read skill stays clean", async () => {
  brief('load_skills = ["bun", "other"]\n$bun; skill other');
  session([read("bun")]);
  const r = await invoke();
  expect(r.err).not.toContain(": bun ");
  expect(r.err.match(/SKILL_NOT_READ/g)).toHaveLength(1);
  expect(r.err).toContain(": other ");
}, 40_000);

test("ulw loop, ulw plan and mass ulw are named skills", async () => {
  brief("ulw loop; ulw plan; mass ulw");
  session([msg("assistant", "done")]);
  const r = await invoke();
  for (const skill of ["ulw-loop", "ulw-plan", "mass-ulw"]) expect(r.err).toContain(`: ${skill} `);
}, 40_000);

test("a read before the lane opened does not satisfy it", async () => {
  session([{ ...read("bun"), timestamp: "2026-11-16T00:00:00Z" }]);
  expect((await invoke()).err).toContain("SKILL_NOT_READ");
}, 40_000);

test("briefs without named skills and generated ledger examples produce no warning", async () => {
  brief("Fix the command.\n## Lane footer (written by dori launch)\nUse skill bun.");
  session([msg("assistant", "done")]);
  expect((await invoke()).err).toBe("");
}, 40_000);

test("missing brief, missing sessions and unreadable session files preserve the claim", async () => {
  // The brief exists but no own transcript is available.
  expect((await invoke()).err).toBe("");
  mkdirSync(join(sessions, "unreadable.jsonl"));
  let r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  await new Registry(state.dir).write({ ...lane, brief: join(state.dir, "missing.md") });
  r = await invoke();
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
}, 40_000);
