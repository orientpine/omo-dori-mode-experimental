import type { FlowDeps } from "./done-flow.ts";
import { LANE_KEY, NO_THREAD, threadRefProblem } from "./registry.ts";
import { doneSyntaxErrors, weakDone } from "./done-signals.ts";
import { relatedLines, relatedThreads, type RelatedThread } from "./related-thread.ts";
import { type LaunchInput, LaunchError, NEW_THREAD, ThreadMissingError, RelatedThreadError } from "./launch-types.ts";

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  // backlog lanes are bl-<item>: no other launch takes such a key, so an ordinary lane never shares one with the backlog
  if (input.key.startsWith("bl-") && !input.backlog) throw new LaunchError(`key ${input.key}: keys starting with bl- belong to the backlog (dori backlog); pick another key`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  if (input.thread !== undefined && input.thread !== NO_THREAD && input.thread !== NEW_THREAD) {
    const problem = threadRefProblem(input.thread);
    if (problem) throw new LaunchError(`${problem}; pass --thread <adapter>:<id> or --thread ${NEW_THREAD}`);
  }
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

// The owner's long work gets a work thread (directive long-work-thread): a launch names the open thread the work continues
// in (--thread <ref>), has one opened in this Dori's own channel (--thread new), or says why the lane has none
// (--no-thread "<reason>", a lane the owner did not ask for). A channel is not a thread. dori adopt is not gated: it
// registers a session that is already running, an older lane without a thread among them.
export const threadGate = (deps: Pick<FlowDeps, "openThread" | "channels">, input: LaunchInput): void => {
  const threadless = input.thread === undefined || input.thread === NO_THREAD;
  if (input.whyNew !== undefined) {
    if (!input.whyNew.trim()) throw new LaunchError(`--why-new needs a reason: --why-new "<why this is not the work of the related threads>"`);
    if (input.thread !== NEW_THREAD) throw new LaunchError(`--why-new goes with --thread ${NEW_THREAD} only: it says why a new thread opens though related ones are open`);
  }
  if (input.noThread !== undefined) {
    if (!input.noThread.trim()) throw new LaunchError(`--no-thread needs a reason: --no-thread "<why this lane has no work thread>"`);
    if (!threadless) throw new LaunchError(`pass --thread or --no-thread "<reason>", not both`);
    return;
  }
  if (threadless)
    throw new ThreadMissingError(
      `LAUNCH_NO_THREAD ${input.key}: a lane opens with a work thread (the owner's long work gets one: directive long-work-thread); nothing was opened. Pass --thread <adapter>:<id> for the open thread this work continues, --thread ${NEW_THREAD} to open one in this Dori's own channel, or --no-thread "<reason>" for a lane the owner did not ask for.`,
    );
  if (input.thread === NEW_THREAD) {
    if (!deps.openThread) throw new LaunchError(`--thread ${NEW_THREAD} opens the work thread in this Dori's own channel and needs DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL; pass --thread <adapter>:<id> instead`);
    return;
  }
  const id = input.thread.startsWith("discord:") ? input.thread.slice("discord:".length) : "";
  if (id && deps.channels?.includes(id))
    throw new ThreadMissingError(`LAUNCH_THREAD_IS_CHANNEL ${input.key}: ${input.thread} is a channel, not a thread; nothing was opened. Pass --thread ${NEW_THREAD} to open a work thread in it, or the ref of a thread.`);
};

const readText = (path: string): Promise<string> => Promise.resolve().then(() => Bun.file(path).text()).catch(() => "");

// The open threads the lane's work may continue (src/related-thread.ts), from the registry and the briefs of its lanes.
export const relatedFor = async (deps: Pick<FlowDeps, "registry" | "config" | "clock" | "channels">, input: LaunchInput): Promise<RelatedThread[]> => {
  const lanes = await deps.registry.list();
  const briefs = new Map(await Promise.all(lanes.map(async (l) => [l.key, await readText(l.brief)] as const)));
  const brief = await readText(input.brief);
  return relatedThreads(lanes, { key: input.key, title: input.title, brief, cwd: input.cwd ?? deps.config.defaultCwd, ...(input.tags?.length ? { tags: input.tags } : {}) }, {
    now: deps.clock.now(),
    settings: deps.config.related,
    channels: deps.channels ?? [],
    defaultCwd: deps.config.defaultCwd,
    briefOf: (l) => briefs.get(l.key) ?? "",
  });
};

// Related lanes stay in one thread: --thread new shows the related open threads first (LAUNCH_RELATED_THREAD) and opens
// nothing until the lead passes --thread <ref> of one of them, or --why-new "<reason>" for work that is not theirs (that
// reason is kept in the registry and the watch log: LAUNCH_NEW_THREAD_WHY). Nothing is ever joined on its own: a wrong
// guess in someone else's thread is worse than a new one. Without related threads --thread new opens as before.
export const relatedGate = async (deps: Pick<FlowDeps, "registry" | "config" | "clock" | "channels">, input: LaunchInput): Promise<string[]> => {
  if (input.thread !== NEW_THREAD) return [];
  const found = await relatedFor(deps, input);
  const why = input.whyNew?.trim();
  if (!found.length) return why ? [`LAUNCH_NEW_THREAD_WHY ${input.key}: no related open thread; reason kept: ${why}`] : [];
  if (!why) throw new RelatedThreadError(relatedLines(input.key, found).join("\n"));
  return [`LAUNCH_NEW_THREAD_WHY ${input.key}: a new thread though ${found.length} related open thread(s) were found (${found.map((t) => t.thread).join(", ")}), on the lead's word: ${why}`];
};

// A warning, never a refusal: a Done line that only checks files or text proves the files are there, not that the work behaves.
export const doneWeakWarning = async (input: LaunchInput, cwd: string): Promise<string | undefined> => {
  if (input.doneWeakOk) return undefined;
  const weak = await weakDone(input.done, { cwd });
  return weak
    ? `LAUNCH_DONE_WEAK ${input.key}: every Done signal only checks files or text (${weak}). Add at least one that measures the behavior: a command that runs it or its tests (command ["bun","test"] stdout~" 0 fail"), or a url with status= and body~. --done-weak-ok silences this.`
    : undefined;
};
