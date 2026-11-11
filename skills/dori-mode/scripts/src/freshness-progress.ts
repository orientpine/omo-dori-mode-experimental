import type { FlowDeps } from "./done-flow.ts";
import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";
import type { SweepAct } from "./freshness-handover.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { HUNG_MESSAGE, laneSessionUsage, Supervision } from "./supervision.ts";

// What the lead reads when a lane reaches a cap, looks hung, or has a cap that cannot be checked. The lane itself is never
// stopped, closed or typed into: the lead decides (the owner's rule that a running lane never stops without him knowing).
export const supervisionNote = (lane: Lane, message: string, settings: DoriConfig["supervision"]): string =>
  message === HUNG_MESSAGE
    ? `[DORI] ${lane.key}: a Working/Running call on its screen has gone on ${settings.hungAfterMinutes}+ min with no new report, checkpoint or file change for ${settings.staleAfterMinutes} min, so it may be hung. Nothing was sent to the lane; look at pane ${lane.pane ?? "?"}.`
    : / ceiling reached /.test(message)
      ? `[DORI] ${lane.key}: ${message} (dori caps ${lane.key} shows its caps). The lane was not stopped or told. Decide: let it go on (raise or clear the cap: dori caps ${lane.key} --wall-minutes N|none --token-limit N|none --cost-limit N|none), tell it to wrap up, or close it.`
      : `[DORI] ${lane.key}: ${message} (no omo transcript for pane ${lane.pane ?? "?"} and supervision.usageArgv is unset), so that cap is not checked.`;

// Lane caps and hung calls (src/supervision.ts) for one working lane: each new alert goes to the lead once; one that did
// not arrive is sent again on the next sweep. A supervision failure skips only this lane's check and prints once per reason.
export const superviseLane = async (deps: FlowDeps, lane: Lane): Promise<SweepAct[]> => {
  const settings = deps.config.supervision;
  const lead = deps.config.leadPane;
  const told = new Map<string, string>();
  const supervision = new Supervision({
    stateDir: deps.config.stateDir, run: deps.run, clock: deps.clock, sessionUsage: laneSessionUsage(deps.run, deps.config.sessionsDir),
    alert: async (l, message) => {
      if (!lead) {
        told.set(message, "lead not told: leadPane is not configured; sent again next sweep");
        return false;
      }
      const ok = await sendVerified(deps.run, deps.clock, deps.config, lead, supervisionNote(l, message, settings));
      told.set(message, ok ? "lead told" : `lead not told: the note did not reach pane ${lead}; sent again next sweep`);
      return ok;
    },
  }, settings);
  try {
    const screen = settings.hungAfterMinutes > 0 && lane.pane ? await readScreen(deps.run, deps.config.backend, lane.pane, 40) : "";
    const r = await supervision.sweep(lane, screen);
    if (lane.supervisionError) await deps.registry.patch(lane.key, { supervisionError: undefined });
    return [...(r.reset ? [{ kind: "supervision_error" as const, lane: lane.key, detail: r.reset }] : []), ...r.alerts.map((message): SweepAct => ({
      kind: message === HUNG_MESSAGE ? "stalled" : r.capped.includes(message) ? "lane_cap" : "usage_unknown",
      lane: lane.key,
      detail: `${message}; ${told.get(message) ?? "lead not told"}`,
    }))];
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (detail === lane.supervisionError) return [];
    await deps.registry.patch(lane.key, { supervisionError: detail });
    return [{ kind: "supervision_error", lane: lane.key, detail }];
  }
};
