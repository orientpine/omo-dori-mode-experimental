import { readFileSync } from "node:fs";
import { type AskPlace, type AskPlaceInput, askingLane } from "./ask-place.ts";

type Row = { id: string; channel_id: string; author_id: string; scope: string; ts: string; content: string };
const read = (file: string): string => {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
};
const links = (text: string): { channel: string; id: string }[] =>
  [...text.matchAll(/https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)\b/g)].map((m) => ({ channel: m[1] ?? "", id: m[2] ?? "" }));
const rows = (file: string): Row[] => read(file).split("\n").flatMap((line) => {
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    return r && ["id", "channel_id", "author_id", "scope", "ts", "content"].every((k) => typeof r[k] === "string") ? [r as Row] : [];
  } catch { return []; }
});

// Warn only with a local owner original, an explicitly scoped pair-bot relay, and a link tying that relay to this work.
// No network lookup: unseen originals, ambiguous wording, and unavailable briefs/inbox remain silent.
export const askRelayWarning = (input: AskPlaceInput, place: AskPlace, text: string, now = Date.now()): string | undefined => {
  if (!input.owner || !/(?:confirm|approv|shall (?:I|we)|should (?:I|we)|go ahead|확인|승인|할까|진행할까|올릴까)/i.test(text)) return undefined;
  // Outward approvals still require their card. Broad exemptions favor silence over a false recheck warning.
  if (/(?:send|mail|shar(?:e|ing)|invit|publish|post|발송|메일|전송|공유|초대|게시)/i.test(text)) return undefined;
  const lane = askingLane(input);
  const sameThread = lane && place.kind !== "channel" && place.thread !== null && lane.thread === `discord:${place.thread}`;
  const context = `${text}\n${sameThread ? read(lane.brief) : ""}`;
  const refs = links(context);
  if (!refs.length) return undefined;
  const inbox = rows(input.inbox);
  for (const relay of inbox) {
    if (relay.scope !== "pair-bot" || !relay.author_id || relay.author_id === input.owner) continue;
    if (!/(?:delegat(?:e|ed|ion)|scope\s*:|위임|맡(?:아|긴|기는)|범위\s*:)/i.test(relay.content)) continue;
    for (const origin of links(relay.content)) {
      if (!refs.some((r) => (r.id === relay.id && r.channel === relay.channel_id) || (r.id === origin.id && r.channel === origin.channel))) continue;
      const owner = inbox.findLast((r) => r.id === origin.id && r.channel_id === origin.channel);
      if (!owner || owner.author_id !== input.owner || !["channel", "thread", "pair", "mention"].includes(owner.scope)) continue;
      const at = Date.parse(owner.ts), relayedAt = Date.parse(relay.ts);
      if (!(now - at >= 0 && now - at < 24 * 60 * 60_000 && relayedAt >= at && relayedAt <= now)) continue;
      return `ASK_RELAY_RECHECK ask: confirmation card cites a scoped pair relay of an owner message less than 24h old; proceed within the delegated scope (directive pair-owner-relay; a warning for now, refusal to be reviewed on 2026-12-01)`;
    }
  }
  return undefined;
};
