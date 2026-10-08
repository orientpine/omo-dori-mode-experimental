import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import { guardText } from "./http.ts";

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

export type AnswerKind = "button" | "text";

export type QuestionMeta = { readonly thread?: string | null; readonly session?: string | null; readonly tmux?: string | null };

export type Question = {
  id: string;
  text: string;
  options: string[];
  channel: string;
  thread: string | null;
  session: string | null;
  tmux: string | null;
  created: string;
  message?: string;
  status: "open" | "answered";
  answer?: string;
  answerKind?: AnswerKind;
  answeredAt?: string;
};

type State = { seq: number; questions: Question[] };

export class QuestionError extends Error {}

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

  all(): Question[] {
    return this.load().questions;
  }

  get(id: string): Question | undefined {
    return this.all().find((q) => q.id === id);
  }

  create(text: string, options: readonly string[], channel: string, meta: QuestionMeta, at: string): Question {
    const s = this.load();
    s.seq += 1;
    const q: Question = { id: `Q${s.seq}`, text, options: [...options], channel, thread: meta.thread ?? null, session: meta.session ?? null, tmux: meta.tmux ?? null, created: at, status: "open" };
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
    this.update(id, (q) => {
      q.message = message;
    });
  }

  answer(id: string, value: string, kind: AnswerKind, at: string): Question | null {
    const current = this.get(id);
    if (!current || current.status !== "open") return null;
    const q = this.update(id, (x) => Object.assign(x, { status: "answered", answer: value, answerKind: kind, answeredAt: at })) ?? null;
    if (q) appendFileSync(this.answersFile, `${JSON.stringify(q)}\n`, { mode: 0o600 });
    return q;
  }

  reopen(id: string): Question | undefined {
    return this.update(id, (q) => {
      q.status = "open";
      delete q.answer;
      delete q.answerKind;
      delete q.answeredAt;
    });
  }

  resolve(id: string): boolean {
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

const where = (q: Question): string => (q.thread ? ` · <#${q.thread}>` : "");

export const customId = { option: (id: string, n: number) => `q:${id}:${n}`, other: (id: string) => `q:${id}:other`, modal: (id: string) => `m:${id}` };

const pickLabel = (n: number, w: DiscordWords): string => `${w.pick.replace("{n}", String(n))}${n === 1 ? ` (${w.recommended})` : ""}`.slice(0, 80);

// The first option renders as the primary button, so put the recommended answer first.
// Discord clips a button label to one line, so each option's full text sits in a section
// text (type 9 + 10, wraps freely) with a short pick button beside it.
export const openCard = (q: Question, ownerId: string, w: DiscordWords): object[] => [
  {
    type: 17,
    accent_color: OPEN_ACCENT,
    components: [
      { type: 10, content: `<@${ownerId}> **${q.id}** ${q.text}${where(q)}`.slice(0, 3000) },
      ...q.options.map((option, i) => ({
        type: 9,
        components: [{ type: 10, content: `**${i + 1}.** ${option}`.slice(0, 1000) }],
        accessory: { type: 2, style: i === 0 ? 1 : 2, label: pickLabel(i + 1, w), custom_id: customId.option(q.id, i) },
      })),
      { type: 1, components: [{ type: 2, style: 2, label: w.other.slice(0, 80), custom_id: customId.other(q.id) }] },
    ],
  },
];

export const doneCard = (q: Question, w: DiscordWords): object[] => [
  {
    type: 17,
    accent_color: DONE_ACCENT,
    components: [{ type: 10, content: `${w.statusStyle === "emoji" ? "✅" : `[${w.answered}]`} **${q.id}** ${q.text}${where(q)}\n→ **${q.answer ?? ""}**\n-# ${q.answerKind === "text" ? w.byText : w.byButton} · ${stamp(q.answeredAt, w)}`.slice(0, 3000) }],
  },
];

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

export type CardSettings = { readonly channel: string; readonly owner: string; readonly words: DiscordWords };

export class QuestionCards {
  constructor(
    private readonly dc: Discord,
    readonly store: QuestionStore,
    private readonly settings: CardSettings,
    private readonly now: () => number,
  ) {}

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  card(q: Question): object[] {
    return q.status === "open" ? openCard(q, this.settings.owner, this.settings.words) : doneCard(q, this.settings.words);
  }

  async ask(text: string, options: readonly string[], meta: QuestionMeta = {}): Promise<Question> {
    const clean = options.map((o) => guardText(o).trim()).filter(Boolean);
    if (!guardText(text).trim()) throw new QuestionError("a question needs text");
    if (!clean.length || clean.length > MAX_OPTIONS) throw new QuestionError(`a question needs 1 to ${MAX_OPTIONS} options, got ${clean.length}`);
    const q = this.store.create(text.trim(), clean, this.settings.channel, meta, this.at());
    const posted = await this.dc.call<{ id: string }>("POST", `/channels/${q.channel}/messages`, { components: this.card(q), flags: IS_COMPONENTS_V2, allowed_mentions: { users: [this.settings.owner] } });
    this.store.setMessage(q.id, posted.id);
    return { ...q, message: posted.id };
  }

  async reopen(id: string): Promise<Question> {
    const known = this.store.get(id);
    if (!known?.message) throw new QuestionError(`no posted question ${id}`);
    const q = this.store.reopen(id) as Question;
    await this.dc.call("PATCH", `/channels/${q.channel}/messages/${q.message}`, { components: this.card(q) });
    return q;
  }

  resolve(id: string): boolean {
    return this.store.resolve(id);
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
    const answered = value ? this.store.answer(qid, value, kind, this.at()) : null;
    const now = this.store.get(qid);
    await this.respond(i, now ? { type: UPDATE_MESSAGE, data: { components: this.card(now) } } : { type: ACK_UPDATE });
    return answered ? { kind: "answered", question: answered } : { kind: "stale", qid };
  }

  async echo(q: Question): Promise<void> {
    if (!q.thread) return;
    await this.dc.call("POST", `/channels/${q.thread}/messages`, { content: `${q.id} ${q.text}\n→ ${q.answer ?? ""} (${stamp(q.answeredAt, this.settings.words)})`.slice(0, 2000), flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: { parse: [] } });
  }
}
