import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { bareId, ChallengeError, challengeMissing, familyOf, REVIEWER_SYSTEM, reviewers, runChallenge } from "../src/challenge.ts";
import { defaultConfig } from "../src/config.ts";
import { addNode, formatTree, gateFix, intentView, laneArea, loadTree, metricAttempts, researchHint, saveTree, setStatus, type Tree } from "../src/explore.ts";
import { branchesFrom, forkExplore, parseBranch } from "../src/fork-explore.ts";
import { freshnessTick } from "../src/freshness.ts";
import { footer, renderBrief } from "../src/launch.ts";
import type { FixAttempt, Lane } from "../src/registry.ts";
import { run, type Runner } from "../src/run.ts";
import { recordFix } from "../src/same-fix.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "rl-e7", title: "E7 dump policy", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", cwd: "/work/rl", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const fix = (hypothesis: string, extra: Partial<FixAttempt> = {}): FixAttempt => ({ at: "t", metric: "dumps", hypothesis, via: "lead", ...extra });
const three = { hypotheses: ["reward too small", "exploration collapsed", "critic undervalues post-dump states"], tests: ["double the reward", "log swing sigma", "compare V before/after dump"] };

const cli = (stateDir: string, config: string, args: string[]) =>
  run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${stateDir}`, `DORI_ENV_FILE=${join(stateDir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), ...args]);

test("the second fix on one metric with no improvement is refused without three hypotheses and tests, and recorded with them", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write({ ...lane, pane: undefined });
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: deps.config.watchLog, defaultCwd: "/home/test" }));
  const base = ["fix-attempt", "rl-e7", "--metric", "dumps", "--hypothesis"];
  expect((await cli(state.dir, config, [...base, "reward too small"])).code).toBe(0);
  const refused = await cli(state.dir, config, [...base, "reward still too small"]);
  expect(refused.code).toBe(5);
  expect(refused.err).toContain("HYPOTHESES_REQUIRED rl-e7 attempt 2");
  expect((await deps.registry.read("rl-e7"))?.fixes).toHaveLength(1);
  const args = three.hypotheses.flatMap((h, i) => ["--hypotheses", h, "--test", three.tests[i] ?? ""]);
  const ok = await cli(state.dir, config, [...base, "exploration collapsed", ...args]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("STUCK_BRANCH rl-e7 attempt 2");
  expect(ok.out).toContain("FIX_RECORDED rl-e7");
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toMatch(/fix-attempt HYPOTHESES_REQUIRED rl-e7/);
  expect(log).toMatch(/fix-attempt STUCK_BRANCH rl-e7/);
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.filter((n) => n.kind === "hypothesis" && n.status === "open").map((n) => n.test)).toEqual(three.tests);
  const override = await cli(state.dir, config, [...base, "one more try", "--no-hypotheses", "owner asked for this exact patch"]);
  expect(override.code).toBe(0);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/HYPOTHESES_OVERRIDE rl-e7 attempt 3 .*owner asked for this exact patch/);
});

test("the gate counts attempts on a metric across hypotheses, once per lead-asked-then-reported fix, and --improved starts again", () => {
  const cfg = defaultConfig().explore;
  expect(gateFix([], fix("a"), { hypotheses: [], tests: [] }, cfg).verdict).toBe("ok");
  expect(gateFix([fix("a")], fix("b"), { hypotheses: [], tests: [] }, cfg).verdict).toBe("required");
  expect(gateFix([fix("a")], fix("b"), { hypotheses: three.hypotheses, tests: three.tests.slice(0, 2) }, cfg).verdict).toBe("required");
  expect(gateFix([fix("a")], fix("b"), three, cfg).verdict).toBe("branch");
  expect(gateFix([fix("a")], fix("b", { improved: true }), { hypotheses: [], tests: [] }, cfg).verdict).toBe("ok");
  expect(metricAttempts([fix("a"), fix("a", { via: "report" }), fix("b")], "dumps")).toBe(2);
});

