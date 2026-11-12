import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { laneEnv } from "./aoe.ts";
import { laneHomeEnv } from "./home-env.ts";
import { TokenFileError } from "./slack-token.ts";
import type { FlowDeps } from "./done-flow.ts";
import { omoSession, readScreen } from "./panes.ts";
import type { Lane } from "./registry.ts";
import { Reports } from "./reports.ts";
import { watchLog } from "./watch-log.ts";
import { assignArm } from "./compaction-keep.ts";
import { type LaunchInput, LaunchError, LaunchFailed, NEW_THREAD, ThreadMissingError, DirectiveMissingError } from "./launch-types.ts";
import { failureOf, startupGoal, openHerdr, openAoe } from "./launch-startup.ts";
import { validateLaunch, threadGate, relatedGate, doneWeakWarning } from "./launch-gates.ts";
import { aoeStartup } from "./launch-screen.ts";
import { STARTUP_CHECK_MS, startupRechecks } from "./pending-goal.ts";
import { briefAnchor } from "./launch-footer.ts";
import { reopenLaneThread } from "./launch-state.ts";
import { renderBrief } from "./launch-render.ts";
import { resolveLeadModel } from "./lane-model.ts";
import { HcStartupError } from "./hc-pane.ts";
import { HerdrStartupError } from "./herdr.ts";

