import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CheckpointError, takeLock } from "../checkpoints.ts";
import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import type { ThreadStatus } from "./discord-thread.ts";
import { fitEscaped } from "./discord-markdown.ts";
import { guardText } from "./http.ts";
import { ThreadStatusQueue } from "./thread-status-queue.ts";

export const IS_COMPONENTS_V2 = 1 << 15;
export const SUPPRESS_NOTIFICATIONS = 1 << 12;
export const EPHEMERAL = 1 << 6;
const OPEN_ACCENT = 0xf2a65a;
const DONE_ACCENT = 0x57a773;
export const MAX_OPTIONS = 9;

// interaction types and callback types, from the Discord interactions API
const COMPONENT = 3;
const MODAL_SUBMIT = 5;
const REPLY = 4;
const ACK_UPDATE = 6;
const UPDATE_MESSAGE = 7;
const OPEN_MODAL = 9;

// button: a pick tap; text: the write-my-own box; reply: the owner answered in a message and the lead resolved the card
export type AnswerKind = "button" | "text" | "reply";

// channelWhy: why a card with no work thread is in the channel (dori ask --channel); replyTo: the owner's message it answers
export type QuestionMeta = { readonly thread?: string | null; readonly session?: string | null; readonly tmux?: string | null; readonly channelWhy?: string; readonly replyTo?: string };

export type Question = {
  id: string;
  text: string;
  options: string[];
  channel: string;
  thread: string | null;
  session: string | null;
  tmux: string | null;
  channelWhy?: string;
  replyTo?: string;
  created: string;
  message?: string;
  status: "open" | "answered";
  answer?: string;
  answerKind?: AnswerKind;
  answeredAt?: string;
};

type State = { seq: number; questions: Question[] };

export class QuestionError extends Error {}

const CLAIM_WAIT_MS = 10_000;
const STORE_WAIT_MS = 5_000;
const STORE_POLL_MS = 5;
const CLAIM_POLL_MS = 50;

export class QuestionStore {
  readonly file: string;
  readonly answersFile: string;

