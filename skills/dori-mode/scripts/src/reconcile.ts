import type { SessionRef } from "./runtime/types.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import { aoeRefForLane, type BootSession } from "./sessions.ts";

const laneRef = (lane: Lane): SessionRef | ReturnType<typeof aoeRefForLane> => sessionOf(lane) ?? aoeRefForLane(lane.pane);

export type PaneState = "live" | "vanished" | "unassigned";

export const reconcilePanes = (
  lanes: readonly Lane[],
  sessions: readonly BootSession[],
): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(sessions.map((s) => `${s.ref.runtime}:${s.ref.id}`));
  const registered = new Set(lanes.flatMap((lane) => {
    const ref = laneRef(lane);
    return ref && statusOf(lane) !== "closed" ? [`${ref.runtime}:${ref.id}`] : [];
  }));
  return {
    lanes: lanes.map((lane) => {
      const ref = laneRef(lane);
      return {
        key: lane.key,
        status: statusOf(lane),
        pane: lane.pane ?? null,
        paneState: !ref ? "unassigned" : live.has(`${ref.runtime}:${ref.id}`) ? "live" : "vanished",
      };
    }),
    unregistered: sessions.filter((session) => !registered.has(`${session.ref.runtime}:${session.ref.id}`)).map((session) => session.ref.id),
  };
};
