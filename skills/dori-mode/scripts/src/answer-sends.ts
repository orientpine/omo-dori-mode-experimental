import { parseArgs } from "node:util";
import { shellWords } from "./handover.ts";
import { commandSource, executionCommands, shellSource } from "./answer-command-source.ts";
import { backgroundStarts } from "./background.ts";

export type AnswerRow = { readonly id: string; readonly at: number; readonly channel?: string; readonly qid?: string; readonly thread?: string; readonly tmux?: string };
type SendSpec = { readonly to: string; readonly reply?: string; readonly qids: ReadonlySet<string>; readonly aggregate?: boolean; readonly bash?: { readonly command: string; readonly alone: boolean; readonly peers?: readonly string[] } };
type SendCall = SendSpec & { readonly id: string; readonly tool: string; readonly at: number; sent: boolean; detachedReceipt: boolean };

const qidsIn = (text: string): ReadonlySet<string> => new Set((text.match(/\bq\d+\b/gi) ?? []).map((q) => q.toUpperCase()));
const specsFromArgv = (argv: readonly unknown[]): (SendSpec | undefined)[] => {
  if (argv[0] !== "dori" || !["send", "thread"].includes(String(argv[1]))) return [];
  if (!argv.every((part) => typeof part === "string")) return [undefined];
  let flags: ReturnType<typeof parseArgs>;
  try {
    // The CLI uses this parser too: string options consume their own values, the last occurrence wins, and "=" works.
    flags = parseArgs({ args: argv.slice(2), allowPositionals: true, strict: false, options: {
      to: { type: "string" }, thread: { type: "string" }, reply: { type: "string" }, text: { type: "string" },
      "text-file": { type: "string" }, edit: { type: "string" }, status: { type: "string" }, ping: { type: "string" },
      lane: { type: "string" }, file: { type: "string", multiple: true }, again: { type: "boolean" }, force: { type: "boolean" }, "no-typing": { type: "boolean" },
    } });
  } catch (error) { if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_")) return [undefined]; throw error; }
  if (!(argv[1] === "send" && flags.positionals[0] === "discord") && !(argv[1] === "thread" && ["reply", "done", "wait"].includes(flags.positionals[0] ?? ""))) return [];
  const option = (name: string): string | undefined => { const value = flags.values[name]; return typeof value === "string" ? value.trim() : undefined; };
  const ref = flags.positionals[1], to = argv[1] === "send" && flags.positionals[0] === "discord" ? option("thread") ?? option("to") : argv[1] === "thread" && flags.positionals[0] === "reply" && ref?.startsWith("discord:") ? ref.slice("discord:".length) : undefined;
  if (!to) return [undefined];
  const reply = argv[1] === "send" ? option("reply") : undefined, text = argv[1] === "send" ? option("text") : flags.positionals[2];
  return [{ to, ...(reply ? { reply } : {}), qids: qidsIn(text ?? "") }]; };
const specsFromShell = (command: string): (SendSpec | undefined)[] => {
  let quote = "", end = command.length;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#" && (i === 0 || /[\s;|&()]/.test(command[i - 1] ?? ""))) { end = i; break; }
    if (";|&\n".includes(c)) { end = i; break; }
  }
  const args = shellWords(command.slice(0, end));
  if (!args) return [undefined];
  const operator = args.findIndex((word) => word.startsWith("\0"));
  return specsFromArgv(operator < 0 ? args : args.slice(0, operator)); };
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
const literalArrays = (text: string, source: ReturnType<typeof commandSource>): string[] => {
  const out: string[] = []; for (const match of text.matchAll(/\[\s*["']dori["']\s*,\s*["'](?:send|thread)["']/g)) {
    const start = match.index ?? -1; if (start < 0 || !source.code[start] || !/(?:Bun\.spawn|Bun\.spawnSync|subprocess\.run|spawn|execFile|execa|exec)\s*\(\s*$/.test(text.slice(0, start))) continue;
    const raw = balancedBlock(text, start); if (raw) out.push(raw);
  }
  return out; };
// An unresolved posting operation still occupies a slot: one receipt cannot identify the successful operation.
const specsFromText = (text: string): (SendSpec | undefined)[] => {
  const source = commandSource(text), out: (SendSpec | undefined)[] = []; for (const raw of literalArrays(text, source)) {
    try {
      const parsed: unknown = Bun.JSON5.parse(raw); out.push(...(Array.isArray(parsed) ? specsFromArgv(parsed) : [undefined]));
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; out.push(undefined); }
  }
  out.push(...shellSpecs(text, source.code));
  const commands = executionCommands(text, source), alone = commands.filter((operation) => operation.tool === "bash").length === 1;
  for (const { tool, command } of commands) {
    if (command === undefined) { out.push(undefined); continue; }
    for (const spec of shellSpecs(command, shellSource(command))) out.push(spec && tool === "bash" ? { ...spec, bash: { command, alone } } : spec);
  }
  const native = [...text.matchAll(/(?<![\w$.])(?:exec|execSync|spawn|execFile|execa|subprocess\.run)\s*\(|\bBun\.spawn(?:Sync)?\s*\(|(?:\bBun\.\$|\$)\s*(?=`)/g)].filter((match) => source.code[match.index]).length;
  const aggregate = native + commands.filter((operation) => operation.tool !== "exec").length <= 1;
  return out.map((spec) => spec ? { ...spec, aggregate, ...(spec.bash && native === 0 && commands.every((operation) => operation.tool === "bash") ? { bash: { ...spec.bash, peers: commands.flatMap(({ command }) => command !== undefined && command !== spec.bash?.command ? [command] : []) } } : {}) } : undefined); };
const shellSpecs = (text: string, positions: Uint8Array): (SendSpec | undefined)[] =>
  [...text.matchAll(/\bdori\b/g)].filter((match) => positions[match.index] && /(?:^|[;\n|&])\s*$/.test(text.slice(0, match.index))).flatMap((match) => specsFromShell(text.slice(match.index)));
const sendSpecs = (value: unknown, shell: boolean): (SendSpec | undefined)[] => {
  if (typeof value === "string") return shell ? shellSpecs(value, shellSource(value)) : specsFromText(value);
  if (Array.isArray(value)) { if (value[0] === "dori") return specsFromArgv(value); return typeof value[0] === "string" ? [] : value.flatMap((part) => sendSpecs(part, shell)); }
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, part]) => ["command", "code", "argv", "args"].includes(key) ? sendSpecs(part, key === "command" || shell) : []); return [];
};

// Only an actual SENT/POSTED result of this session's own unambiguous tool call counts. A command alone, another Dori's
// send, assistant narration, another tool's quoted log, or a second send in the same eval is not a receipt. Detached eval
// results must name the originating cell id; one eval running multiple sends cannot prove which send succeeded.
const sendCalls = (transcript: string): SendCall[] => {
  const calls = new Map<string, SendCall>(), handles = new Map<string, SendCall>();
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; timestamp?: string; customType?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: string | { type?: string; id?: string; name?: string; arguments?: unknown; text?: string }[]; details?: Parameters<typeof backgroundStarts>[3] } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
        if (part.type !== "toolCall" || !part.id || !["eval", "bash", "monitor"].includes(part.name ?? "")) continue; const specs = sendSpecs(part.arguments ?? {}, part.name !== "eval"), spec = specs.length === 1 ? specs[0] : undefined; if (spec) calls.set(part.id, { id: part.id, tool: part.name ?? "", at: Date.parse(entry.timestamp ?? ""), ...spec, sent: false, detachedReceipt: spec.aggregate !== false });
      }
    } else if (entry.message?.role === "toolResult") {
      const call = entry.message.toolCallId ? calls.get(entry.message.toolCallId) : undefined;
      if (!call) continue;
      const text = typeof entry.message.content === "string" ? entry.message.content : (entry.message.content ?? []).map((part) => part.text ?? "").join("\n");
      const nested = entry.message.details?.toolCalls, bash = call.bash;
      // A sole posting operation is not necessarily the bash operation that started this handle.
      // Without args, only one source bash and one returned bash can establish the same one-to-one attribution.
      const attempts = bash ? (nested ?? []).filter((operation) => operation.name === "bash" && (operation.args?.command !== undefined ? operation.args.command === bash.command : bash.alone && nested?.filter((part) => part.name === "bash").length === 1)) : [];
      // The detach result can prove that every other execution already finished without a receipt.
      // Then only the posting operation can add a receipt in this cell's later completion.
      if (bash?.peers && !/\b(?:SENT|POSTED) \d{15,22}\b/.test(text) && bash.peers.every((command) => nested?.some((operation) => {
        const preview = operation.resultPreview;
        return operation.name === "bash" && operation.args?.command === command && preview !== undefined && !preview.endsWith("…") && !/\b(?:SENT|POSTED) \d{15,22}\b/.test(preview) && !backgroundStarts("bash", call.id, preview, undefined).length;
      }))) call.detachedReceipt = true;
      const jobs = call.tool === "bash" ? backgroundStarts(call.tool, call.id, text, entry.message.details) : attempts.flatMap((operation) => backgroundStarts("bash", call.id, operation.resultPreview ?? "", undefined));
      const started = [...new Set(jobs.filter(([kind]) => kind === "bash").map(([, id]) => id))];
      if (started.length === 1 && started[0]) handles.set(started[0], call);
      const receipt = bash && nested ? attempts.map((operation) => operation.resultPreview ?? "").join("\n") : call.aggregate === false ? "" : text;
      if (/\b(?:SENT|POSTED) \d{15,22}\b/.test(receipt)) call.sent = true;
    } else if (entry.type === "custom_message" && entry.customType === "senpi-codemode:notification" && typeof entry.content === "string") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(entry.content)) continue; const cell = entry.content.match(/Detached eval cell ([^\s]+) \((?:js|py)\) completed\./)?.[1], call = cell ? calls.get(cell) : undefined; if (call?.detachedReceipt) call.sent = true;
    } else if (entry.type === "custom_message" && entry.customType === "senpi-monitor:notification" && typeof entry.content === "string") {
      const handle = entry.content.match(/^(?:<system-reminder>\s*)?Background terminal session (bash_\w+) finished\b/)?.[1], call = handle ? handles.get(handle) : undefined;
      if (call && /\b(?:SENT|POSTED) \d{15,22}\b/.test(entry.content)) call.sent = true;
    }
  }
  return [...calls.values()];
};

export const discordAnswered = (transcript: string, row: AnswerRow): boolean =>
  sendCalls(transcript).some((call) => call.sent && call.at >= row.at && (row.qid ? call.to === row.thread && call.qids.has(row.qid) : call.to === row.channel && call.reply === row.id));
