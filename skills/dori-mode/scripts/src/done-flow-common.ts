import type { FlowDeps } from "./done-flow-state.ts";
import type { Lane } from "./registry.ts";
import type { SignalIo } from "./done-signals.ts";

export const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

export const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

export const reopenedText = (key: string, why: string): string =>
  `[LEAD] your done claim for ${key} is taken back: ${why}. The lane is working again and does not close on a timer; when this work is done, claim again with dori claim-done ${key}.`;