  constructor(dir: string) {
    this.file = join(dir, "questions.json");
    this.answersFile = join(dir, "answers.jsonl");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  load(): State {
    if (!existsSync(this.file)) return { seq: 0, questions: [] };
    const s = JSON.parse(readFileSync(this.file, "utf8")) as Partial<State>;
    return { seq: s.seq ?? 0, questions: s.questions ?? [] };
  }

  // temp file + rename so the listener never reads a half-written state
  private save(s: State): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // Every read-modify-write of questions.json holds the store lock (takeLock on questions.lock), so a write of one
  // process never restores what another just wrote, a tapped answer included (review 4 of #374). It is held only for
  // the file work, never across a network call: lock order is the question's claim first, the store lock inside it,
  // and nothing takes a claim while holding the store lock, so the two cannot deadlock.
  private locked<T>(work: () => T): T {
    for (let waited = 0; ; waited += STORE_POLL_MS) {
      const done = this.tryLocked(work);
      if (done) return done.value;
      if (waited >= STORE_WAIT_MS) throw new QuestionError("the question store stayed locked; try again");
      Bun.sleepSync(STORE_POLL_MS);
    }
  }

  // The store lock without a limit, waiting without blocking the process: for a tap Discord already took, whose answer
  // must be recorded however long another writer holds the store (challenge of #374's plan). The lock is held only for
  // file work and a dead holder's lock ends with its process, so the wait ends.
  private async lockedPatiently<T>(work: () => T): Promise<T> {
    for (;;) {
      const done = this.tryLocked(work);
      if (done) return done.value;
      await new Promise((later) => setTimeout(later, STORE_POLL_MS));
    }
  }

  private tryLocked<T>(work: () => T): { value: T } | null {
    let release: () => void;
    try {
      release = takeLock(`${this.file.replace(/\.json$/, "")}.lock`, Date.now(), "question store", "questions.json");
    } catch (e) {
      if (e instanceof CheckpointError) return null;
      throw e;
    }
    try {
      return { value: work() };
    } finally {
      release();
    }
  }

  all(): Question[] {
    return this.load().questions;
  }

  get(id: string): Question | undefined {
    return this.all().find((q) => q.id === id);
  }

  create(text: string, options: readonly string[], channel: string, meta: QuestionMeta, at: string): Question {
    return this.locked(() => this.created(text, options, channel, meta, at));
  }

  private created(text: string, options: readonly string[], channel: string, meta: QuestionMeta, at: string): Question {
    const s = this.load();
    s.seq += 1;
    const q: Question = { id: `Q${s.seq}`, text, options: [...options], channel, thread: meta.thread ?? null, session: meta.session ?? null, tmux: meta.tmux ?? null, ...(meta.channelWhy ? { channelWhy: meta.channelWhy } : {}), ...(meta.replyTo ? { replyTo: meta.replyTo } : {}), created: at, status: "open" };
    s.questions.push(q);
    this.save(s);
    return q;
  }

  private update(id: string, change: (q: Question) => void): Question | undefined {
    const s = this.load();
    const q = s.questions.find((x) => x.id === id);
    if (!q) return undefined;
    change(q);
    this.save(s);
    return q;
  }

  setMessage(id: string, message: string): void {
    this.locked(() => this.update(id, (q) => {
      q.message = message;
    }));
  }

  answer(id: string, value: string, kind: AnswerKind, at: string): Question | null {
    return this.locked(() => this.answered(id, value, kind, at));
  }

  // a tap's answer once Discord took its fold: recorded, however long the store stays locked
  answerPatiently(id: string, value: string, kind: AnswerKind, at: string): Promise<Question | null> {
    return this.lockedPatiently(() => this.answered(id, value, kind, at));
  }

  private answered(id: string, value: string, kind: AnswerKind, at: string): Question | null {
    const current = this.get(id);
    if (!current || current.status !== "open") return null;
    const q = this.update(id, (x) => Object.assign(x, { status: "answered", answer: value, answerKind: kind, answeredAt: at })) ?? null;
    if (q) appendFileSync(this.answersFile, `${JSON.stringify(q)}\n`, { mode: 0o600 });
    return q;
  }

  // One writer per question across processes: the listener folds taps while dori resolve and dori reopen run as other
  // processes on the same store (review of #374). The claim is the kernel lock takeLock holds (flock on claim-<id>.lock):
  // it never expires while its holder lives, however long a rate-limited call sleeps, and ends with the holder's process,
  // so no one judges a claim stale and two takers cannot both win (review 2 of #374). null while another holds it. An id
  // no question can have needs no claim.
  claim(id: string, now: number): (() => void) | null {
    if (!/^Q\d+$/.test(id)) return () => {};
    try {
      return takeLock(join(dirname(this.file), `claim-${id}.lock`), now, "question", id);
    } catch (e) {
      if (e instanceof CheckpointError) return null;
      throw e;
    }
  }

  reopen(id: string): Question | undefined {
    return this.locked(() => this.update(id, (q) => {
      q.status = "open";
      delete q.answer;
      delete q.answerKind;
      delete q.answeredAt;
    }));
  }

  // open cards asked from one session belong to another from now on (dori handover); returns the ids moved
  retarget(from: QuestionMeta, to: QuestionMeta): string[] {
    return this.locked(() => this.retargeted(from, to));
  }

  private retargeted(from: QuestionMeta, to: QuestionMeta): string[] {
    const s = this.load();
    const moved: string[] = [];
    for (const q of s.questions) {
      if (q.status !== "open") continue;
      const tmux = !!from.tmux && q.tmux === from.tmux;
      const session = !!from.session && q.session === from.session;
      if (tmux) q.tmux = to.tmux ?? null;
      if (session) q.session = to.session ?? null;
      if (tmux || session) moved.push(q.id);
    }
    if (moved.length) this.save(s);
    return moved;
  }

  // every resolved card leaves its answer line here, so a question gone from the store but logged was resolved before
  logged(id: string): boolean {
    if (!existsSync(this.answersFile)) return false;
    const head = `{"id":${JSON.stringify(id)},`;
    return readFileSync(this.answersFile, "utf8").split("\n").some((line) => line.startsWith(head));
  }

  resolve(id: string): boolean {
    return this.locked(() => this.forget(id));
  }

  private forget(id: string): boolean {
    const s = this.load();
    const before = s.questions.length;
    s.questions = s.questions.filter((q) => q.id !== id);
    if (s.questions.length === before) return false;
    this.save(s);
    return true;
  }
}

const stamp = (iso: string | undefined, w: DiscordWords): string =>
  new Date(iso ?? 0).toLocaleString(w.locale, { timeZone: w.timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

// a card posted inside its work thread needs no link back to it
const where = (q: Question): string => (q.thread && q.channel !== q.thread ? ` · <#${q.thread}>` : "");

export const customId = { option: (id: string, n: number) => `q:${id}:${n}`, other: (id: string) => `q:${id}:other`, modal: (id: string) => `m:${id}` };

const pickLabel = (n: number, w: DiscordWords): string => `${w.pick.replace("{n}", String(n))}${n === 1 ? ` (${w.recommended})` : ""}`.slice(0, 80);

// The first option renders as the primary button, so put the recommended answer first.
// Discord clips a button label to one line, so each option's full text sits in a section
// text (type 9 + 10, wraps freely) with a short pick button beside it. The question, options and answer have their
// underscores escaped as every post does (discord-markdown.ts), so a path in them is not drawn in italics. Each text is
// measured whole before it is cut to its limit, and a text (or a card's 4000 characters of text) that fits only
// unescaped goes out unescaped, so escaping never cuts off text that fit before (reviews 1 and 2 of #358).
const CARD_TEXT_MAX = 4000;
// An option's section text ("**n.** <option>"); ask refuses an option it cannot show whole, before anything is stored or
// posted, since the egress gate takes a tap's answer only when it equals the pressed option's text in the card.
const OPTION_TEXT_MAX = 1000;
const optionText = (md: (part: string) => string, option: string, i: number): string => `**${i + 1}.** ${md(option)}`;
type Fit = (build: (md: (part: string) => string) => string, max: number) => string;
const plainFit: Fit = (build, max) => build((part) => part).slice(0, max);
const escapedFit: Fit = (build, max) => fitEscaped(build, max).slice(0, max);
const cardText = (node: unknown): number =>
  Array.isArray(node) ? node.reduce((n: number, c) => n + cardText(c), 0)
  : node && typeof node === "object" ? Object.entries(node).reduce((n, [k, v]) => n + (k === "content" && typeof v === "string" ? v.length : cardText(v)), 0)
  : 0;
export const openCard = (q: Question, ownerId: string, w: DiscordWords): object[] => {
  const escaped = buildOpenCard(q, ownerId, w, escapedFit);
  if (cardText(escaped) <= CARD_TEXT_MAX) return escaped;
  const plain = buildOpenCard(q, ownerId, w, plainFit);
  return cardText(plain) <= CARD_TEXT_MAX ? plain : escaped;
};
const buildOpenCard = (q: Question, ownerId: string, w: DiscordWords, fit: Fit): object[] => [
  {
    type: 17,
    accent_color: OPEN_ACCENT,
    components: [
      { type: 10, content: fit((md) => `<@${ownerId}> **${q.id}** ${md(q.text)}${where(q)}`, 3000) },
      ...q.options.map((option, i) => ({
        type: 9,
        components: [{ type: 10, content: fit((md) => optionText(md, option, i), OPTION_TEXT_MAX) }],
        accessory: { type: 2, style: i === 0 ? 1 : 2, label: pickLabel(i + 1, w), custom_id: customId.option(q.id, i) },
      })),
      { type: 1, components: [{ type: 2, style: 2, label: w.other.slice(0, 80), custom_id: customId.other(q.id) }] },
    ],
  },
];

// The answer and its "-# by · when" line always survive whole: a question too long to fit escaped or unescaped is cut
// instead, since the egress gate reads a tapped card's last two lines as the owner's answer (reviews 1 and 2 of #370).
// The whole text is tried first, so a card that fits only unescaped still goes out whole as before.
const DONE_TEXT_MAX = 3000;
// A button answer folds in as its option reads on the open card (escaped or not, as openCard drew that section), since
// the egress gate takes a tap only when the folded answer is the pressed option's text exactly as written (round 7 of
// #370); a typed or replied answer goes through md like the question.
const shownOption = (q: Question, ownerId: string, w: DiscordWords): string | undefined => {
  const i = q.answerKind === "button" ? q.options.indexOf(q.answer ?? "") : -1;
  if (i < 0) return undefined;
  const sections = (openCard(q, ownerId, w)[0] as { components: { type: number; components?: { content?: string }[] }[] }).components.filter((c) => c.type === 9);
  const content = sections[i]?.components?.[0]?.content ?? "";
  const prefix = `**${i + 1}.** `;
  return content.startsWith(prefix) ? content.slice(prefix.length) : undefined;
};
const doneText = (q: Question, w: DiscordWords, cut: boolean, shown?: string) => (md: (part: string) => string): string => {
  const head = `${w.statusStyle === "emoji" ? "✅" : `[${w.answered}]`} **${q.id}** `;
  const tail = `\n→ **${shown ?? md(q.answer ?? "")}**\n-# ${q.answerKind === "text" ? w.byText : q.answerKind === "reply" ? w.byReply : w.byButton} · ${stamp(q.answeredAt, w)}`;
  const question = `${md(q.text)}${where(q)}`;
  const room = DONE_TEXT_MAX - head.length - tail.length;
  return head + (!cut || question.length <= room ? question : `${question.slice(0, Math.max(0, room - 1))}…`) + tail;
};
export const doneCard = (q: Question, w: DiscordWords, ownerId = ""): object[] => {
  const shown = ownerId ? shownOption(q, ownerId, w) : undefined;
  const whole = fitEscaped(doneText(q, w, false, shown), DONE_TEXT_MAX);
  return [{ type: 17, accent_color: DONE_ACCENT, components: [{ type: 10, content: whole.length <= DONE_TEXT_MAX ? whole : escapedFit(doneText(q, w, true, shown), DONE_TEXT_MAX) }] }];
};

export type Interaction = {
  readonly id: string;
  readonly token: string;
  readonly type: number;
  readonly channel_id?: string;
  readonly member?: { readonly user: { readonly id: string } };
  readonly user?: { readonly id: string };
  readonly data?: { readonly custom_id?: string; readonly components?: readonly unknown[] };
};

export type CardOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "refused"; readonly user: string }
  | { readonly kind: "modal"; readonly qid: string }
  | { readonly kind: "stale"; readonly qid: string }
  | { readonly kind: "answered"; readonly question: Question };

// a modal submit nests the text input in action rows (type 1) or labels (type 18)
export const modalValue = (components: readonly unknown[] = []): string => {
  for (const c of components as { value?: unknown; components?: unknown[]; component?: unknown }[]) {
    if (typeof c.value === "string") return c.value;
    const inner = modalValue([...(c.components ?? []), ...(c.component ? [c.component] : [])]);
    if (inner) return inner;
  }
  return "";
};

// folded: an open card was edited into its record now; kept: already folded (or never posted), only forgotten;
// already: resolved before, nothing to do
export type Resolved = "folded" | "kept" | "already";

export type CardSettings = { readonly channel: string; readonly owner: string; readonly words: DiscordWords };

export const openCardIds = (store: QuestionStore, thread: string): string[] => store.all().filter((q) => q.status === "open" && q.thread === thread).map((q) => q.id);

export class QuestionCards {
  readonly statuses: ThreadStatusQueue;

  // resolve and reopen wait for the question's claim (a tap's fold in flight, in the listener's process or this one),
  // then read it again: the tap's answer is what Discord shows and the egress gate's receipt holds, so the log must not
  // take another (challenge of #370's plan 9). A claim held past CLAIM_WAIT_MS refuses the command; nothing changed.
  private async claimed(id: string): Promise<() => void> {
    for (let waited = 0; ; waited += CLAIM_POLL_MS) {
      const release = this.store.claim(id, this.now());
      if (release) return release;
      if (waited >= CLAIM_WAIT_MS) throw new QuestionError(`question ${id} is being answered now; try again`);
      await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
    }
  }

  constructor(
    private readonly dc: Discord,
    readonly store: QuestionStore,
    private readonly settings: CardSettings,
    private readonly now: () => number,
    statuses?: ThreadStatusQueue,
  ) {
    this.statuses = statuses ?? new ThreadStatusQueue({ dc, words: settings.words, file: join(dirname(store.file), "thread-status.json"), openCards: (t) => openCardIds(store, t), now, log: (line) => console.error(line) });
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  card(q: Question): object[] {
    return q.status === "open" ? openCard(q, this.settings.owner, this.settings.words) : doneCard(q, this.settings.words, this.settings.owner);
  }

  // The card is already posted when the thread is renamed, so a failed rename is reported, not thrown:
  // throwing would invite a second card for the same question. The queue decides the mark from the open cards.
  private async mark(thread: string, status: ThreadStatus): Promise<void> {
    await this.statuses.request(thread, status).catch((e: unknown) => console.error(`THREAD_STATUS_FAIL ${thread} ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`));
  }

  // With a work thread the card goes inside it and the thread is marked waiting until the question is answered;
  // without one it goes to the configured channel.
  async ask(text: string, options: readonly string[], meta: QuestionMeta = {}): Promise<Question> {
    const clean = options.map((o) => guardText(o).trim()).filter(Boolean);
    if (!guardText(text).trim()) throw new QuestionError("a question needs text");
    if (!clean.length || clean.length > MAX_OPTIONS) throw new QuestionError(`a question needs 1 to ${MAX_OPTIONS} options, got ${clean.length}`);
    // Escaping never cuts an option (a section that fits only unescaped goes out unescaped), so the text as written is
    // the shortest the card can show (review 4 of #370).
    const cut = clean.findIndex((o, i) => optionText((part) => part, o, i).length > OPTION_TEXT_MAX);
    if (cut >= 0) throw new QuestionError(`option ${cut + 1} is longer than a card shows whole (${OPTION_TEXT_MAX} characters with its "**${cut + 1}.** ")`);
    // A folded card's answer is the text after its last "\n→ **" (the egress gate reads it so); an option holding one
    // would fold into a card that reads as another answer (review 6 of #370).
    const arrow = clean.findIndex((o) => o.includes("\n→ **"));
    if (arrow >= 0) throw new QuestionError(`option ${arrow + 1} holds a line starting "→ **", which a folded card reads as its answer`);
    const q = this.store.create(text.trim(), clean, meta.thread || this.settings.channel, meta, this.at());
    // The question's claim from its creation until its message id is stored: a resolve or reopen meanwhile waits for the
    // posted card instead of forgetting a question whose card then goes out open (challenge of #374's plan). Should one
    // take the claim first, the question is read again and a forgotten one is not posted.
    const release = await this.claimed(q.id);
    let posted: { id: string };
    try {
      if (!this.store.get(q.id)) throw new QuestionError(`${q.id} was resolved before its card was posted`);
      const reply = q.replyTo ? { message_reference: { message_id: q.replyTo, fail_if_not_exists: false } } : {};
      posted = await this.dc.call<{ id: string }>("POST", `/channels/${q.channel}/messages`, { components: this.card(q), flags: IS_COMPONENTS_V2, allowed_mentions: { users: [this.settings.owner] }, ...reply });
      this.store.setMessage(q.id, posted.id);
    } finally {
      release();
    }
    if (q.thread) await this.mark(q.thread, "waiting");
    return { ...q, message: posted.id };
  }

  async reopen(id: string): Promise<Question> {
    const release = await this.claimed(id);
    try {
      const known = this.store.get(id);
      if (!known?.message) throw new QuestionError(`no posted question ${id}`);
      const q = this.store.reopen(id) as Question;
      await this.dc.call("PATCH", `/channels/${q.channel}/messages/${q.message}`, { components: this.card(q) });
      if (q.thread) await this.mark(q.thread, "waiting");
      return q;
    } finally {
      release();
    }
  }

  // A card still open when it is resolved (the owner answered in a message) folds into the same record a tap leaves,
  // with the given answer or words.repliedInText: the edit goes first, so a failed edit keeps the question for another
  // try, then the answer is logged and the question forgotten. Its thread is re-checked: working once none of its
  // questions is open. A card already folded by a tap is not edited again; a question resolved before changes nothing.
  async resolve(id: string, answer?: string): Promise<Resolved | null> {
    const release = await this.claimed(id);
    try {
      return await this.resolveClaimed(id, answer);
    } finally {
      release();
    }
  }

  private async resolveClaimed(id: string, answer?: string): Promise<Resolved | null> {
    const q = this.store.get(id);
    if (!q) return this.store.logged(id) ? "already" : null;
    if (q.status !== "open") {
      this.store.resolve(id);
      return "kept";
    }
    const value = guardText(answer ?? "").trim() || this.settings.words.repliedInText;
    const at = this.at();
    if (q.message) await this.edit(q.channel, q.message, { components: this.card({ ...q, status: "answered", answer: value, answerKind: "reply", answeredAt: at }) });
    this.store.answer(id, value, "reply", at);
    this.store.resolve(id);
    if (q.thread) await this.mark(q.thread, "working");
    return q.message ? "folded" : "kept";
  }

  // Discord refuses to edit a message in an archived thread (50083), and a quiet thread with an open card archives
  // itself, so the thread is opened and the card edited again; the thread mark that follows settles the thread
  private async edit(channel: string, message: string, body: Record<string, unknown>): Promise<void> {
    const patch = () => this.dc.call("PATCH", `/channels/${channel}/messages/${message}`, body);
    try {
      await patch();
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("50083"))) throw e;
      await this.dc.setThread(channel, { archived: false });
      await patch();
    }
  }

  private respond(i: Interaction, body: Record<string, unknown>): Promise<unknown> {
    return this.dc.call("POST", `/interactions/${i.id}/${i.token}/callback`, body);
  }

  // Discord gives 3 seconds to answer an interaction, so state changes stay local and the
  // response goes out before any other request.
  async handle(i: Interaction): Promise<CardOutcome> {
    const cid = i.data?.custom_id ?? "";
    if (!/^[qm]:/.test(cid)) return { kind: "ignored" };
    const user = i.member?.user.id ?? i.user?.id ?? "";
    if (user !== this.settings.owner) {
      await this.respond(i, { type: REPLY, data: { content: this.settings.words.ownerOnly, flags: EPHEMERAL } });
      return { kind: "refused", user };
    }
    let qid: string;
    let value: string;
    let kind: AnswerKind;
    if (i.type === COMPONENT && cid.startsWith("q:")) {
      const [, id = "", opt = ""] = cid.split(":");
      const q = this.store.get(id);
      if (q?.status === "open" && opt === "other") {
        await this.respond(i, {
          type: OPEN_MODAL,
          data: { custom_id: customId.modal(id), title: this.settings.words.other.slice(0, 45), components: [{ type: 1, components: [{ type: 4, custom_id: "answer", style: 2, label: q.text.slice(0, 45), required: true, max_length: 1000 }] }] },
        });
        return { kind: "modal", qid: id };
      }
      [qid, value, kind] = [id, q?.options[Number(opt)] ?? "", "button"];
    } else if (i.type === MODAL_SUBMIT && cid.startsWith("m:")) {
      [qid, value, kind] = [cid.slice(2), modalValue(i.data?.components).trim(), "text"];
    } else return { kind: "ignored" };
    // The answer is recorded only once the callback was taken: the egress gate (or Discord) can refuse the fold, and a
    // question answered here but still open on the card would be lost (round 7 of #370).
    // Taps are handled at once, so the question is held while its fold is in flight: a second tap folding another
    // answer would leave the card and the gate's tap receipt saying one answer and the store another (review 7 of #370).
    // It is only acknowledged; a fold Discord refuses frees the question for the next tap.
    // The question's claim is the hold, so a dori resolve or reopen in another process waits for it too (review of #374).
    // Every callback that draws the card holds it, a repaint of an answered card included: a late one would otherwise
    // draw the old record over a card reopened meanwhile (review 3 of #374). Without the claim the tap is only acknowledged.
    const current = this.store.get(qid);
    const release = current ? this.store.claim(qid, this.now()) : null;
    if (current && !release) {
      await this.respond(i, { type: ACK_UPDATE });
      return { kind: "stale", qid };
    }
    try {
      const fresh = release ? this.store.get(qid) : current;
      const at = this.at();
      const folded: Question | null = value && fresh?.status === "open" ? { ...fresh, status: "answered", answer: value, answerKind: kind, answeredAt: at } : null;
      const shown = folded ?? fresh;
      await this.respond(i, shown ? { type: UPDATE_MESSAGE, data: { components: this.card(shown) } } : { type: ACK_UPDATE });
      const answered = folded ? await this.store.answerPatiently(qid, value, kind, at) : null;
      return answered ? { kind: "answered", question: answered } : { kind: "stale", qid };
    } finally {
      release?.();
    }
  }

  // A card inside its work thread already folded into the record there; a card in the channel leaves a
  // silent record line in the thread. The thread is re-checked: working once none of its questions is open.
  async afterAnswer(q: Question): Promise<void> {
    if (!q.thread) return;
    if (q.channel !== q.thread) {
      await this.dc.call("POST", `/channels/${q.thread}/messages`, { content: escapedFit((md) => `${q.id} ${md(q.text)}\n→ ${md(q.answer ?? "")} (${stamp(q.answeredAt, this.settings.words)})`, 2000), flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: { parse: [] } });
    }
    await this.mark(q.thread, "working");
  }
}