test("the tree keeps one entry per idea, records falsified and supported results, and a new brief carries it before the footer", async () => {
  let t: Tree = { area: "cwd /work/rl", nodes: [] };
  t = addNode(t, { kind: "hypothesis", text: "Reward too small", test: "double it", source: "x" }, "t1").tree;
  const again = addNode(t, { kind: "hypothesis", text: "reward  too small", source: "x" }, "t2");
  expect(again.added).toBe(false);
  t = addNode(again.tree, { kind: "direction", text: "curriculum on soil hardness", source: "x" }, "t2").tree;
  t = setStatus(t, "H1", "falsified", "reward x2 changed nothing", "t3").tree;
  expect(formatTree(t)).toContain("Falsified (do not retry):\n  H1 Reward too small (test: double it) -> reward x2 changed nothing");
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await saveTree(state.dir, laneArea(lane, deps.config), t);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Do the thing\n");
  const { text } = await renderBrief(deps, { key: "rl-e8", title: "e8", brief, done: 'command ["bun","test"]', cwd: "/work/rl", goal: "dump into the bank" });
  expect(text).toContain("## Hypothesis tree (written by dori launch)");
  expect(text).toContain("Untried directions: D1 curriculum on soil hardness");
  expect(text.indexOf("## Hypothesis tree")).toBeLessThan(text.indexOf("## Lane footer"));
  expect(text).toContain('Goal (owner words): "dump into the bank"');
  expect(await Bun.file(brief).text()).toBe("# Do the thing\n");
});

test("the second stuck signal sends the lane an external-search step and puts it in the tree; research-hint plans the search", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  for (const h of ["a", "b"]) expect((await recordFix(deps, "rl-e7", fix(h))).notes).toEqual([]);
  const third = await recordFix(deps, "rl-e7", fix("c"));
  expect(third.notes[0]).toStartWith('RESEARCH_DUE rl-e7 stuck signal 2 on "dumps"');
  expect(sent(world)[0]).toContain("external search for this exact symptom");
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.filter((n) => n.kind === "research").length).toBe(1);
  expect(tree.nodes.filter((n) => n.kind === "tried").map((n) => n.text)).toEqual(["a", "b", "c"]);
  const hint = researchHint((await deps.registry.read("rl-e7")) as Lane, tree);
  expect(hint[0]).toBe('RESEARCH_HINT rl-e7 on "dumps": 3 attempts, 3 hypotheses tried, 0 falsified, 0 open');
  expect(hint.some((l) => l.includes("dori tree add --lane rl-e7 --kind finding"))).toBe(true);
});

test("a lane's own unbranched second fix report tells the lead hypotheses are required", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  await recordFix(deps, "rl-e7", fix("a", { via: "report" }));
  expect((await recordFix(deps, "rl-e7", fix("b", { via: "report" }))).notes[0]).toStartWith("HYPOTHESES_REQUIRED rl-e7 reported attempt 2");
});

const REVIEW = "## Reasons this will fail\nx\n## Missing alternatives\ny\n## Cheapest falsifying test\nz";
const PREAMBLE = "계획 문서와 관련 파일을 확인한 뒤 세 절만 쓰겠다.";
// the model a fake reviewer was called with, and the prompt it got
const modelOf = (argv: readonly string[]): string => argv[argv.indexOf("--model") + 1] ?? "";
const challengeWorld = async (fake: Runner, models?: readonly string[]) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const deps = { ...base, run: fake, config: { ...base.config, explore: { ...base.config.explore, ...(models ? { challengeModels: models } : {}) } } };
  const l: Lane = { ...lane, model: "anthropic/claude-opus-5-5", challengeBefore: ["the full 9-seed run"] };
  await deps.registry.write(l);
  const plan = join(state.dir, "plan.md");
  await Bun.write(plan, "Raise the dump reward to 3x and run 9 seeds.");
  return { deps, l, plan };
};

test("challenge asks a reviewer of another family, saves a complete review and records it on the lane", async () => {
  expect(familyOf("anthropic-subscription/claude-opus-5-5:medium")).toBe("anthropic");
  expect(familyOf("github-copilot/gpt-6.1-sol")).toBe("openai");
  expect(reviewers("anthropic/claude-opus-5-5", ["github-copilot/claude-opus-5.5", "xai/grok-4", "google/gemini-3"])).toEqual(["xai/grok-4", "google/gemini-3"]);
  expect(bareId("github-copilot/gpt-6.1-sol")).toBe("gpt-6.1-sol");
  expect(bareId("gpt-6.1-sol")).toBeUndefined();
  const calls: string[][] = [];
  const { deps, l, plan } = await challengeWorld(async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: REVIEW, err: "" };
  });
  expect(challengeMissing(l)).toStartWith("CHALLENGE_MISSING rl-e7");
  const r = await runChallenge(deps, l, plan, undefined);
  expect(calls.map(modelOf)).toEqual(["xai/grok-4.7"]);
  expect(r.failures).toEqual([]);
  expect(calls[0]).toContain(REVIEWER_SYSTEM);
  expect(calls[0]?.at(-1)).toContain("Raise the dump reward to 3x");
  const file = await Bun.file(r.record.file).text();
  for (const h of ["## Reasons this will fail", "## Missing alternatives", "## Cheapest falsifying test"]) expect(file).toContain(h);
  const saved = (await deps.registry.read("rl-e7")) as Lane;
  expect(saved.challenges?.[0]?.file).toBe(r.record.file);
  expect(challengeMissing(saved)).toBeUndefined();
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/challenge CHALLENGE rl-e7 reviewer=xai\/grok-4.7 /);
  await expect(runChallenge(deps, l, plan, "github-copilot/claude-sonnet-5")).rejects.toThrow("the lane's own family");
});

