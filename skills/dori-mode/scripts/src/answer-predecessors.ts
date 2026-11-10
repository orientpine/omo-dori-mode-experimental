import { existsSync, readFileSync } from "node:fs";

import type { FlowDeps } from "./done-flow.ts";
import { argvSessionLog, readHerdrSessions } from "./herdr-sessions.ts";
import { committedHandovers } from "./rollover-audit.ts";

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

// Identity comes from the live resolver, same-agent observations, or a committed move to this exact pane/session.
// A matching title, directory or filename alone never establishes a predecessor.
export const predecessorTranscripts = (deps: FlowDeps, lead: { readonly pane: string; readonly path: string; readonly text?: string }): string[] => {
  const current = header(lead.text ?? textAt(lead.path));
  if (!current) return [];
  const pending: Session[] = [{ ...current, pane: lead.pane }], seen = new Set([current.session]), texts: string[] = [];
  const records = readHerdrSessions(deps.config.stateDir), moves = committedHandovers(deps.config.stateDir);
  const add = (session: Session): void => {
    if (seen.has(session.session)) return;
    const path = session.log && existsSync(session.log) ? session.log : argvSessionLog([], deps.config.sessionsDir, session.cwd, session.session);
    if (!path) return;
    const text = textAt(path), identity = header(text);
    if (identity?.session !== session.session || identity.cwd !== session.cwd) return;
    seen.add(session.session); texts.push(text); pending.push(session);
  };
  const resolved = header(textAt(lead.path));
  if (resolved?.cwd === current.cwd) add({ ...resolved, pane: lead.pane, log: lead.path });
  for (let tip = pending.shift(); tip; tip = pending.shift()) {
    const kept = records[tip.pane];
    if (kept?.session === tip.session && kept.cwd === tip.cwd) for (const prior of kept.previous ?? []) add({ ...prior, pane: tip.pane });
    for (const move of moves) {
      if (move.who !== "lead" || move.to !== tip.pane || move.session !== tip.session) continue;
      const facts = json(textAt(move.note.replace(/\.md$/, ".json")));
      if (!facts || typeof facts !== "object" || !("from" in facts)) continue;
      const from = facts.from;
      if (!from || typeof from !== "object" || !("session" in from) || typeof from.session !== "string" || !("pane" in from) || typeof from.pane !== "string" || !("cwd" in from) || typeof from.cwd !== "string") continue;
      add({ session: from.session, pane: from.pane, cwd: from.cwd, ...("oldLog" in facts && typeof facts.oldLog === "string" ? { log: facts.oldLog } : {}) });
    }
  }
  return texts;
};
