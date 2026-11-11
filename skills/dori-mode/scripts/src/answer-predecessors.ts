import { existsSync, readFileSync } from "node:fs";

import { sessionFor, type AoeSession } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import { currentTranscript } from "./current-transcript.ts";
import type { FlowDeps } from "./done-flow.ts";
import { argvSessionLog, readHerdrSessions } from "./herdr-sessions.ts";
import { committedHandovers } from "./rollover-audit.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Proc } from "./session-id.ts";

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

// Identity comes from the live resolver, exact same-session records (including a manual move to another pane),
// same-agent observations, or a committed move to this exact pane/session.
// A matching title, directory or filename alone never establishes a predecessor.
export const predecessorTranscripts = (deps: FlowDeps, lead: { readonly pane: string; readonly path: string; readonly text?: string }, target?: string): string[] => {
  const currentText = lead.text ?? textAt(lead.path), current = header(currentText);
  if (!current) return [];
  const pending: (Session & { readonly chain: readonly string[] })[] = [{ ...current, pane: lead.pane, chain: [currentText] }], seen = new Set([`${lead.pane}\0${current.session}`]), texts: string[] = [];
  const records = readHerdrSessions(deps.config.stateDir), moves = committedHandovers(deps.config.stateDir);
  const add = (session: Session, chain: readonly string[]): void => {
    const key = `${session.pane}\0${session.session}`;
    if (seen.has(key)) return;
    const text = sessionText(deps, session);
    if (!text) return;
    seen.add(key); if (!target || session.pane === target) texts.push(text, ...(target ? chain : [])); pending.push({ ...session, chain: [text, ...chain] });
  };
  const resolved = header(textAt(lead.path));
  if (resolved?.cwd === current.cwd) add({ ...resolved, pane: lead.pane, log: lead.path }, [currentText]);
  for (let tip = pending.shift(); tip; tip = pending.shift()) {
    const kept = records[tip.pane];
    if (kept?.session === tip.session && kept.cwd === tip.cwd) for (const prior of kept.previous ?? []) add({ ...prior, pane: tip.pane }, tip.chain);
    for (const [pane, prior] of Object.entries(records))
      if (pane !== tip.pane && prior.session === tip.session && prior.cwd === tip.cwd) add({ ...prior, pane }, tip.chain);
    for (const move of moves) {
      if (move.who !== "lead" || move.to !== tip.pane || move.session !== tip.session) continue;
      const facts = movedFrom(move.note);
      if (facts) add(facts.from, tip.chain);
    }
  }
  return texts;
};

// A lane's current pane can be gone too. Its registry identity and priorSessions bind the committed move to that
// lane; the facts bind the asking pane to an exact old session/log. A recorded card session can identify it directly.
export const lanePredecessorTranscripts = async (deps: FlowDeps, lanes: readonly Lane[], asking: { readonly pane: string; readonly at: number; readonly session?: string }, runtime: { readonly sessions: readonly AoeSession[]; readonly table: readonly Proc[] }): Promise<string[]> => {
  const texts = new Set<string>(), moves = committedHandovers(deps.config.stateDir), records = readHerdrSessions(deps.config.stateDir);
  for (const lane of lanes) {
    if (!lane.pane || !lane.cwd || !(Date.parse(lane.openedAt) <= asking.at) || statusOf(lane) === "closed" && !(asking.at <= Date.parse(lane.closedAt ?? ""))) continue;
    const prior = new Set(lane.priorSessions ?? []);
    if (asking.session && prior.has(asking.session)) {
      const kept = records[asking.pane], log = kept?.session === asking.session && kept.cwd === lane.cwd ? kept.log : undefined;
      const text = sessionText(deps, { pane: asking.pane, session: asking.session, cwd: lane.cwd, ...(log ? { log } : {}) });
      if (text) texts.add(text);
    }
    const live = sessionFor(runtime.sessions, lane.pane);
    const file = live ? await sessionFile(deps.run, deps.config.sessionsDir, lane.pane, live.path, runtime.table, deps.config.stateDir) : undefined;
    const kept = readHerdrSessions(deps.config.stateDir)[lane.pane];
    const owner = kept?.cwd === lane.cwd ? kept.session === lane.session ? kept : kept.previous?.find((prior) => prior.session === lane.session && prior.cwd === lane.cwd) : undefined;
    const current = lane.session ? sessionText(deps, { pane: lane.pane, session: lane.session, cwd: lane.cwd, ...(owner?.log ? { log: owner.log } : {}) }) : "";
    let chain = current ? [current] : [];
    if (file && current) {
      const text = currentTranscript(file, live?.title ?? ""), identity = header(text), resolved = header(textAt(file.path));
      if (identity?.cwd === lane.cwd && resolved?.cwd === lane.cwd && kept?.session === resolved.session && (resolved.session === lane.session || owner !== undefined)) chain = [text, ...predecessorTranscripts(deps, { pane: lane.pane, path: file.path, text }, lane.pane)];
    }
    const pending: { readonly pane: string; readonly chain: readonly string[] }[] = [{ pane: lane.pane, chain }], seen = new Set<string>();
    for (let tip = pending.pop(); tip; tip = pending.pop()) {
      if (seen.has(tip.pane)) continue;
      seen.add(tip.pane);
      for (const move of moves) {
        if (move.who !== "lane" || move.key !== lane.key || move.to !== tip.pane) continue;
        const facts = movedFrom(move.note);
        if (facts?.laneKey !== lane.key || !prior.has(facts.from.session)) continue;
        const text = sessionText(deps, facts.from);
        if (!text) continue;
        if (facts.from.pane === asking.pane) { texts.add(text); for (const successor of tip.chain) texts.add(successor); }
        pending.push({ pane: facts.from.pane, chain: [text, ...tip.chain] });
      }
    }
  }
  return [...texts];
};
