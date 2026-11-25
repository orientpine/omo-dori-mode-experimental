import { aoeSessions, aoeStates, QUESTION_MARK, sessionFor, WAKE_MARKS } from "./aoe.ts";
import { onDuty } from "./duty-line.ts";
import { herdrLife, isHerdrPane } from "./herdr.ts";
import { captureTmux } from "./pane-io.ts";
import { runtimesOf, type Runner } from "./run.ts";
import { parseRef } from "./runtime/types.ts";
import { turnRunning } from "./submit.ts";

export type Activity = "busy" | "running" | "waiting" | "error" | "question" | "idle";

// What each live pane's agent is doing, from aoe ps plus its screen. Panes aoe does not list are left out.
// A herdr pane has no such state: one whose agent runs is judged from its screen alone, idle when nothing shows.
// `failed` (https://github.com/sisyphuslabs/dori-superagent/pull/282): a hosted session the host could not answer for goes
// there with why and is left out, so one outage holds only its own lane; without it that error is thrown as before.
export const paneActivity = async (run: Runner, panes: readonly string[], config?: { readonly stateDir: string }, failed?: Map<string, string>): Promise<Map<string, Activity>> => {
  const out = new Map<string, Activity>();
  const tmuxPanes = panes.filter((p) => p && parseRef(p)?.runtime !== "omo-host" && !isHerdrPane(p));
  const [sessions, states] = tmuxPanes.length ? await Promise.all([aoeSessions(run), aoeStates(run)]) : [[], new Map<string, string>()];
  for (const pane of panes) {
    const ref = parseRef(pane);
    if (ref?.runtime === "omo-host") {
      const rt = runtimesOf(run, config).for(ref);
      try {
        if (await rt.observe?.(ref)) {
          const { activity } = await rt.probe(ref);
          if (activity) out.set(pane, activity);
        }
      } catch (e) {
        if (!failed) throw e;
        failed.set(pane, String(e).slice(0, 200));
      }
      continue;
    }
    const id = isHerdrPane(pane) ? ((await herdrLife(run, pane)).live ? pane : undefined) : sessionFor(sessions, pane)?.id;
    const state = id ? (isHerdrPane(pane) ? "idle" : states.get(id)) : undefined;
    if (!state) continue;
    const screen = await captureTmux(run, pane);
    if (turnRunning(screen)) out.set(pane, "busy");
    else if (state === "waiting" || state === "error") out.set(pane, state);
    else if (QUESTION_MARK.test(screen)) out.set(pane, "question");
    else if (WAKE_MARKS.some((m) => screen.includes(m)) || onDuty(screen)) out.set(pane, "running");
    else out.set(pane, state === "idle" ? "idle" : "running");
  }
  return out;
};
