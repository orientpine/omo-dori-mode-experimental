import { shellWords } from "./handover.ts";
import { commandSource, executionCommands } from "./answer-command-source.ts";

export type AnswerRow = { readonly id: string; readonly at: number; readonly channel?: string; readonly qid?: string; readonly thread?: string; readonly tmux?: string };
type SendSpec = { readonly to: string; readonly reply?: string; readonly qids: ReadonlySet<string> };
type SendCall = SendSpec & { readonly id: string; readonly at: number; sent: boolean };

const flagValue = (args: readonly unknown[], name: string): string | undefined => { const at = args.indexOf(name), value = at < 0 ? undefined : args[at + 1]; return typeof value === "string" ? value : undefined; };
const qidsIn = (text: string): ReadonlySet<string> => new Set((text.match(/\bq\d+\b/gi) ?? []).map((q) => q.toUpperCase()));
const specFromArgv = (argv: readonly unknown[]): SendSpec | undefined => {
  if (argv[0] !== "dori") return undefined; const to = argv[1] === "send" && argv[2] === "discord" ? flagValue(argv, "--thread") ?? flagValue(argv, "--to") : argv[1] === "thread" && argv[2] === "reply" && typeof argv[3] === "string" && argv[3].startsWith("discord:") ? flagValue(argv, "--thread") ?? argv[3].slice("discord:".length) : undefined;
  if (!to) return undefined; const reply = flagValue(argv, "--reply");
  return { to, ...(reply ? { reply } : {}), qids: qidsIn(argv.filter((part) => typeof part === "string").join(" ")) }; };
const specFromShell = (command: string): SendSpec | undefined => {
  let quote = "", end = command.length;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (";|&\n".includes(c)) { end = i; break; }
  }
  const args = shellWords(command.slice(0, end));
  if (!args) return undefined;
  const operator = args.findIndex((word) => word.startsWith("\0"));
  return specFromArgv(operator < 0 ? args : args.slice(0, operator)); };
export const balancedBlock = (text: string, start: number): string | undefined => {
  let depth = 0, quote = ""; for (let i = start; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === text[start]) depth++;
    else if (c === (text[start] === "[" ? "]" : "}")) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
};
const arrayCommandPrefix = (raw: string): string => {
  let quote = ""; for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i] ?? "";
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") return `${raw.slice(0, i)}]`;
  }
  return raw;
};
const literalArrays = (text: string, source: ReturnType<typeof commandSource>): string[] => {
  const out: string[] = []; for (const match of text.matchAll(/\[\s*["']dori["']\s*,\s*(?:["']send["']\s*,\s*["']discord["']|["']thread["']\s*,\s*["'](?:reply|done|wait)["'])/g)) {
    const start = match.index ?? -1; if (start < 0 || !source.code[start] || !/(?:Bun\.spawn|Bun\.spawnSync|subprocess\.run|spawn|execFile|execa|exec)\s*\(\s*$/.test(text.slice(0, start))) continue;
    const raw = balancedBlock(text, start); if (raw) out.push(raw);
  }
  return out; };
// An unresolved posting operation still occupies a slot: one receipt cannot identify the successful operation.
const specsFromText = (text: string): (SendSpec | undefined)[] => {
  const source = commandSource(text), out: (SendSpec | undefined)[] = []; for (const raw of literalArrays(text, source)) {
    try {
      const parsed: unknown = Bun.JSON5.parse(arrayCommandPrefix(raw)); out.push(Array.isArray(parsed) ? specFromArgv(parsed) : undefined);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; out.push(undefined); }
  }
  const starts = [...text.matchAll(/\bdori send discord\b|\bdori thread (?:reply|done|wait) discord:[\w-]+/g)].map((match) => match.index ?? -1).filter((at) => at >= 0); starts.forEach((at) => {
    if (!source.code[at] || !/(?:^|[;\n|&])\s*$/.test(text.slice(0, at))) return;
    out.push(specFromShell(text.slice(at)));
  });
  for (const command of executionCommands(text, source)) out.push(...(command === undefined ? [undefined] : specsFromText(command)));
  return out; };
const sendSpecs = (value: unknown): (SendSpec | undefined)[] => {
  if (typeof value === "string") return specsFromText(value); if (Array.isArray(value)) { if (value[0] === "dori" && ((value[1] === "send" && value[2] === "discord") || (value[1] === "thread" && ["reply", "done", "wait"].includes(String(value[2]))))) return [specFromArgv(value)]; return value.flatMap(sendSpecs); }
  if (value && typeof value === "object") return Object.values(value).flatMap(sendSpecs); return [];
};

// Only an actual SENT/POSTED result of this session's own unambiguous tool call counts. A command alone, another Dori's
// send, assistant narration, another tool's quoted log, or a second send in the same eval is not a receipt. Detached eval
// results must name the originating cell id; one eval running multiple sends cannot prove which send succeeded.
const sendCalls = (transcript: string): SendCall[] => {
  const calls = new Map<string, SendCall>();
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; timestamp?: string; customType?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: { type?: string; id?: string; name?: string; arguments?: unknown }[] } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      for (const part of entry.message.content ?? []) {
        if (part.type !== "toolCall" || !part.id || !["eval", "bash", "monitor"].includes(part.name ?? "")) continue; const specs = sendSpecs(part.arguments ?? {}), spec = specs.length === 1 ? specs[0] : undefined; if (spec) calls.set(part.id, { id: part.id, at: Date.parse(entry.timestamp ?? ""), ...spec, sent: false });
      }
    } else if (entry.message?.role === "toolResult") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(line)) continue; const call = entry.message.toolCallId ? calls.get(entry.message.toolCallId) : undefined;
      if (call) call.sent = true;
    } else if (entry.type === "custom_message" && entry.customType === "senpi-codemode:notification" && typeof entry.content === "string") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(entry.content)) continue; const cell = entry.content.match(/Detached eval cell ([^\s]+) \((?:js|py)\) completed\./)?.[1], call = cell ? calls.get(cell) : undefined; if (call) call.sent = true;
    }
  }
  return [...calls.values()];
};

export const discordAnswered = (transcript: string, row: AnswerRow): boolean =>
  sendCalls(transcript).some((call) => call.sent && call.at >= row.at && (row.qid ? call.to === row.thread && call.qids.has(row.qid) : call.to === row.channel && call.reply === row.id));
