// Sessions across every runtime the scripts talk to: one Runtimes registry, each stored ref answered by its own kind.
// From upstream dori-superagent #154 (https://github.com/sisyphuslabs/dori-superagent/pull/154, its sessions.ts, SUL-1.0:
// NOTICE); its listing and close are taken: the fork's submit flow (panes.ts submitToPane) delivers text, as before.
import type { Runtimes } from "./runtime/registry.ts";
import type { SessionInfo, SessionRef } from "./runtime/types.ts";
import { listAoePanes } from "./aoe.ts";
import type { Runner } from "./run.ts";

export type AoeSessionRef = { readonly runtime: "aoe"; readonly id: string; readonly group?: string };
export type BootSession = Omit<SessionInfo, "ref"> & { readonly ref: SessionRef | AoeSessionRef };
export const aoeRefForLane = (pane: string | undefined): AoeSessionRef | undefined =>
  pane?.startsWith("aoe_") && !pane.startsWith("aoe_term_") ? { runtime: "aoe", id: pane } : undefined;

export const listAoeSessions = async (run: Runner): Promise<BootSession[]> =>
  (await listAoePanes(run)).map((pane) => ({
    ref: { runtime: "aoe", id: pane.pane_id, group: pane.workspace_id },
    ...(pane.title ? { title: pane.title } : {}),
    ...(pane.cwd ? { cwd: pane.cwd } : {}),
    ...(pane.agent ? { agent: pane.agent } : {}),
  }));

// Every session of every runtime in use: the selected kind, each kind a registered lane lives on, and any kind built so
// far. group keeps only the sessions of that group (a herdr workspace, an hc dori.group label).
export const listSessions = async (rts: Runtimes, options: { readonly group?: string; readonly groups?: readonly string[]; readonly selected?: boolean; readonly lanes?: readonly { readonly sessionRef?: SessionRef | undefined }[] } = {}): Promise<SessionInfo[]> => {
  for (const lane of options.lanes ?? []) if (lane.sessionRef) rts.for(lane.sessionRef);
  // The selected kind is read last (upstream #159): a failed choice still lists every stored lane, and fails only when nothing else is.
  if (options.selected !== false) try {
    void rts.default;
  } catch (e) {
    if (rts.kinds().length === 0) throw e;
  }
  const out: SessionInfo[] = [];
  for (const kind of rts.kinds()) {
    const rt = rts.for({ runtime: kind, id: "" });
    const sessions = await rt.list(options.group === undefined ? undefined : { group: options.group });
    if (kind !== "hc" || !options.groups?.length) {
      out.push(...sessions);
      continue;
    }
    const groupById = new Map<string, string>();
    for (const group of options.groups) for (const session of await rt.list({ group })) groupById.set(session.ref.id, group);
    out.push(...sessions.map((session) => {
      const group = session.ref.group ?? groupById.get(session.ref.id);
      return { ...session, ref: { ...session.ref, ...(group ? { group } : {}) } };
    }));
  }
  return out;
};

// Closes a session through its own runtime: its tab (the container) when the ref has one, else the session alone; the line
// says which, as the herdr tab/pane close of a lane did before.
export const closeSession = async (rts: Runtimes, ref: SessionRef): Promise<string> => {
  const what = ref.container ? `tab ${ref.container}` : `pane ${ref.id}`;
  return rts.for(ref).close(ref, ref.container ? "container" : "session").then(() => `${what} closed`, () => `${what} not closed`);
};
