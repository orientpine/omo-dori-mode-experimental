// Ported from https://github.com/sisyphuslabs/dori-superagent/pull/282.
import type { FlowDeps } from "./done-flow-state.ts";
import { sessionOf, type Lane } from "./registry.ts";
import { closedMeanwhile } from "./sessions.ts";

export async function* lanesForFreshness(deps: FlowDeps): AsyncGenerator<Lane> {
  for (const lane of await deps.registry.open()) {
    const ref = sessionOf(lane);
    if (ref?.runtime !== "omo-host") {
      yield lane;
      continue;
    }
    if (await closedMeanwhile(deps, ref, lane.key)) continue;
    try {
      yield lane;
    } finally {
      await closedMeanwhile(deps, ref, lane.key);
    }
  }
}
