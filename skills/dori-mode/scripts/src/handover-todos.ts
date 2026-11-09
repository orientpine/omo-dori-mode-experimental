// What a handover must carry beyond its monitors: the old session's open todos and the owner's words.
// ZzangDori's audit of 2026-11-02..08 (21 handovers): 5 todos left out (in the note, but the new session wrote a todo list
// of its own and the handover never looked, so only the audit after the commit found them) and 2 owner orders missing
// from the lead's note (relayed by OkDori and YooDori in the pair room, and the note kept only the owner's newest 8).
import { existsSync, readFileSync } from "node:fs";

import { flat } from "./restatement.ts";
import { sessionFile } from "./rollover.ts";

export type OwnerWord = { readonly at: string; readonly where: string; readonly text: string };

// the owner's messages a lead's note carries: all of the last OWNER_HOURS, newest last
export const OWNER_HOURS = 24;
// a Dori's post in the pair room handing over the owner's words: "형 원문 <link>" and his words in quotes (SKILL.md,
// pair-route and pair-owner-relay); the original is in the other Dori's channel, so this inbox has only the relay, which
// the note carries whole: a short quote ("배포 금지") or words outside the quotes can be the order (review of #416)
const RELAY = /원문/;
const LINK = /https:\/\/discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/;

export const recentOwnerWords = (inbox: string, ids: readonly string[], now: number): OwnerWord[] => {
  if (!ids.length || !existsSync(inbox)) return [];
  const out: OwnerWord[] = [];
  for (const line of readFileSync(inbox, "utf8").split("\n")) {
    let row: { ts?: string; author_id?: string; content?: string; transcript?: unknown; scope?: string; channel_id?: string; room?: string; id?: string };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const text = (row.content?.trim() || (typeof row.transcript === "string" ? row.transcript.trim() : "")).replace(/\s+/g, " ");
    const at = Date.parse(row.ts ?? "");
    if (!text || !row.author_id || !(at <= now && now - at <= OWNER_HOURS * 3_600_000)) continue;
    if (ids.includes(row.author_id)) out.push({ at: row.ts ?? "", where: `${row.scope ?? "?"} ${row.room ?? row.channel_id ?? "-"}, message ${row.id ?? "-"}`, text });
    else if (row.scope === "pair-bot" && RELAY.test(text)) {
      const link = LINK.exec(text)?.[0];
      out.push({ at: row.ts ?? "", where: `relayed in the pair room by ${row.author_id} (message ${row.id ?? "-"})${link ? `, the owner's original ${link}` : ""}`, text });
    }
  }
  return out;
};

// an open todo as a note lists it ("<phase>: <task> (<status>)"), without its phase and status
export const todoTask = (t: string): string => t.replace(/ \((in_progress|pending|blocked)\)$/, "").replace(/^[^:]{1,60}: /, "");

// every todo of a session (done ones too: a todo the new session finished was carried)
export const allTodos = (sessionDir: string, session: string): string[] => {
  const file = sessionFile(sessionDir, session);
  try {
    const last = file ? readFileSync(file, "utf8").split("\n").findLast((l) => l.includes('"senpi.todo-state"')) : undefined;
    const data = last ? (JSON.parse(last) as { data?: { phases?: { name?: string; tasks?: { content?: string }[] }[] } }).data : undefined;
    return (data?.phases ?? []).flatMap((p) => (p.tasks ?? []).map((t) => t.content ?? ""));
  } catch {
    return [];
  }
};

// the old session's open todos whose words no todo of the new session's list holds
export const missingTodos = (old: readonly string[], sessionDir: string, session: string): string[] => {
  const have = allTodos(sessionDir, session).map(flat);
  return old.map(todoTask).filter((t) => !have.some((h) => h.includes(flat(t))));
};
