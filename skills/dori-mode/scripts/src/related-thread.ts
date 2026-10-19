import { leadText } from "./directives.ts";
import type { Lane } from "./registry.ts";

// dori launch --thread new: the open work threads a new lane's work may continue, so related lanes stay in one thread.
// A thread is open while one of its lanes is open or one closed less than recentH hours ago. A candidate shows when the
// brief links an owner message that is in that thread or that one of its lanes' briefs links too (the strongest signs:
// first), or when its title and brief share enough rare words with one of the thread's lanes (minScore, TF-IDF cosine
// over the registry, plus 0.15 when the brief uses that lane's ~/.dori/qa/<key>/ folder and 0.05 for a shared --tag).
// The lane's name in the brief, its cwd and how recent it is are shown as evidence and add nothing. Up to max threads.
export type RelatedSettings = { readonly recentH: number; readonly minScore: number; readonly max: number };

export type RelatedQuery = { readonly key: string; readonly title: string; readonly brief: string; readonly cwd: string; readonly tags?: readonly string[] };

export type RelatedThread = {
  readonly thread: string;
  readonly title: string;
  readonly lanes: readonly string[];
  readonly score: number;
  // 2: an owner message the brief links is in this thread; 1: a lane of it links the same message; 0: words only
  readonly link: 0 | 1 | 2;
  readonly reasons: readonly string[];
};

export type RelatedContext = {
  readonly now: number;
  readonly settings: RelatedSettings;
  // ids of channels (this Dori's own, pair, watch): an older lane with a channel as its thread is no thread to continue
  readonly channels: readonly string[];
  readonly defaultCwd: string;
  // the brief text of a registered lane, "" when it cannot be read
  readonly briefOf: (lane: Lane) => string;
};

const EIGHT_STEPS = /^1\. 조사:[\s\S]*?^8\. 보고:[^\n]*$/m;
// The words that say what the work is: the lead's text without what dori launch put in (the ledger block, the eight
// steps, past signals, tree and footer).
export const workText = (brief: string): string => leadText(brief).replace(EIGHT_STEPS, "");

const LINK = /discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/g;
// <channel or thread id>/<message id> of every Discord message link in the text
export const messageLinks = (text: string): string[] => [...new Set([...text.matchAll(LINK)].map((m) => `${m[1]}/${m[2]}`))];

const PARTICLES = ["으로", "에서", "에게", "께서", "까지", "부터", "처럼", "이나", "하고", "을", "를", "이", "가", "은", "는", "의", "에", "로", "와", "과", "도", "만", "께"];
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "not", "ulw", "lane", "https", "discord", "com", "channels", "md", "qa", "dori", "형", "것", "수", "등", "뒤", "전", "안", "때", "및", "또는", "그", "한", "더", "할", "하는", "한다", "있는", "없는", "있게", "없이"]);
const HANGUL = /[\uac00-\ud7a3]/;

// Lower-case words of two or more letters; a Korean word of three or more syllables loses one trailing particle
// (설치를 -> 설치); numbers and stop words are left out.
export const words = (text: string): string[] => {
  const out: string[] = [];
  for (let w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\d+$/.test(w)) continue;
    if (HANGUL.test(w) && w.length >= 3) {
      const p = PARTICLES.find((s) => w.endsWith(s) && w.length - s.length >= 2);
      if (p) w = w.slice(0, -p.length);
    }
    if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  return out;
};

type Doc = { readonly title: readonly string[]; readonly body: readonly string[] };
type Vec = ReadonlyMap<string, number>;

const docOf = (title: string, brief: string): Doc => ({ title: words(title), body: words(workText(brief)) });

// title words count three times; weight (1 + ln tf) * idf
const vectorOf = (d: Doc, idf: (w: string) => number): Vec => {
  const tf = new Map<string, number>();
  for (const w of d.body) tf.set(w, (tf.get(w) ?? 0) + 1);
  for (const w of d.title) tf.set(w, (tf.get(w) ?? 0) + 3);
  return new Map([...tf].map(([w, n]) => [w, (1 + Math.log(n)) * idf(w)]));
};

const norm = (v: Vec): number => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
const cosine = (a: Vec, b: Vec): number => {
  const n = norm(a) * norm(b);
  if (!n) return 0;
  let dot = 0;
  for (const [w, x] of a) dot += x * (b.get(w) ?? 0);
  return dot / n;
};
const sharedWords = (a: Vec, b: Vec, n = 6): string[] =>
  [...a].filter(([w]) => b.has(w)).map(([w, x]) => [w, x * (b.get(w) ?? 0)] as const).sort((p, q) => q[1] - p[1]).slice(0, n).map(([w]) => w);

const idOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);
const ago = (ms: number): string => (ms < 120 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const relatedThreads = (lanes: readonly Lane[], q: RelatedQuery, ctx: RelatedContext): RelatedThread[] => {
  const { recentH, minScore, max } = ctx.settings;
  const docs = new Map(lanes.map((l) => [l.key, docOf(l.title, ctx.briefOf(l))] as const));
  const mine = docOf(q.title, q.brief);
  // document frequency over the whole registry and the new brief: words in every brief (the template's) weigh nothing
  const df = new Map<string, number>();
  for (const d of [...docs.values(), mine]) for (const w of new Set([...d.title, ...d.body])) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.size + 1;
  const idf = (w: string): number => Math.log((n + 1) / ((df.get(w) ?? 0) + 1));
  const myVec = vectorOf(mine, idf);
  const myLinks = messageLinks(q.brief);
  const work = workText(q.brief);
  // a thread is named for the lane that opened it (dori launch --thread new), closed long ago or not
  const opener = new Map<string, Lane>();
  for (const l of lanes) {
    const first = opener.get(l.thread);
    if (!first || l.openedAt < first.openedAt) opener.set(l.thread, l);
  }
  const byThread = new Map<string, Lane[]>();
  for (const l of lanes) {
    if (!l.thread || l.thread === "none" || !l.thread.includes(":") || ctx.channels.includes(idOf(l.thread))) continue;
    const closed = l.status === "closed" || l.closedAt !== undefined;
    // the owner just wrote in a thread the brief links into: open for him, however long ago its lanes closed
    const linked = myLinks.some((x) => x.startsWith(`${idOf(l.thread)}/`));
    if (closed && !linked && !(l.closedAt && ctx.now - Date.parse(l.closedAt) <= recentH * 3_600_000)) continue;
    byThread.set(l.thread, [...(byThread.get(l.thread) ?? []), l]);
  }
  const found: RelatedThread[] = [];
  for (const [thread, members] of byThread) {
    const sorted = [...members].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    const reasons: string[] = [];
    const id = idOf(thread);
    const inThread = thread.startsWith("discord:") ? myLinks.filter((x) => x.startsWith(`${id}/`)) : [];
    for (const x of inThread) reasons.push(`owner message ${x} the brief links is in this thread`);
    const same = myLinks.flatMap((x) => (inThread.includes(x) ? [] : sorted.filter((l) => messageLinks(ctx.briefOf(l)).includes(x)).slice(0, 1).map((l) => `the brief links owner message ${x}, as lane ${l.key} does`)));
    reasons.push(...same);
    const qa = sorted.filter((l) => work.includes(`/qa/${l.key}/`));
    for (const l of qa) reasons.push(`the brief uses ~/.dori/qa/${l.key}/ of lane ${l.key}`);
    const named = sorted.filter((l) => !qa.includes(l) && new RegExp(`(?<![\\w-])${escapeRe(l.key)}(?![\\w-])`).test(work));
    for (const l of named) reasons.push(`the brief names lane ${l.key}`);
    let best = 0;
    let closest: Lane | undefined;
    let shared: string[] = [];
    for (const l of sorted) {
      const v = vectorOf(docs.get(l.key) ?? { title: [], body: [] }, idf);
      const s = cosine(myVec, v);
      if (s > best) [best, closest, shared] = [s, l, sharedWords(myVec, v)];
    }
    if (closest && shared.length) reasons.push(`words shared with lane ${closest.key} (similarity ${best.toFixed(2)}): ${shared.join(", ")}`);
    const tagged = sorted.find((l) => l.tags?.some((t) => q.tags?.includes(t)));
    const tag = tagged?.tags?.find((t) => q.tags?.includes(t));
    if (tagged && tag) reasons.push(`tag ${tag}, like lane ${tagged.key}`);
    const cwdLane = q.cwd !== ctx.defaultCwd ? sorted.find((l) => l.cwd === q.cwd) : undefined;
    if (cwdLane) reasons.push(`same cwd ${q.cwd} as lane ${cwdLane.key}`);
    const recent = [...sorted].sort((a, b) => Number(a.closedAt !== undefined) - Number(b.closedAt !== undefined) || (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
    const shown = recent.slice(0, 5).map((l) => `${l.key} (${l.closedAt ? `closed ${ago(ctx.now - Date.parse(l.closedAt))}` : (l.status ?? "working")})`);
    reasons.push(`lanes there: ${shown.join(", ")}${recent.length > 5 ? ` and ${recent.length - 5} more` : ""}`);
    const link: 0 | 1 | 2 = inThread.length ? 2 : same.length ? 1 : 0;
    const score = best + (qa.length ? 0.15 : 0) + (tag ? 0.05 : 0);
    if (link || score >= minScore) found.push({ thread, title: (opener.get(thread) ?? sorted[0])?.title ?? "", lanes: sorted.map((l) => l.key), score: Number(score.toFixed(2)), link, reasons });
  }
  return found.sort((a, b) => b.link - a.link || b.score - a.score).slice(0, max);
};

// LAUNCH_RELATED_THREAD lines, one per thread with its evidence under it, then what the lead passes next.
export const relatedLines = (key: string, found: readonly RelatedThread[]): string[] => [
  ...found.flatMap((t, i) => [
    `LAUNCH_RELATED_THREAD ${key} ${t.thread} ${i + 1}/${found.length} "${t.title}" (${t.link === 2 ? "owner link in this thread" : t.link === 1 ? "same owner link" : `score ${t.score.toFixed(2)}`})`,
    ...t.reasons.map((r) => `  - ${r}`),
  ]),
  `LAUNCH_RELATED_THREAD_CHOOSE ${key}: nothing was opened. Continue the work in its thread: --thread ${found[0]?.thread ?? ""}${found.length > 1 ? " (the closest; or another one above)" : ""}. Only for other work: --thread new --why-new "<why this is not the work of that thread>".`,
];
