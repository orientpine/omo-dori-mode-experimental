// The end of a lead handover that rolled back (dori handover, automatic or not): the session the move opened is closed, so
// the lead is not seen in two windows (2026-11-11 11:28Z: an automatic move w9:p2 -> w9:p13 rolled back at its checks and
// left w9:p13 open beside the lead until the lead closed it by hand). The old lead stays the lead and is never closed here,
// nor is a session the routing still names; one left open is told it is not the lead.
import { closeAoeSession, isClosedLine } from "./aoe.ts";
import type { Runner } from "./run.ts";

export type RollBack = {
  readonly run: Runner;
  readonly routedPane: () => Promise<string>;
  readonly tell: (pane: string, text: string) => Promise<boolean>;
  readonly emit: (line: string) => void;
  /** the old lead, which stays the lead */
  readonly lead: string;
  /** the session the move opened */
  readonly pane: string;
  readonly why: string;
  /** the HANDOVER_FAIL line printed first, when the move failed before its checks */
  readonly fail?: string;
};

export const rollBackNew = async (r: RollBack): Promise<void> => {
  if (r.fail) r.emit(r.fail);
  const routed = await r.routedPane().catch(() => "");
  const keep = r.pane === r.lead ? "it is the old lead" : routed !== r.lead ? `the routed lead is still ${routed || "unreadable"}` : "";
  if (keep) r.emit(`HANDOVER_NEW_KEPT ${r.pane}: ${keep}, so it is not closed`);
  const closed = keep ? "" : await closeAoeSession(r.run, r.pane).catch((e: unknown) => `${r.pane} not closed: ${e instanceof Error ? e.message : String(e)}`);
  if (closed) r.emit(isClosedLine(closed) ? `HANDOVER_NEW_CLOSED ${closed}` : `HANDOVER_NEW_CLOSE_FAIL ${closed}`);
  if (isClosedLine(closed)) return r.emit(`HANDOVER_ROLLED_BACK ${r.lead} stays the lead; ${r.pane} is closed (its log stays)`);
  await r.tell(r.pane, `[LEAD] HANDOVER_ROLLED_BACK: the handover failed (${r.why}); ${r.lead} stays the lead. You are not the lead: do nothing more.`);
  r.emit(`HANDOVER_ROLLED_BACK ${r.lead} stays the lead; ${r.pane} did not close and is left open, told it is not the lead`);
};
