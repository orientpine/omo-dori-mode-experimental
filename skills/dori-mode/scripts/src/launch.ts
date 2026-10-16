import { AoeError, envMismatch, forwardEnv, inputLine, laneEnv, openAoeSession, target } from "./aoe.ts";
import { type Backend, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { LANE_KEY, type Lane, NO_THREAD, threadRefProblem } from "./registry.ts";
import { areaLabel, type AreaQuery, areaSignals, pastSignalsSection, tagsOf } from "./lane-signals.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors, weakDone } from "./done-signals.ts";
import { laneArea, loadTree, treeSection } from "./explore.ts";
import { watchLog } from "./watch-log.ts";
import { join } from "node:path";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly tags?: readonly string[];
  // launch without the LAUNCH_DONE_WEAK warning
  readonly doneWeakOk?: boolean;
  // the owner's goal in their own words, kept in the registry for dori intent-check
  readonly goal?: string;
  // big steps the lane must put through dori challenge first
  readonly challengeBefore?: readonly string[];
  // the lane needs the GPU: its sessions start without config launchEnv
  readonly useGpu?: boolean;
  // UI work: the owner's seven UI steps (references/ui-work.md) go at the top of the brief
  readonly ui?: boolean;
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider|Model "[^"\n]*" not found|Pane is dead/i;

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  if (input.thread !== undefined && input.thread !== NO_THREAD) {
    const problem = threadRefProblem(input.thread);
    if (problem) throw new LaunchError(`${problem}; pass --thread <adapter>:<id>, or leave --thread out`);
  }
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

// A warning, never a refusal: a Done line that only checks files or text proves the files are there, not that the work behaves.
export const doneWeakWarning = async (input: LaunchInput, cwd: string): Promise<string | undefined> => {
  if (input.doneWeakOk) return undefined;
  const weak = await weakDone(input.done, { cwd });
  return weak
    ? `LAUNCH_DONE_WEAK ${input.key}: every Done signal only checks files or text (${weak}). Add at least one that measures the behavior: a command that runs it or its tests (command ["bun","test"] stdout~" 0 fail"), or a url with status= and body~. --done-weak-ok silences this.`
    : undefined;
};

// The owner's seven UI steps: the block between the markers in references/ui-work.md, the one copy of their wording.
export const UI_WORK_DOC = join(import.meta.dir, "../../references/ui-work.md");
export const uiSteps = async (doc = UI_WORK_DOC): Promise<string> => {
  const m = /<!-- ui-steps:begin -->\n([\s\S]*?)\n<!-- ui-steps:end -->/.exec(await Bun.file(doc).text());
  if (!m?.[1]) throw new LaunchError(`no ui-steps block in ${doc}`);
  return m[1];
};

// The steps right after the first line when it is the ulw line, else at the very top; a brief that already has them is left alone.
export const withUiSteps = (brief: string, steps: string): string => {
  if (brief.includes(steps.split("\n")[0] ?? steps)) return brief;
  const lines = brief.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "")) return [...lines.slice(0, first + 1), "", steps, ...lines.slice(first + 1)].join("\n");
  return `${steps}\n\n${brief}`;
};

// The owner's eight steps (1. 조사 ... 8. 보고) of the brief template in references/sessions.md, the one copy of their wording.
export const SESSIONS_DOC = join(import.meta.dir, "../../references/sessions.md");
export const eightSteps = async (doc = SESSIONS_DOC): Promise<string> => {
  const template = /```text\n(ulw\n[\s\S]*?)```/.exec(await Bun.file(doc).text())?.[1] ?? "";
  const m = /^1\. 조사:[\s\S]*?^8\. 보고:[^\n]*$/m.exec(template);
  if (!m) throw new LaunchError(`no eight-step block (1. 조사: ... 8. 보고:) in the brief template of ${doc}`);
  return m[0];
};

