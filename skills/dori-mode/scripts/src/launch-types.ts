import { StartRefused } from "./backlog.ts";
import type { DirectivePick } from "./directives.ts";
import type { BudgetLimits } from "./supervision.ts";

export type LaunchInput = {
  // what the small model already chose for this launch (a second render with the new thread's ref)
  readonly pick?: { readonly pick?: DirectivePick; readonly pickFallback?: string };
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  // the work thread: <adapter>:<id> of the thread the work continues in, or NEW_THREAD for one launch opens in this Dori's channel
  readonly thread?: string | undefined;
  // lane caps over the config's (launch --wall-minutes N|none --token-limit N|none --cost-limit N|none) and extra activity files
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  // why the lane has no work thread (dori launch --no-thread "<reason>"): only a lane the owner did not ask for
  readonly noThread?: string | undefined;
  // why --thread new opens a new thread though related open threads were shown (dori launch --why-new "<reason>")
  readonly whyNew?: string | undefined;
  readonly model?: string | undefined;
  // the lead's model the backlog already chose for this launch and checked the quota of (resolveLeadModel); not pinned
  readonly leadModel?: string | undefined;
  readonly cwd?: string | undefined;
  readonly tags?: readonly string[];
  // launch without the LAUNCH_DONE_WEAK warning
  readonly doneWeakOk?: boolean;
  // the owner's goal in their own words, kept in the registry for dori intent-check
  readonly goal?: string | undefined;
  // big steps the lane must put through dori challenge first
  readonly challengeBefore?: readonly string[];
  // the lane needs the GPU: its sessions start without config launchEnv
  readonly useGpu?: boolean;
  // UI work: the owner's seven UI steps (references/ui-work.md) go at the top of the brief
  readonly ui?: boolean;
  // directive id -> the lead's reason: dori launch --waive <id> "<reason>" leaves that directive of the ledger out
  readonly waive?: Readonly<Record<string, string>>;
  // started by the backlog pass (dori backlog), the only launch that may use a "bl-" key
  readonly backlog?: boolean;
};

export class LaunchError extends Error {}
// The session could not be opened (the terminal backend failed): worth another try, unlike every other LaunchError, which
// the launch input itself causes and which no retry changes.
export class LaunchFailed extends LaunchError {
  // the work thread this launch had already opened (--thread new): the next try continues there instead of opening another
  constructor(message: string, readonly thread?: string) {
    super(message);
  }
}

/** A launch error as the backlog pass sees it: a refusal holds the item at once, an operational failure is tried again. */
export const asStartFailure = (e: unknown): unknown => (e instanceof LaunchError && !(e instanceof LaunchFailed) ? new StartRefused(e.message) : e);

// --thread new: dori launch opens the lane's work thread in this Dori's own channel (deps.openThread), named for --title
export const NEW_THREAD = "new";

// A launch with no work thread and no --no-thread reason, or a channel as its thread: nothing was opened, written or registered.
export class ThreadMissingError extends LaunchError {}

// --thread new while related open threads exist and no --why-new: the LAUNCH_RELATED_THREAD lines; nothing was opened.
export class RelatedThreadError extends ThreadMissingError {}

// A require directive of the ledger the brief does not meet: nothing was opened, written or registered.
export class DirectiveMissingError extends LaunchError {
  constructor(readonly lines: readonly string[]) {
    super(lines.join("\n"));
  }
}
