import { formatRef, type SessionInfo } from "./runtime/types.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";

export type PaneState = "live" | "vanished" | "unassigned";

export const reconcilePanes = (
  lanes: readonly Lane[],
  sessions: readonly SessionInfo[],
): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(sessions.map((s) => formatRef(s.ref)));
  const registered = new Set(lanes.flatMap((lane) => {
    const ref = sessionOf(lane);
    return ref && statusOf(lane) !== "closed" ? [formatRef(ref)] : [];
  }));
  return {
    lanes: lanes.map((lane) => {
      const ref = sessionOf(lane);
      return {
        key: lane.key,
        status: statusOf(lane),
        pane: lane.pane ?? null,
        paneState: !ref ? "unassigned" : live.has(formatRef(ref)) ? "live" : "vanished",
      };
    }),
    unregistered: sessions.filter((session) => !registered.has(formatRef(session.ref))).map((session) => session.ref.id),
  };
};
