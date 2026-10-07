import { AoeError, inputLine, openAoeSession, target } from "./aoe.ts";
import { type Backend, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { LANE_KEY, type Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors } from "./signals.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider|Model "[^"\n]*" not found|Pane is dead/i;

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

export const footer = (lane: Lane, leadPane: string, backend: Backend = "herdr"): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, sent to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
  ...(backend === "aoe" ? [`- The lead pane is a tmux session: run ["tmux","send-keys","-t","${target(leadPane || "(lead pane)")}","-l","--","<report line>"], then ["tmux","send-keys","-t","${target(leadPane || "(lead pane)")}","Enter"].`] : []),
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
  "",
].join("\n");

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", brief: input.brief, done: input.done, cwd, model, openedAt: iso(deps.clock) };
  await Bun.write(input.brief, `${(await briefFile.text()).replace(/\s*$/, "")}\n${footer(draft, deps.config.leadPane, deps.config.backend)}`);
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  const opened = deps.config.backend === "aoe" ? await openAoe(deps, input.key, cwd, model, prompt) : await openHerdr(deps, input.key, cwd, model, prompt);
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

const openAoe = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string): Promise<Opened> => {
  let pane: string;
  try {
    pane = await openAoeSession(deps.run, deps.clock, { title: key, cwd, tool: deps.config.agentCommand[0] ?? "omo", model });
  } catch (e) {
    if (e instanceof AoeError) throw new LaunchError(e.message);
    throw e;
  }
  const failure = await awaitPrompt(deps, pane);
  if (failure) return { pane, failure };
  if (!(await sendVerified(deps.run, deps.clock, "aoe", pane, prompt))) return { pane, failure: "the launch prompt did not register (text still in the input line)" };
  return { pane };
};

// The agent's ❯ prompt, or the first startup error on screen: an agent that exits at once never shows a prompt.
const awaitPrompt = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
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
