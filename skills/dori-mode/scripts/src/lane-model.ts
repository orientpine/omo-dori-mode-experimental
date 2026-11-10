import type { DoriConfig } from "./config.ts";
import { readHerdrSessions } from "./herdr-sessions.ts";
import { splitModel } from "./lane-handover.ts";
import type { Lane } from "./registry.ts";

// A lane runs its lead's model (owner 2026-11-10: "각 리드 하위의 레인들이 리드와 동일한 모델을 쓰도록 해줘"): dori launch without
// --model and every dori handover --lane (by hand or automatic) start it on the lead's model of then, so a lead moved to
// another model (/model) takes its lanes along at their next start. A lane whose model was chosen
// for it (launch or handover --lane --model) carries modelPinned and keeps that model.

// The model and thinking the lead runs now ("<provider>/<model>:<level>"), as dori lead and dori watch's lead check last
// read it from its session (herdr-sessions.json); undefined while none is recorded (an aoe lead, a lead not read yet).
export const leadModel = (config: Pick<DoriConfig, "stateDir" | "leadPane">): string | undefined =>
  (config.leadPane ? readHerdrSessions(config.stateDir)[config.leadPane]?.model : undefined) || undefined;

// The model a lane's new session starts with: the one chosen now, else the lead's of now (lead: true) unless the lane's own
// was chosen, else the lane's own.
export const laneModel = (config: Pick<DoriConfig, "stateDir" | "leadPane" | "defaultModel">, lane: Pick<Lane, "model" | "modelPinned">, chosen?: string): { readonly model: string; readonly lead: boolean } => {
  const lead = !chosen && !lane.modelPinned ? leadModel(config) : undefined;
  return { model: chosen || lead || lane.model || config.defaultModel, lead: !!lead };
};

// What the registry records once a lane's new session runs base at thinking: that model, and the mark when it was chosen.
export const keptModel = (lane: Pick<Lane, "modelPinned">, base: string, thinking: string | undefined, chosen?: string): Pick<Lane, "model" | "modelPinned"> =>
  ({ model: `${base}${thinking ? `:${thinking}` : ""}`, ...(chosen || lane.modelPinned ? { modelPinned: true } : {}) });

// The registry's model before a move and after it, kept on the move's pending record: a move interrupted after the registry
// took the new model goes back to the old one with the old pane, or keeps the new one with the new pane (recover).
export const modelMove = (lane: Pick<Lane, "model" | "modelPinned">, base: string, thinking: string | undefined, chosen?: string): { readonly was: Pick<Lane, "model" | "modelPinned">; readonly to: Pick<Lane, "model" | "modelPinned"> } =>
  ({ was: { ...(lane.model ? { model: lane.model } : {}), modelPinned: !!lane.modelPinned }, to: keptModel(lane, base, thinking, chosen) });

// An omo agent's argv with a model's level as its own --thinking, the way a handover starts one (aoe.ts herdrAgentArgv: omo
// can start at another level than a :suffix says): "--model p/m:high" becomes "--model p/m --thinking high", and a
// --thinking of the template gives way. A model with no level leaves the argv as it is.
export const withThinking = (argv: readonly string[], model: string): string[] => {
  const { base, thinking } = splitModel(model);
  if (!thinking) return [...argv];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--thinking") i++;
    else if (a.startsWith("--thinking=")) continue;
    else if (a === "--model" && argv[i + 1] === model) (out.push(a, base, "--thinking", thinking), i++);
    else if (a === `--model=${model}`) out.push(`--model=${base}`, "--thinking", thinking);
    else out.push(a);
  }
  return out;
};
