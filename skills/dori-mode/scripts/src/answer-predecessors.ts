import { existsSync, readFileSync } from "node:fs";

import type { FlowDeps } from "./done-flow.ts";
import { argvSessionLog, readHerdrSessions } from "./herdr-sessions.ts";
import { committedHandovers } from "./rollover-audit.ts";
import { type Lane, statusOf } from "./registry.ts";

type Session = { readonly session: string; readonly cwd: string; readonly pane: string; readonly log?: string };
const textAt = (path: string): string => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }
};
const json = (text: string): unknown => {
  try { return JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
};
const header = (text: string): { readonly session: string; readonly cwd: string } | undefined => {
  const value = json(text.split("\n", 1)[0] ?? "");
  return value && typeof value === "object" && "type" in value && value.type === "session" && "id" in value && typeof value.id === "string" && "cwd" in value && typeof value.cwd === "string" ? { session: value.id, cwd: value.cwd } : undefined;
};
const sessionText = (deps: FlowDeps, session: Session): string => {
  const path = session.log && existsSync(session.log) ? session.log : argvSessionLog([], deps.config.sessionsDir, session.cwd, session.session);
  if (!path) return "";
  const text = textAt(path), identity = header(text);
  return identity?.session === session.session && identity.cwd === session.cwd ? text : "";
};
const movedFrom = (note: string): { readonly from: Session; readonly laneKey?: string } | undefined => {
  const facts = json(textAt(note.replace(/\.md$/, ".json")));
  if (!facts || typeof facts !== "object" || !("from" in facts)) return undefined;
  const from = facts.from;
  if (!from || typeof from !== "object" || !("session" in from) || typeof from.session !== "string" || !("pane" in from) || typeof from.pane !== "string" || !("cwd" in from) || typeof from.cwd !== "string") return undefined;
  const lane = "lane" in facts ? facts.lane : undefined;
  return { from: { session: from.session, pane: from.pane, cwd: from.cwd, ...("oldLog" in facts && typeof facts.oldLog === "string" ? { log: facts.oldLog } : {}) }, ...(lane && typeof lane === "object" && "key" in lane && typeof lane.key === "string" ? { laneKey: lane.key } : {}) };
};

// Identity comes from the live resolver, same-agent observations, or a committed move to this exact pane/session.
// A matching title, directory or filename alone never establishes a predecessor.
export const predecessorTranscripts = (deps: FlowDeps, lead: { readonly pane: string; readonly path: string; readonly text?: string }, target?: string): string[] => {
  const current = header(lead.text ?? textAt(lead.path));
  if (!current) return [];
  const pending: Session[] = [{ ...current, pane: lead.pane }], seen = new Set([`${lead.pane}\0${current.session}`]), texts: string[] = [];
  const records = readHerdrSessions(deps.config.stateDir), moves = committedHandovers(deps.config.stateDir);
  const add = (session: Session): void => {
    const key = `${session.pane}\0${session.session}`;
    if (seen.has(key)) return;
    const text = sessionText(deps, session);
    if (!text) return;
    seen.add(key); if (!target || session.pane === target) texts.push(text); pending.push(session);
  };
  const resolved = header(textAt(lead.path));
  if (resolved?.cwd === current.cwd) add({ ...resolved, pane: lead.pane, log: lead.path });
  for (let tip = pending.shift(); tip; tip = pending.shift()) {
    const kept = records[tip.pane];
    if (kept?.session === tip.session && kept.cwd === tip.cwd) for (const prior of kept.previous ?? []) add({ ...prior, pane: tip.pane });
    for (const move of moves) {
      if (move.who !== "lead" || move.to !== tip.pane || move.session !== tip.session) continue;
      const facts = movedFrom(move.note);
      if (facts) add(facts.from);
    }
  }
  return texts;
};

// A lane's current pane can be gone too. Its registry identity and priorSessions bind the committed move to that
// lane; the facts bind the asking pane to an exact old session/log. A recorded card session can identify it directly.
export const lanePredecessorTranscripts = (deps: FlowDeps, lanes: readonly Lane[], asking: { readonly pane: string; readonly at: number; readonly session?: string }): string[] => {
  const texts = new Set<string>(), moves = committedHandovers(deps.config.stateDir), records = readHerdrSessions(deps.config.stateDir);
  for (const lane of lanes) {
    if (!lane.pane || !lane.cwd || !(Date.parse(lane.openedAt) <= asking.at) || statusOf(lane) === "closed" && !(asking.at <= Date.parse(lane.closedAt ?? ""))) continue;
    const prior = new Set(lane.priorSessions ?? []);
    if (asking.session && prior.has(asking.session)) {
      const kept = records[asking.pane], log = kept?.session === asking.session && kept.cwd === lane.cwd ? kept.log : undefined;
      const text = sessionText(deps, { pane: asking.pane, session: asking.session, cwd: lane.cwd, ...(log ? { log } : {}) });
      if (text) texts.add(text);
    }
    const pending = [lane.pane], seen = new Set<string>();
    for (let pane = pending.pop(); pane; pane = pending.pop()) {
      if (seen.has(pane)) continue;
      seen.add(pane);
      for (const move of moves) {
        if (move.who !== "lane" || move.key !== lane.key || move.to !== pane) continue;
        const facts = movedFrom(move.note);
        if (facts?.laneKey !== lane.key || !prior.has(facts.from.session)) continue;
        const text = sessionText(deps, facts.from);
        if (!text) continue;
        if (facts.from.pane === asking.pane) texts.add(text);
        pending.push(facts.from.pane);
      }
    }
  }
  return [...texts];
};
