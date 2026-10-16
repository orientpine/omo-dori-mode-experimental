// The new session's restatement after a handover (lane or lead): it writes what it understood under fixed headings, the
// handover checks that against its own records and the old session's summary, and fills in what was left out from the old
// conversation's log for a fixed number of rounds before the move is rolled back.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

import type { Clock } from "./run.ts";
import type { Supplement } from "./rollover.ts";

// What a restatement left out: the item, the heading it goes under ("" for the whole file) and where the handover got it.
// Items matched by words (a decision, a promise) are found in the old log by their longest words, the others by their text.
export type Missing = { readonly kind: string; readonly text: string; readonly under: string; readonly source: string; readonly byWords?: boolean };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const missingHeadings = (text: string, headings: readonly string[]): string[] => headings.filter((h) => !new RegExp(`^##\\s+${escape(h)}\\s*$`, "mi").test(text));

export const section = (text: string, heading: string): string => {
  const m = new RegExp(`^##\\s+${escape(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi").exec(text);
  return m?.[1]?.trim() ?? "";
};

// an escaped quote (\") counts as a plain one on both sides, so a quote inside a quote stays one line
export const flat = (s: string): string => s.replace(/\\"/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const QUOTE = /"((?:[^"\\\n]|\\.){6,})"|“([^”\n]{6,})”|「([^」\n]{6,})」/g;
export const quotesIn = (text: string): string[] => [...new Set([...text.matchAll(QUOTE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\"/g, '"').trim()).filter(Boolean))];
export const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? [])];
// the bullets under a heading without their "Why: ..." tail; one with fewer than 3 words is too short to check
export const bulletsIn = (text: string, heading: string): string[] =>
  section(text, heading).split("\n").map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.split(/\s+why:|\s+because\s/i)[0]?.trim() ?? "").filter((d) => words(d).length >= 3);
// a long quote counts when its first 80 characters are there
export const quoted = (all: string, s: string): boolean => all.includes(flat(s).slice(0, 80));
// a bullet counts when at least half of its words are there
export const covered = (all: string, s: string): boolean => {
  const ws = words(s);
  return ws.filter((x) => all.includes(x)).length * 2 >= ws.length;
};

// thinking signatures and encrypted blobs are base64: a short id such as Q1 is found in them by chance
const OPAQUE = /signature|encrypted/i;
const stringsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!OPAQUE.test(k)) stringsOf(x, out);
  return out;
};

// a lead's log runs to tens of MB: it is split once per file version, not once per item
let cached: { readonly file: string; readonly mtime: number; readonly lines: readonly string[] } | undefined;
const linesOf = (file: string): readonly string[] => {
  const mtime = statSync(file).mtimeMs;
  if (cached?.file !== file || cached.mtime !== mtime) cached = { file, mtime, lines: readFileSync(file, "utf8").split("\n") };
  return cached.lines;
};

// The old conversation's lines behind a left-out item (the owner's messages first): the supplement quotes them, so the
// new session gets the source, not only the old session's summary of it.
export const evidenceFor = (log: string | undefined, item: Missing, max = 2): string[] => {
  if (!log || !existsSync(log) || item.kind === "restatement" || item.kind === "heading") return [];
  const ws = item.byWords ? words(item.text) : [];
  const needle = (item.byWords ? [...ws].sort((a, b) => b.length - a.length)[0] ?? "" : item.text.slice(0, 60)).toLowerCase();
  if (!needle) return [];
  const raw = JSON.stringify(needle).slice(1, -1);
  // a short needle is a whole name (a lane key, a card id, a timer unit): Q1 must not match Q12
  const whole = !ws.length && needle.length < 12 ? new RegExp(`(^|[^\\p{L}\\p{N}_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_-])`, "iu") : undefined;
  const hits: { line: number; role: string; text: string }[] = [];
  linesOf(log).forEach((line, i) => {
    if (!line.toLowerCase().includes(raw)) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const s = stringsOf(obj).find((x) => (ws.length ? ws.filter((w) => x.toLowerCase().includes(w)).length * 2 >= ws.length : whole ? whole.test(x) : x.toLowerCase().includes(needle)));
    if (!s) return;
    const at = Math.max(0, s.toLowerCase().indexOf(needle));
    const a = Math.max(0, at - 100);
    const b = at + needle.length + 100;
    const o = obj as { message?: { role?: string }; type?: string };
    hits.push({ line: i + 1, role: o.message?.role ?? o.type ?? "?", text: `${a ? "…" : ""}${s.slice(a, b).replace(/\s+/g, " ").trim()}${b < s.length ? "…" : ""}` });
  });
  return [...hits.filter((h) => h.role === "user"), ...hits.filter((h) => h.role !== "user")].slice(0, max).map((h) => `old log line ${h.line} (${h.role}): "${h.text}"`);
};

const renderSupplement = (who: string, round: number, rounds: number, items: readonly Missing[], evidence: readonly string[][], understood: string, headings: readonly string[], ack: string): string =>
  [
    `# Supplement ${round}/${rounds} for the ${who} handover`,
    "",
    `Your restatement ${understood} left out what follows. It comes from the handover's own records and the old session's summary; the log lines are quoted from the old conversation (still on disk). Add each item to ${understood} under the heading named (the owner's words quoted exactly), keep the rest, then run: ${ack}`,
    "",
    ...items.flatMap((it, i) => [
      `## ${i + 1}. ${it.kind}: ${it.text}`,
      `Source: ${it.source}. Goes under: ${it.under ? `## ${it.under}` : `the whole file, with the headings ${headings.map((h) => `## ${h}`).join(", ")}`}.`,
      ...(evidence[i]?.length ? ["Evidence:", ...(evidence[i] ?? []).map((e) => `- ${e}`)] : ["Evidence: no matching line in the old log."]),
      "",
    ]),
  ].join("\n");

export const fmtMissing = (items: readonly Missing[]): string => items.map((it) => `${it.kind}: ${it.text.replace(/\s+/g, " ").slice(0, 80)}`).join("; ");

export type GapDeps = {
  readonly clock: Clock;
  readonly stateDir: string;
  readonly nonce: () => string;
  readonly tell: (pane: string, text: string) => Promise<boolean>;
  // the pane that acked an id, undefined while none did
  readonly ackedBy: (id: string) => string | undefined;
};

export type GapRun = { readonly who: string; readonly pane: string; readonly understood: string; readonly headings: readonly string[]; readonly rounds: number; readonly oldLog?: string; readonly check: (text: string) => Missing[]; readonly emit: (line: string) => void };

const POLL_MS = 5_000;
// how long the new session gets to answer one supplement round (polls of POLL_MS)
export const ROUND_TRIES = 36;

const readText = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

// A gap is filled in, not rolled back: the left-out items go to the new session with the old log lines behind them and it
// restates; only a gap that outlasts the rounds is a reason (it no longer takes in what it is given).
export const fillGaps = async (deps: GapDeps, r: GapRun): Promise<{ readonly reasons: string[]; readonly supplements: Supplement[]; readonly text: string }> => {
  const supplements: Supplement[] = [];
  let text = readText(r.understood);
  let left = r.check(text);
  for (let round = 1; round <= r.rounds && left.length; round++) {
    const evidence = left.map((it) => evidenceFor(r.oldLog, it));
    const sid = deps.nonce();
    const file = r.understood.replace(/\.understood\.md$/, `.supplement-${round}.md`);
    const ack = `dori handover ack ${sid} --state ${deps.stateDir}`;
    writeFileSync(file, renderSupplement(r.who, round, r.rounds, left, evidence, r.understood, r.headings, ack));
    supplements.push({ round, items: left.map((it) => ({ kind: it.kind, text: it.text })), evidence: evidence.flat().length, file });
    r.emit(`HANDOVER_SUPPLEMENT ${r.who} round ${round}/${r.rounds}: ${left.length} left out (${fmtMissing(left)}); ${file}`);
    if (!(await deps.tell(r.pane, `[LEAD] HANDOVER_SUPPLEMENT ${sid} (round ${round}/${r.rounds}): your restatement left out ${left.length} item(s). Read ${file}, add them to ${r.understood}, then run ${ack} and nothing else for this line.`)))
      return { reasons: [`the supplement ${sid} did not reach ${r.pane}`], supplements, text };
    let acked: string | undefined;
    for (let j = 0; j < ROUND_TRIES && acked === undefined; j++) {
      await deps.clock.sleep(POLL_MS);
      acked = deps.ackedBy(sid);
    }
    if (acked !== r.pane) return { reasons: [acked === undefined ? `no ack for the supplement ${sid}` : `the supplement ${sid} was acked from ${acked || "an unknown pane"}, not ${r.pane}`], supplements, text };
    text = readText(r.understood);
    left = r.check(text);
  }
  if (left.length) return { reasons: [`the new session's restatement ${r.understood} still leaves out after ${supplements.length} supplement round(s): ${fmtMissing(left)}`], supplements, text };
  if (supplements.length) r.emit(`HANDOVER_SUPPLEMENT_OK ${r.who} after ${supplements.length} round(s)`);
  r.emit(`HANDOVER_UNDERSTOOD ${r.understood}`);
  return { reasons: [], supplements, text };
};