test("a reviewer that only announces what it will read gets one stricter retry, then fails clearly with its raw replies saved", async () => {
  const calls: string[][] = [];
  const { deps, l, plan } = await challengeWorld(async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: PREAMBLE, err: "" };
  });
  const err = await runChallenge(deps, l, plan, "xai/grok-4.7").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChallengeError);
  expect(calls.map(modelOf)).toEqual(["xai/grok-4.7", "xai/grok-4.7"]);
  expect(calls[1]?.at(-1)).toContain("Your previous reply was not the review");
  expect(calls[1]?.at(-1)).toContain(PREAMBLE);
  const message = (err as Error).message;
  expect(message).toContain("no reviewer wrote a complete review: xai/grok-4.7: no complete review after a stricter retry");
  const raw = /raw replies: (\S+)/.exec(message)?.[1] ?? "";
  expect(raw).toEndWith("-xai-grok-4.7-raw.md");
  expect((await Bun.file(raw).text()).split(PREAMBLE)).toHaveLength(3);
  expect(((await deps.registry.read("rl-e7")) as Lane).challenges).toBeUndefined();
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/challenge CHALLENGE_FAILED rl-e7 /);
});

test("a stricter retry that writes the three sections is saved as the review", async () => {
  let n = 0;
  const { deps, l, plan } = await challengeWorld(async () => ({ code: 0, out: n++ ? REVIEW : PREAMBLE, err: "" }));
  const r = await runChallenge(deps, l, plan, undefined);
  expect(n).toBe(2);
  expect(r.record.model).toBe("xai/grok-4.7");
  expect(r.text).toBe(REVIEW);
  expect(await Bun.file(r.record.file).text()).toContain("- Attempts: 2");
});