export const launchLane = async (deps: FlowDeps, input: LaunchInput, warn: (line: string) => void = () => {}): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  let related: string[];
  try {
    threadGate(deps, input);
    related = await relatedGate(deps, input);
  } catch (e) {
    if (e instanceof ThreadMissingError) watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: e.message });
    throw e;
  }
  // no --model: the lead's model as the backlog's quota check chose it, else resolved now; never a default-model lane on herdr
  const leadPane = deps.config.leadPane || "<unset>";
  const model = input.model ?? input.leadModel ?? await resolveLeadModel(deps.run, deps.config).catch((e: unknown) => {
    throw new LaunchError(`LAUNCH_LEAD_MODEL_MISSING ${leadPane}: could not read the current lead session model (${e instanceof Error ? e.message : String(e)}); defaultModel is not used`);
  });
  if (!model) throw new LaunchError(`LAUNCH_LEAD_MODEL_MISSING ${leadPane}: no model in the current lead session transcript or herdr-sessions record; defaultModel is not used, so pass --model or restore the lead record`);
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const weak = await doneWeakWarning(input, cwd);
  if (weak) {
    warn(weak);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: weak });
  }
  const rendered = await renderBrief(deps, input);
  const { steps, lines, missing } = rendered;
  let { draft, text } = rendered;
  const threadless = input.noThread?.trim() ? [`LAUNCH_THREADLESS ${input.key}: no work thread, on the lead's word: ${input.noThread.trim()}`] : [];
  for (const line of [...lines, ...(steps ? [steps] : []), ...missing, ...threadless, ...related]) {
    warn(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
  }
  if (missing.length) throw new DirectiveMissingError(missing);
  // the token env is checked here, before any thread or session, so a refused token file (another home's, a missing
  // named one, a bad DORI_CONFIG) stops the launch with nothing opened (upstream #219, token stack)
  let home: Record<string, string>;
  try {
    home = laneHomeEnv(deps.config);
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  // opened only once nothing else can stop the launch, so a refused launch leaves no empty thread behind
  let openedThread: string | undefined;
  if (input.thread === NEW_THREAD && deps.openThread) {
    const ref = await deps.openThread(input.title);
    openedThread = ref;
    const line = `THREAD_OPENED ${input.key} ${ref}: the lane's work thread, new in this Dori's channel (--thread ${NEW_THREAD})`;
    warn(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
    // the same choice, not a second call that may choose otherwise
    const { pick, pickFallback } = draft.directives ?? {};
    ({ draft, text } = await renderBrief(deps, { ...input, thread: ref, pick: { ...(pick ? { pick } : {}), ...(pickFallback ? { pickFallback } : {}) } }));
  }
  await Bun.write(input.brief, text);
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${resolve(input.brief)} in full. You are the ${input.key} lane; report as the brief's footer says. ${briefAnchor({ ...draft, brief: resolve(input.brief) }, text)}`;
  // a model reply older than this is not an answer to this launch (a resumed session holds earlier ones)
  const launchedAt = deps.clock.now();
  // Footer commands resolve this launching home even when the runtime core inherited another (#197); these win over launchEnv (herdr and hc).
  const env = { ...laneEnv(deps.config.launchEnv, input.useGpu), ...home };
  let registered = false;
  const beforeStart = async ({ pane, tab }: { readonly pane: string; readonly tab?: string }): Promise<void> => {
    const pending: Lane = { ...draft, reportProtocol: "jsonl-v1", pane, ...(tab ? { tab } : {}) };
    await deps.registry.write(pending);
    registered = true;
    new Reports(deps.config.stateDir).append({ type: "activity", key: pending.key, at: new Date(deps.clock.now()).toISOString(), state: "running", text: `lane launched in ${pane}` });
  };
  const opened = await (deps.config.backend === "aoe"
    ? openAoe(deps, input.key, cwd, model, prompt, env, async (pane) => beforeStart({ pane }))
    : openHerdr(deps, input.key, cwd, model, prompt, env, beforeStart)
  ).catch(async (e: unknown) => {
    if (registered && deps.config.backend !== "aoe" && (e instanceof HcStartupError || e instanceof HerdrStartupError) && e.rollback) {
      rmSync(deps.registry.path(input.key), { force: true });
      rmSync(new Reports(deps.config.stateDir).path(input.key), { force: true });
    }
    throw e instanceof LaunchFailed && openedThread ? new LaunchFailed(e.message, openedThread) : e;
  });
  const arm = assignArm(deps.config, input.key, draft.tags ?? [], deps.clock.now());
  const lane: Lane = { ...draft, model, reportProtocol: "jsonl-v1", pane: opened.pane, ...(opened.tab ? { tab: opened.tab } : {}), ...(opened.session ? { session: opened.session, sessionVia: "launch" } : {}), ...(arm ? { trialArm: arm } : {}) };
  await deps.registry.write(lane);
  if (!registered) new Reports(deps.config.stateDir).append({ type: "activity", key: lane.key, at: new Date(deps.clock.now()).toISOString(), state: "running", text: `lane launched in ${lane.pane ?? "unknown"}` });
  // registered first, so the queue counts this lane as working in the thread; a thread --thread new just opened is 🔄 already
  if (input.thread !== NEW_THREAD) {
    const reopened = await reopenLaneThread(deps, lane);
    if (reopened) warn(reopened);
  }
  if (opened.failure) return { lane, startup: `STARTUP_ERROR ${input.key} ${opened.pane}: ${opened.failure}` };
  const prompted = deps.clock.now();
  await deps.clock.sleep(STARTUP_CHECK_MS);
  const screen = await readScreen(deps.run, deps.config.backend, opened.pane, 40);
  const failure = (shown: string): string | undefined => failureOf(deps, shown, cwd, opened.session ?? "", launchedAt);
  const bad = failure(screen);
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${opened.pane}: ${bad}` };
  // one start wait for an agent slow to come up, its ❯ prompt and then its first turn (#202)
  const recheck = startupRechecks(deps);
  const started = omoSession(deps.config) ? await aoeStartup(deps, input.key, opened.pane, screen, failure, recheck, prompted) : `STARTUP_OK ${input.key} ${opened.pane}`;
  if (!started.startsWith("STARTUP_OK")) return { lane, startup: started };
  return { lane, startup: (await startupGoal(deps, input.key, opened.pane, cwd, opened.session ?? "", launchedAt, prompted, recheck)) ?? started };
};
export { validateLaunch } from "./launch-gates.ts";
export { keptModel, laneModel, modelMove, moveThinking } from "./lane-model.ts";
export { threadGate } from "./launch-gates.ts";
export { relatedFor } from "./launch-gates.ts";
export { relatedGate } from "./launch-gates.ts";
export { doneWeakWarning } from "./launch-gates.ts";
export { launchLedger } from "./launch-state.ts";
export { laneRepo } from "./launch-state.ts";
export { adoptLane } from "./launch-state.ts";
export { reopenLaneThread } from "./launch-state.ts";
export { setThread } from "./launch-state.ts";
export { setDone } from "./launch-state.ts";
export { setGpu } from "./launch-state.ts";
export { launchEnvArgs } from "./launch-state.ts";
export { withSessionId } from "./launch-startup.ts";
export { awaitPrompt } from "./launch-startup.ts";

export * from "./launch-types.ts";
export * from "./launch-screen.ts";
export * from "./launch-footer.ts";
export * from "./launch-context.ts";
export * from "./launch-render.ts";
