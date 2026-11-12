import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { OwnerRow } from "./lead-limit.ts";

// The owner messages LEAD_OWNER_WAITING (lead-limit.ts) counts as waiting on this lead. On 2026-11-12 the owner replied in
// #dori-pair to YooDori's digest failure post without calling anyone (1570293177615781901, called false); YooDori answered
// a minute later, MuDori, OkDori, ZzangDori and SooDori took their eyes off it, and ten minutes later their leads were
// woken for it anyway (owner, #dori-pair 1570295800460869673). Two kinds of message no longer wait on this lead:
// - a message this lead took its eyes off with dori eyes off, which says it will not answer it: eyesOff in
//   messenger/discord-listener.ts appends {ts, channel, id} to eyes-off.jsonl beside the inbox;
// - his pair-channel post that did not call this Dori and replies to another Dori's post (its reply_to is a pair-bot
//   row): a conversation with that Dori. A reply to this Dori's own post is called, so it never lands here.
// An uncalled post that replies to nobody still waits, even when other Doris answered it: "도리들아, ..." (1570002204117442661,
// called false) asked every Dori, so a lead that did not answer it is still owed.
export const EYES_OFF_FILE = "eyes-off.jsonl";

type InboxRow = { readonly id?: string; readonly scope?: string; readonly called?: boolean; readonly reply_to?: string | null };

const jsonLines = <T>(text: string): T[] => {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return out;
};

const eyesOffIds = (inboxPath: string): Set<string> => {
  const path = join(dirname(inboxPath), EYES_OFF_FILE);
  return new Set(jsonLines<{ id?: unknown }>(existsSync(path) ? readFileSync(path, "utf8") : "").flatMap((r) => (typeof r.id === "string" && r.id ? [r.id] : [])));
};

// inboxText: the inbox tail the rows were read from. A reply_to that points before the tail (the owner answered an older
// Dori post) is looked up in the whole inbox file, and only for those ids (review 2 of #466).
export const waitingOwnerRows = <T extends OwnerRow>(rows: readonly T[], inboxText: string, inboxPath: string): T[] => {
  const inbox = jsonLines<InboxRow>(inboxText);
  const replies = inbox.filter((r) => r.scope === "pair" && r.called === false && r.id && r.reply_to);
  const seen = new Set(inbox.flatMap((r) => (r.id ? [r.id] : [])));
  const before = new Set(replies.flatMap((r) => (r.reply_to && !seen.has(r.reply_to) ? [r.reply_to] : [])));
  const older = before.size && existsSync(inboxPath) ? jsonLines<InboxRow>(readFileSync(inboxPath, "utf8")).filter((r) => r.id && before.has(r.id)) : [];
  const otherDoris = new Set([...inbox, ...older].flatMap((r) => (r.scope === "pair-bot" && r.id ? [r.id] : [])));
  const toOtherDori = new Set(replies.flatMap((r) => (r.id && r.reply_to && otherDoris.has(r.reply_to) ? [r.id] : [])));
  const off = eyesOffIds(inboxPath);
  return rows.filter((row) => !off.has(row.id) && !toOtherDori.has(row.id));
};