const FIELD = /^\s*\[(?:목표|끝난 상태|사용자와 장면|넘으면 안 되는 선)\]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A brief with none of the eight step headings gets the whole block after the four fields (after the ulw line when it has
// no fields, else at the top); one with all eight is left alone; one with some of them is an edited frame: left as the
// lead wrote it, with a warning.
export const withEightSteps = (brief: string, steps: string): { readonly text: string; readonly added: boolean; readonly missing: readonly number[] } => {
  const heads = [...steps.matchAll(/^([1-8])\. ([^:\n]+):/gm)].map(([, n, name]) => ({ n: Number(n), re: new RegExp(`^\\s*${n}\\.\\s*${escapeRe(name ?? "")}\\s*:`, "m") }));
  const missing = heads.filter((h) => !h.re.test(brief)).map((h) => h.n);
  if (missing.length < heads.length) return { text: brief, added: false, missing };
  const lines = brief.split("\n");
  const lastField = lines.reduce((at, l, i) => (FIELD.test(l) ? i : at), -1);
  let at: number;
  if (lastField >= 0) {
    at = lastField + 1;
    while (at < lines.length && lines[at]?.trim()) at++;
  } else {
    const first = lines.findIndex((l) => l.trim());
    at = first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "") ? first + 1 : 0;
  }
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (after.length && !after[0]?.trim()) after.shift();
  const text = [...before, ...(before.length ? [""] : []), steps, ...(after.length ? ["", ...after] : [])].join("\n");
  return { text, added: true, missing };
};

export const stepsLine = (key: string, r: { readonly added: boolean; readonly missing: readonly number[] }): string | undefined =>
  r.added
    ? `LAUNCH_STEPS_ADDED ${key}: the brief had none of the owner's eight steps (1. 조사 ... 8. 보고, references/sessions.md); added them as written there, after the four fields.`
    : r.missing.length
      ? `LAUNCH_STEPS_PARTIAL ${key}: the brief has only some of the owner's eight steps (missing ${r.missing.join(", ")}); left as the lead wrote it, nothing added. Check that the edit was meant.`
      : undefined;

// Words that mark UI work. 화면 alone is not enough (a terminal screen, the template's "실제 화면·호출·출력"), and a word
// inside a hyphenated name (a lane key such as cytoplasm-pm-dashboard) does not count.
const UI_WORD = /(?<![\w-])(?:UI|UX|dashboard|front-?end|web ?page)(?![\w-])|대시보드|프론트엔드|디자인|웹 ?페이지|화면(?!·호출)/gi;

// A warning, never a refusal: the lead's brief reads like UI work (two UI words, one of them not 화면) and --ui is missing.
export const uiWarning = (input: LaunchInput, brief: string): string | undefined => {
  if (input.ui) return undefined;
  const hits = [...brief.matchAll(UI_WORD)].map((m) => m[0]);
  if (hits.length < 2 || hits.every((h) => h === "화면")) return undefined;
  return `LAUNCH_UI_HINT ${input.key}: the brief reads like UI work (${[...new Set(hits)].slice(0, 4).join(", ")}) but has no --ui, so the owner's seven UI steps (references/ui-work.md) are not in it. Launched as is; for UI work, launch with --ui.`;
};

export const footer = (lane: Lane, leadPane: string, backend: Backend = "herdr"): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, typed into ${backend === "aoe" ? "tmux session" : "pane"} ${leadPane || "(lead pane)"} with dori type, as an argv array, never a shell string: run ["dori","type","${leadPane || "(lead pane)"}","--text","<report line>"]. It prints SUBMITTED once the lead took it; NOT_SUBMITTED <reason> (exit 1) means it did not arrive: send it once more. Keep backticks and $( out of the text (dori type refuses them).`,
  `- A report that is a fix attempt for a failing check or metric carries (fix: <metric> / <hypothesis>). The lead's stuck ladder counts failed attempts on one metric, tagged or not: from the 2nd, competing hypotheses before the next patch; at the 3rd, ulw research and a dori challenge of your next plan (sent to you, in this session); after that, or with one hypothesis tried 3 times, the lead may move you to a new session. A blocker, an impossible or an ambiguous task is a fine report (| blocker |), better than another retry.`,
  `- Stuck after a fix that did not move the metric: before the next patch, write at least 3 competing hypotheses with one cheap discriminating test each, run the tests, and record what they showed (dori tree add|falsify|support --lane ${lane.key}). The lead's dori fix-attempt refuses a second attempt on one metric without them.`,
  ...(lane.goal ? [`- Goal (owner words): "${lane.goal}". At each stage change (a new phase, a pivot, before a big step) run dori intent-check ${lane.key} --direction "<what you do now>" --next "<next step>" (a reviewer model reads it against the owner's words) and say in your report how the step serves this goal.`] : []),
  ...(lane.challengeBefore?.length ? [`- Before ${lane.challengeBefore.map((s) => `"${s}"`).join(" or ")}: write the plan to a file and run dori challenge ${lane.key} --plan <file> (a model of another family reviews it); answer its reasons in your next report. A done claim is refused until a challenge is on record.`] : []),
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
  "",
].join("\n");

