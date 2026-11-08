import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane, closeLessons } from "../src/done-flow.ts";
import { READ_ONLY_RULE } from "../src/backlog.ts";
import { leadText } from "../src/directives.ts";
import { briefForCheck } from "../src/intent-check.ts";
import { renderBrief } from "../src/launch.ts";
import { GLOBAL_LESSON_CAP, Lessons } from "../src/lessons.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-03T00:00:00.000Z");
const lane: Lane = { key: "lesson-flow", title: "QA", thread: "none", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const lesson = { rule: "Subscribe before triggering", evidence: "/evidence/test.txt" };
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a successful close keeps the lesson for the lane's repo", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const r = await closeLane(deps, lane, "verified", undefined, undefined, [lesson]);
  expect(r.closed).toBe(true);
  const kept = new Lessons(state.dir).read().lessons;
  expect(kept.map(({ rule, evidence, lane: key, cwd, outcome }) => ({ rule, evidence, lane: key, cwd, outcome }))).toEqual([{ ...lesson, lane: lane.key, cwd: "/repo", outcome: "pending" }]);
  expect(r.lines).toContain(`LESSON ${kept[0]?.id}`);
});

test("a refused close keeps no lesson", async () => {
  const world = newWorld();
  world.prState = "OPEN";
  const r = await closeLane(depsFor(world, fakeClock(T0), state.dir), lane, "not ready", undefined, undefined, [lesson, { rule: "Second", evidence: "/e" }]);
  expect(r.closed).toBe(false);
  expect(new Lessons(state.dir).read().lessons).toEqual([]);
});

test("a lesson that cannot be kept is a warning and the close still happens", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  mkdirSync(join(state.dir, "lessons.jsonl"));
  const r = await closeLane(deps, lane, "verified", undefined, undefined, [lesson]);
  expect(r.closed).toBe(true);
  expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  expect(r.lines.some((l) => l.startsWith(`LESSON_WARNING ${lane.key}: `))).toBe(true);
});

test("a close without --lesson leaves the journal alone", async () => {
  writeFileSync(join(state.dir, "lessons.jsonl"), "invalid\n");
  const r = await closeLane(depsFor(newWorld(), fakeClock(T0), state.dir), lane, "verified");
  expect(r.closed).toBe(true);
  expect(readFileSync(join(state.dir, "lessons.jsonl"), "utf8")).toBe("invalid\n");
});

test("a close with two lessons keeps both, in order, each with its LESSON line", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const r = await closeLane(deps, lane, "verified", undefined, undefined, [lesson, { rule: "Read the pane before typing", evidence: "/evidence/pane.txt" }]);
  expect(r.closed).toBe(true);
  const kept = new Lessons(state.dir).read().lessons;
  expect(kept.map((l) => [l.rule, l.evidence]).sort()).toEqual([["Read the pane before typing", "/evidence/pane.txt"], [lesson.rule, lesson.evidence]]);
  expect(r.lines.filter((l) => l.startsWith("LESSON "))).toEqual(kept.map((l) => `LESSON ${l.id}`).reverse());
});

test("one lesson that cannot be kept does not cost the others", async () => {
  const r = await closeLane(depsFor(newWorld(), fakeClock(T0), state.dir), lane, "verified", undefined, undefined, [{ rule: "", evidence: "/e" }, lesson]);
  expect(r.closed).toBe(true);
  expect(r.lines.filter((l) => l.startsWith(`LESSON_WARNING ${lane.key}: `)).length).toBe(1);
  expect(new Lessons(state.dir).read().lessons.map((l) => l.rule)).toEqual([lesson.rule]);
});

test("each --lesson takes the --evidence in its place, one --evidence serves them all, none means the Done line", () => {
  expect(closeLessons(["A", "B"], ["/a", "/b"], "done")).toEqual([{ rule: "A", evidence: "/a" }, { rule: "B", evidence: "/b" }]);
  expect(closeLessons(["A", "B"], ["/e"], "done")).toEqual([{ rule: "A", evidence: "/e" }, { rule: "B", evidence: "/e" }]);
  expect(closeLessons(["A"], [], "done")).toEqual([{ rule: "A", evidence: "done" }]);
  expect(closeLessons([], ["/e"], "done")).toEqual([]);
  expect(typeof closeLessons(["A", "B", "C"], ["/a", "/b"], "done")).toBe("string");
});

