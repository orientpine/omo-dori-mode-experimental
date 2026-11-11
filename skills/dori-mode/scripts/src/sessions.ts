// Sessions across every runtime the scripts talk to: one Runtimes registry, each stored ref answered by its own kind.
// From upstream dori-superagent #154 (https://github.com/sisyphuslabs/dori-superagent/pull/154, its sessions.ts, SUL-1.0:
// NOTICE); its listing and close are taken: the fork's submit flow (panes.ts submitToPane) delivers text, as before.
import type { Runtimes } from "./runtime/registry.ts";
import type { RuntimeKind, SessionInfo, SessionRef } from "./runtime/types.ts";
import { aoeSessions, tmuxNameFor, type PaneLife } from "./aoe.ts";
import type { Runner } from "./run.ts";

export type AoeSessionRef = { readonly runtime: "aoe"; readonly id: string; readonly group?: string };
export type BootSession = Omit<SessionInfo, "ref"> & { readonly ref: SessionRef | AoeSessionRef };
export const aoeRefForLane = (pane: string | undefined): AoeSessionRef | undefined =>
  pane?.startsWith("aoe_") && !pane.startsWith("aoe_term_") ? { runtime: "aoe", id: pane } : undefined;

export const listAoeSessions = async (run: Runner): Promise<BootSession[]> => {
  const [sessions, listed] = await Promise.all([aoeSessions(run), run(["tmux", "ls", "-F", "#S"])]);
  if (listed.code !== 0) throw new Error(`tmux ls failed: ${listed.err || listed.out}`);
  const names = listed.out.split("\n").filter(Boolean);
  return sessions.flatMap((session) => {
    const name = tmuxNameFor(session, names);
    return name ? [{
      ref: { runtime: "aoe", id: name, group: session.profile ?? "aoe" },
      title: session.title,
      cwd: session.path,
      ...(session.tool ? { agent: session.tool } : {}),
    }] : [];
  });
};

export const probeAoeSession = async (run: Runner, pane: string): Promise<PaneLife> => {
  const result = await run(["tmux", "has-session", "-t", `=${pane}`]);
  if (result.code === 0) return { live: true };
  const detail = result.err || result.out;
  if (/can't find session|no such session|session not found/i.test(detail)) return { live: false, how: "gone" };
  throw new Error(`tmux has-session failed: ${detail || `exit ${result.code}`}`);
};

// Every session of every runtime in use: required kinds come from non-closed lanes, the selected kind and the lead;
// other stored runtimes are discovered best-effort so a retired server cannot abort boot. group keeps only one group.
export const listSessions = async (rts: Runtimes, options: { readonly group?: string; readonly groups?: readonly string[]; readonly selected?: boolean; readonly lead?: SessionRef; readonly requiredLanes?: readonly { readonly sessionRef?: SessionRef | undefined }[]; readonly lanes?: readonly { readonly sessionRef?: SessionRef | undefined }[] } = {}): Promise<SessionInfo[]> => {
  const required = new Set<RuntimeKind>();
  for (const lane of options.lanes ?? []) if (lane.sessionRef) rts.for(lane.sessionRef);
  for (const lane of options.requiredLanes ?? options.lanes ?? []) if (lane.sessionRef) required.add(lane.sessionRef.runtime);
  if (options.lead) {
    rts.for(options.lead);
    required.add(options.lead.runtime);
  }
  // The selected kind is read last (upstream #159): a failed choice still lists every stored lane, and fails only when nothing else is.
  if (options.selected !== false) try {
    required.add(rts.default.kind);
  } catch (e) {
    if (rts.kinds().length === 0) throw e;
  }
  const out: SessionInfo[] = [];
  for (const kind of rts.kinds()) try {
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
  } catch (error) {
    if (required.has(kind)) throw error;
  }
  return out;
};

// Closes a session through its own runtime: its tab (the container) when the ref has one, else the session alone; the line
// says which, as the herdr tab/pane close of a lane did before.
export const closeSession = async (rts: Runtimes, ref: SessionRef): Promise<string> => {
  const what = ref.container ? `tab ${ref.container}` : `pane ${ref.id}`;
  return rts.for(ref).close(ref, ref.container ? "container" : "session").then(() => `${what} closed`, () => `${what} not closed`);
};