const intentFields = (input: LaunchInput): Partial<Lane> => ({ ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}), ...(input.challengeBefore?.length ? { challengeBefore: input.challengeBefore } : {}), ...(input.useGpu ? { useGpu: true } : {}) });

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

// Points an existing lane at another work thread, e.g. one made after the lane was launched.
export const setThread = async (deps: FlowDeps, lane: Lane, ref: string): Promise<string> => {
  const problem = threadRefProblem(ref);
  if (problem) throw new LaunchError(problem);
  await deps.registry.patch(lane.key, { thread: ref });
  return `THREAD_SET ${lane.key} ${lane.thread || "-"} -> ${ref}`;
};

// Marks whether a lane's sessions start without launchEnv. The running session keeps the environment it started with.
export const setGpu = async (deps: FlowDeps, lane: Lane, on: boolean): Promise<string> => {
  await deps.registry.patch(lane.key, { useGpu: on });
  return `GPU_SET ${lane.key} ${lane.useGpu ? "on" : "off"} -> ${on ? "on" : "off"}: applies from its next handover or restart; the running session keeps its environment`;
};

// env(1) arguments that restart a session the way dori opens it (setups/discord-aoe/self-restart.sh): NAME=VALUE for an
// open lane without --use-gpu, --unset=NAME for anything else (a GPU lane, the lead, a session no lane owns). Nothing
// when launchEnv is empty; otherwise its names go into tmux update-environment first.
export const launchEnvArgs = async (deps: FlowDeps, pane: string): Promise<string[]> => {
  const names = Object.keys(deps.config.launchEnv);
  if (!names.length) return [];
  const lane = (await deps.registry.list()).find((l) => l.pane === pane && l.status !== "closed");
  await forwardEnv(deps.run, names);
  // env(1) reads options only before the first NAME=VALUE (a later --unset=X would set a variable named "--unset")
  const env = Object.entries(laneEnv(deps.config.launchEnv, !lane || lane.useGpu));
  return [...env.filter(([, v]) => v === undefined).map(([name]) => `--unset=${name}`), ...env.flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${value}`]))];
};

// Earlier lanes in the same repo (a cwd other than the default one) or with a shared tag, for the new brief.
export const pastSignals = async (deps: FlowDeps, input: LaunchInput, cwd: string): Promise<string | undefined> => {
  const q: AreaQuery = { ...(cwd !== deps.config.defaultCwd ? { cwd } : {}), tags: tagsOf({ key: input.key, tags: input.tags }) };
  const list = await areaSignals(await deps.registry.list(), q, deps.config);
  return pastSignalsSection(areaLabel(q), list, deps.config.signals.launchLanes);
};

// The hypothesis trees of the new lane's area (its repo, else its first tag) and of its other tags, in compact form.
export const treeContext = async (deps: FlowDeps, draft: Lane): Promise<string | undefined> => {
  const main = laneArea(draft, deps.config);
  const areas = [main, ...tagsOf(draft).filter((t) => t !== main.tag).map((tag) => ({ tag }))];
  const trees = await Promise.all(areas.map((a) => loadTree(deps.config.stateDir, a)));
  return treeSection(trees, deps.config.explore.treeLines, `dori tree --lane ${draft.key}`);
};

const draftLane = (deps: FlowDeps, input: LaunchInput): Lane => ({
  key: input.key, title: input.title, thread: input.thread ?? "none", brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, model: input.model ?? deps.config.defaultModel,
  ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock),
});

// The brief as the lane will read it: the lead's text, then Past signals, the hypothesis tree, and the footer.
export const renderBrief = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly draft: Lane; readonly text: string; readonly steps?: string }> => {
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft = draftLane(deps, input);
  const past = await pastSignals(deps, input, draft.cwd ?? deps.config.defaultCwd);
  const tree = await treeContext(deps, draft);
  const eight = withEightSteps((await briefFile.text()).replace(/\s*$/, ""), await eightSteps());
  const lead = eight.text;
  const steps = stepsLine(input.key, eight);
  return { draft, ...(steps ? { steps } : {}), text: `${input.ui ? withUiSteps(lead, await uiSteps()) : lead}\n${past ? `${past}\n` : ""}${tree ? `${tree}\n` : ""}${footer(draft, deps.config.leadPane, deps.config.backend)}` };
};

// The first lines of the lead's brief (headings and blank lines left out), for the thread's first message.
export const briefSummary = (brief: string, lines = 4): string =>
  brief.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, lines).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)).join("\n");

// discord.laneStartText filled in; a line whose placeholder has nothing to fill (a lane without --goal) is left out.
export const laneStartText = (template: string, lane: Lane, brief: string): string => {
  const values: Record<string, string> = { title: lane.title, goal: lane.goal ?? "", brief: briefSummary(brief), done: lane.done, key: lane.key, pane: lane.pane ?? "" };
  const text = template
    .split("\n")
    .filter((line) => [...line.matchAll(/\{(\w+)\}/g)].every(([, k]) => !(k && k in values) || values[k]))
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m))
    .join("\n");
  return text.length > 1900 ? `${text.slice(0, 1899)}…` : text;
};

export const goalWarning = (input: LaunchInput): string | undefined =>
  input.goal?.trim() ? undefined : `LAUNCH_NO_GOAL ${input.key}: no --goal "<the owner's words>"; dori intent-check cannot compare the lane's direction with what the owner asked`;

export const launchLane = async (deps: FlowDeps, input: LaunchInput, warn: (line: string) => void = () => {}): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const weak = await doneWeakWarning(input, cwd);
  if (weak) {
    warn(weak);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: weak });
  }
  const hint = uiWarning(input, await Bun.file(input.brief).text().catch(() => ""));
  if (hint) {
    warn(hint);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: hint });
  }
  const { draft, text, steps } = await renderBrief(deps, input);
  if (steps) {
    warn(steps);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: steps });
  }
  await Bun.write(input.brief, text);
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  const opened = deps.config.backend === "aoe" ? await openAoe(deps, input.key, cwd, model, prompt, laneEnv(deps.config.launchEnv, input.useGpu)) : await openHerdr(deps, input.key, cwd, model, prompt);
  const lane: Lane = { ...draft, pane: opened.pane, ...(opened.tab ? { tab: opened.tab } : {}) };
  await deps.registry.write(lane);
  if (opened.failure) return { lane, startup: `STARTUP_ERROR ${input.key} ${opened.pane}: ${opened.failure}` };
  await deps.clock.sleep(20_000);
  const bad = STARTUP_FAILURE.exec(await readScreen(deps.run, deps.config.backend, opened.pane, 40));
  return { lane, startup: bad ? `STARTUP_ERROR ${input.key} ${opened.pane}: ${bad[0]}` : `STARTUP_OK ${input.key} ${opened.pane}` };
};