const cli = async (args: string[]): Promise<{ code: number; out: string }> => {
  mkdirSync(join(state.dir, "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "lanes", "cli-lane.json"), JSON.stringify({ key: "cli-lane", title: "QA", thread: "none", brief: "/b.md", done: 'command ["echo","MERGED"] stdout~"MERGED"', cwd: state.dir, openedAt: new Date(T0).toISOString() }));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "close", "cli-lane", ...args], {
    env: { ...process.env, DORI_CONFIG: join(state.dir, "none.json"), DORI_STATE_DIR: state.dir }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
};

test("dori close --lesson A --lesson B prints two LESSON lines and keeps both", async () => {
  const r = await cli(["--lesson", "A rule", "--evidence", "/a", "--lesson", "B rule", "--evidence", "/b"]);
  expect(r.code).toBe(0);
  expect(r.out.match(/^LESSON [0-9a-f-]{36}$/gm)?.length).toBe(2);
  expect(new Lessons(state.dir).read().lessons.map((l) => `${l.rule} ${l.evidence}`).sort()).toEqual(["A rule /a", "B rule /b"]);
});

test("dori close with evidence that pairs with no lesson is refused before the close", async () => {
  const r = await cli(["--lesson", "A", "--lesson", "B", "--lesson", "C", "--evidence", "/a", "--evidence", "/b"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("LESSON_EVIDENCE_MISMATCH cli-lane");
  expect(JSON.parse(readFileSync(join(state.dir, "lanes", "cli-lane.json"), "utf8")).status).toBeUndefined();
  expect(new Lessons(state.dir).read().lessons).toEqual([]);
});

test("the brief carries the repo's current lessons before Past signals and the footer, and never repeats the brief's own words", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const lessons = new Lessons(state.dir);
  const kept = lessons.add({ ...lesson, lane: "earlier", cwd: "/repo" }, T0);
  const retired = lessons.add({ rule: "Retired rule", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0 + 1);
  lessons.mark(retired.id, "harmful");
  lessons.add({ rule: "Other repo rule", evidence: "/e", lane: "earlier", cwd: "/elsewhere" }, T0 + 2);
  lessons.add({ rule: "Run the big tests through dori heavy", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0 + 3);
  appendFileSync(lessons.path, "not json\n");
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\nRun the big tests through dori heavy.\n");
  const r = await renderBrief(deps, { key: "lesson-next", title: "next", brief, done: "merged acme/app#2", cwd: "/repo" });
  const at = r.text.indexOf("## Lessons for this repo (written by dori launch)");
  expect(at).toBeGreaterThan(r.text.indexOf("# Port it"));
  expect(at).toBeLessThan(r.text.indexOf("## Lane footer"));
  expect(r.text).toContain(`- [pending; earlier; ${kept.id}] Subscribe before triggering`);
  expect(r.text).not.toContain("Retired rule");
  expect(r.text).not.toContain("Other repo rule");
  expect(r.text.split("Run the big tests through dori heavy").length).toBe(2);
  expect(r.lines.some((l) => l.startsWith(`LESSON_WARNING ${lessons.path}:`))).toBe(true);
});

test("a brief launched again drops a lesson retired since and keeps what was added after its footer", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const lessons = new Lessons(state.dir);
  const old = lessons.add({ ...lesson, lane: "earlier", cwd: "/repo" }, T0);
  lessons.add({ rule: "Keep this one", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0 + 1);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const input = { key: "lesson-again", title: "again", brief, done: "merged acme/app#2", cwd: "/repo" };
  // as backlog does: a launched brief copied, its read-only rule and an owner's answer appended after the footer
  await Bun.write(brief, `${(await renderBrief(deps, input)).text}\n\n## 형 결정 (11-03 19:00)\n형 답: 그대로 가\n\n${READ_ONLY_RULE}\n`);
  lessons.mark(old.id, "harmful");
  const again = (await renderBrief(deps, input)).text;
  expect(again).not.toContain(lesson.rule);
  expect(again).toContain("Keep this one");
  expect(again.split("## Lessons for this repo").length).toBe(2);
  expect(again).toContain("## 형 결정 (11-03 19:00)\n형 답: 그대로 가");
  expect(again).toContain(READ_ONLY_RULE);
});

test("the lessons section is not the lead's or the owner's words for the directive audit and intent-check", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  new Lessons(state.dir).add({ rule: "Screenshot the dashboard UI at phone width", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const { text } = await renderBrief(deps, { key: "lesson-scope", title: "scope", brief, done: "merged acme/app#2", cwd: "/repo" });
  expect(text).toContain("Screenshot the dashboard UI at phone width");
  expect(leadText(text)).not.toContain("dashboard UI");
  expect(briefForCheck(text)).not.toContain("dashboard UI");
});

test("a repo with no lessons gets no lessons section", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const r = await renderBrief(depsFor(newWorld(), fakeClock(T0), state.dir), { key: "lesson-none", title: "none", brief, done: "merged acme/app#2", cwd: "/repo" });
  expect(r.text).not.toContain("## Lessons for this repo");
});

// Global lessons, upstream https://github.com/sisyphuslabs/dori-superagent/pull/97: the lead's rules reach every lane's brief.
test("the lead's global lessons reach a brief in any repo, under their own heading above the repo's lessons", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const lessons = new Lessons(state.dir);
  const repo = lessons.add({ ...lesson, lane: "earlier", cwd: "/repo" }, T0);
  const global = lessons.add({ lane: "lead", scope: "global", rule: "Never change the global Git identity", evidence: "slack:D1/2.1" }, T0 + 1);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const here = (await renderBrief(deps, { key: "lesson-global", title: "g", brief, done: "merged acme/app#2", cwd: "/repo" })).text;
  const elsewhere = (await renderBrief(deps, { key: "lesson-global2", title: "g", brief, done: "merged acme/app#2", cwd: "/elsewhere" })).text;
  const g = here.indexOf("## Lessons for every lane (written by dori launch)");
  expect(g).toBeGreaterThan(here.indexOf("# Port it"));
  expect(g).toBeLessThan(here.indexOf("## Lessons for this repo (written by dori launch)"));
  expect(here).toContain(`- [pending; lead; ${global.id}] Never change the global Git identity`);
  expect(here).toContain(`- [pending; earlier; ${repo.id}] Subscribe before triggering`);
  expect(here.slice(g, here.indexOf("## Lessons for this repo"))).not.toContain("Subscribe before triggering");
  expect(elsewhere).toContain(`- [pending; lead; ${global.id}] Never change the global Git identity`);
  expect(elsewhere).not.toContain("## Lessons for this repo");
  // not the lead's or the owner's words for the directive audit and intent-check
  expect(leadText(here)).not.toContain("global Git identity");
  expect(briefForCheck(here)).not.toContain("global Git identity");
});

test("global lessons add at most their cap of lines to a brief, and a brief launched again carries them once", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const lessons = new Lessons(state.dir);
  // more global rules than the cap, each as long as a rule may be
  for (let i = 0; i <= GLOBAL_LESSON_CAP + 1; i++) lessons.add({ lane: "lead", scope: "global", rule: `G${i} ${"x".repeat(396)}`, evidence: "slack:D1/3.1" }, T0 + i);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const input = { key: "lesson-cap", title: "cap", brief, done: "merged acme/app#2", cwd: "/repo" };
  const plain = (await renderBrief(depsFor(newWorld(), fakeClock(T0), join(state.dir, "empty")), input)).text;
  const first = (await renderBrief(deps, input)).text;
  const lines = first.split("\n").filter((l) => l.startsWith("- [pending; lead; "));
  expect(lines.map((l) => l.replace(/^.*\] (G\d+) .*$/, "$1"))).toEqual(["G5", "G4", "G3", "G2"]);
  // the heading, its one-line note, GLOBAL_LESSON_CAP rules of at most 400 characters with their prefix, and a blank line
  expect(first.length - plain.length).toBeLessThanOrEqual(400 + GLOBAL_LESSON_CAP * (400 + 60) + 2);
  await Bun.write(brief, first);
  const again = (await renderBrief(deps, input)).text;
  expect(again.split("## Lessons for every lane").length).toBe(2);
  expect(again.split("- [pending; lead; ").length).toBe(GLOBAL_LESSON_CAP + 1);
});