test("a provider the host cannot call is retried as the bare model id, and a family that fails hands over to the next one", async () => {
  const calls: string[] = [];
  const { deps, l, plan } = await challengeWorld(async (argv) => {
    const m = modelOf(argv);
    calls.push(m);
    if (m.includes("grok")) return { code: 0, out: PREAMBLE, err: "" };
    if (m.startsWith("google/") || m.startsWith("github-copilot/")) return { code: 1, out: "", err: "No API key found.\nUse /login to log into a provider via OAuth or API key. See:\n  /rt/docs/providers.md\n  /rt/docs/models.md" };
    if (m === "gemini-3.1-pro-preview") return { code: 1, out: "", err: 'Error: Model "gemini-3.1-pro-preview" is ambiguous across providers. No matching provider is authenticated.' };
    return m === "gpt-6.1-sol" ? { code: 0, out: REVIEW, err: "" } : { code: 1, out: "", err: "unexpected" };
  }, ["xai/grok-4.7", "google/gemini-3.1-pro-preview", "github-copilot/gpt-6.1-sol", "anthropic/claude-opus-5-5"]);
  const r = await runChallenge(deps, l, plan, undefined);
  expect(calls).toEqual(["xai/grok-4.7", "xai/grok-4.7", "google/gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "github-copilot/gpt-6.1-sol", "gpt-6.1-sol"]);
  expect(r.record.model).toBe("gpt-6.1-sol");
  expect(familyOf(r.record.model)).toBe("openai");
  expect(r.failures[1]).toBe("google/gemini-3.1-pro-preview: exit 1 No API key found.; trying gemini-3.1-pro-preview");
  expect(r.failures[2]).toContain("gemini-3.1-pro-preview: exit 1 Error: Model");
  expect(r.failures[3]).toStartWith("github-copilot/gpt-6.1-sol: exit 1 ");
  expect((await Bun.file(deps.config.watchLog).text()).match(/CHALLENGE_SKIP rl-e7 /g)).toHaveLength(4);
  const timedOut: string[] = [];
  const slow = await challengeWorld(async (argv) => {
    timedOut.push(modelOf(argv));
    return { code: 124, out: "", err: "killed by SIGKILL (timeout)" };
  }, ["github-copilot/gpt-6.1-sol"]);
  await expect(runChallenge(slow.deps, slow.l, slow.plan, undefined)).rejects.toThrow("github-copilot/gpt-6.1-sol: exit 124 killed by SIGKILL (timeout)");
  expect(timedOut).toEqual(["github-copilot/gpt-6.1-sol"]);
});

test("fork-explore runs CPU branches at once, queues GPU branches on the slot, prints one table and feeds the tree", async () => {
  let gpuActive = 0;
  let gpuMax = 0;
  let held = Promise.resolve();
  const slotLabels: string[] = [];
  const takeSlot = async (label: string) => {
    slotLabels.push(label);
    const prev = held;
    let free = () => {};
    held = new Promise<void>((r) => { free = r; });
    await prev;
    return free;
  };
  const fake: Runner = async (argv) => {
    const cmd = argv.at(-1) ?? "";
    const gpu = cmd.includes("gpu");
    if (gpu) gpuMax = Math.max(gpuMax, ++gpuActive);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (gpu) gpuActive--;
    return { code: 0, out: cmd.includes("swing") ? "METRIC: sigma 0.007\nVERDICT: supports\nEVIDENCE: log shows collapse" : "METRIC: 0 dumps\nVERDICT: falsifies\nEVIDENCE: x2 reward no change", err: "" };
  };
  const deps = { ...depsFor(world, fakeClock(T0), state.dir), run: fake };
  await deps.registry.write(lane);
  const branches = branchesFrom(["reward too small", "swing exploration collapsed", "value gap"], ["gpu reward x2", "gpu swing sigma log", "cpu value probe"], [1, 2], false);
  const r = await forkExplore(deps, lane, { metric: "dumps", branches, mode: "cmd", minutes: 1 }, takeSlot);
  expect(slotLabels).toHaveLength(2);
  expect(gpuMax).toBe(1);
  expect(r.table.split("\n")).toHaveLength(5);
  expect(r.table).toContain("| 2 | swing exploration collapsed | sigma 0.007 | supports |");
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.map((n) => `${n.text}=${n.status}`)).toEqual(["reward too small=falsified", "swing exploration collapsed=supported", "value gap=falsified"]);
  expect(((await deps.registry.read("rl-e7")) as Lane).explorations?.[0]?.branches).toBe(3);
  expect(parseBranch("done\nVERDICT: refuted").verdict).toBe("falsifies");
  expect(() => branchesFrom(["a"], ["t"], [], false)).toThrow("at least 2");
});

test("intent-check flags a direction that drifted from the owner's goal; a stage-change milestone tells the lead to run it", async () => {
  const empty: Tree = { area: "x", nodes: [] };
  const goal = "굴착기가 흙을 퍼서 적치띠에 덤프하는 정책을 학습";
  expect(intentView({ ...lane, goal, direction: { at: "t", text: "적치띠 덤프 보상 정책 학습 재개", next: "9-seed 평가" } }, empty, 0.12).verdict).toBe("INTENT_OK");
  expect(intentView({ ...lane, goal, direction: { at: "t", text: "rewrite the Discord bot README", next: "publish docs" } }, empty, 0.12).verdict).toBe("INTENT_DRIFT");
  const en = "make the excavator dump soil into the bank reliably";
  expect(intentView({ ...lane, goal: en, direction: { at: "t", text: "add a swing std floor so the policy keeps exploring the dump swing", next: "count dumps into the bank" } }, empty, 0.12).verdict).toBe("INTENT_OK");
  expect(intentView({ ...lane, goal: en, direction: { at: "t", text: "rewrite the README for the Discord bot", next: "publish docs" } }, empty, 0.12).verdict).toBe("INTENT_DRIFT");
  expect(intentView(lane, empty, 0.12).verdict).toBe("INTENT_NO_GOAL");
  const deps = depsFor(world, fakeClock(T0 + 60_000), state.dir);
  await deps.registry.write({ ...lane, goal });
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | phase 2 starts: switch to curriculum training\n\n❯ ";
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "intent_check");
  expect(acts).toHaveLength(1);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/freshness INTENT_CHECK rl-e7 /);
  expect(footer({ ...lane, goal }, "lead:p1")).toContain(`Goal (owner words): "${goal}"`);
});