type Opened = { readonly pane: string; readonly tab?: string; readonly failure?: string };

const openHerdr = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string): Promise<Opened> => {
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const pane = made.root_pane.pane_id;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  await deps.run(["herdr", "pane", "run", pane, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" ")]);
  return { pane, ...(tab ? { tab } : {}) };
};

const openAoe = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string, env: Readonly<Record<string, string | undefined>>): Promise<Opened> => {
  let pane: string;
  try {
    pane = await openAoeSession(deps.run, deps.clock, { title: key, cwd, tool: deps.config.agentCommand[0] ?? "omo", model, env });
  } catch (e) {
    if (e instanceof AoeError) throw new LaunchError(e.message);
    throw e;
  }
  const failure = await awaitPrompt(deps, pane);
  if (failure) return { pane, failure };
  // a lane that missed launchEnv (the GPU guard) gets no prompt: it would start working with the GPU in reach
  const off = await envMismatch(deps.run, pane, env);
  if (off.length) return { pane, failure: `launchEnv not in the session: ${off.join(", ")}; the lane prompt was not sent` };
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, prompt))) return { pane, failure: "the launch prompt was not submitted (see NOT_SUBMITTED in the watch log)" };
  return { pane };
};

// The agent's ❯ prompt, or the first startup error on screen: an agent that exits at once never shows a prompt.
export const awaitPrompt = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  for (let i = 0; i < 90; i++) {
    const screen = await readScreen(deps.run, "aoe", pane);
    if (inputLine(screen) !== undefined) return undefined;
    const bad = STARTUP_FAILURE.exec(screen);
    if (bad) return bad[0];
    await deps.clock.sleep(2_000);
  }
  return "no ❯ prompt within 3 minutes";
};

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
