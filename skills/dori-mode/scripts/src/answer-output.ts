import { balancedBlock, type CommandSource, shellSource } from "./answer-command-source.ts";
import { shellWords } from "./handover.ts";

export type NativeCall = { readonly start: number; readonly end: number; readonly buffered: boolean };
export const nativeCalls = (text: string, source: CommandSource): NativeCall[] => {
  const out: NativeCall[] = [];
  for (const match of text.matchAll(/(?<![\w$.])(?:exec|execSync|spawn|execFile|execa|subprocess\.run)\s*\(|\bBun\.spawn(?:Sync)?\s*\(|(?:\bBun\.\$|\$)\s*(?=`)/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].length - 1, block = text[open] === "(" ? balancedBlock(text, open) : undefined;
    const args = block?.slice(1, -1).trim() ?? "", argv = args[0] === "[" ? balancedBlock(args, 0) : undefined;
    // spawnSync's default stdout and stderr are pipes. Its discarded result adds no cell output.
    out.push({ start: match.index, end: block ? open + block.length : source.strings.get(open + 1)?.end ?? open + 1, buffered: match[0].startsWith("Bun.spawnSync") && argv !== undefined && args.slice(argv.length).trim() === "" });
  }
  return out;
};

// Accept a multi-operation native cell only when all printed data is the posting operation's stdout or receipt-free
// literals. Unknown consumers, aliases and inherited sibling output leave attribution unresolved.
export const nativeReceipt = (text: string, source: CommandSource, owner: NativeCall): boolean => {
  const calls = nativeCalls(text, source);
  if (calls.some((call) => call.start !== owner.start && !call.buffered)) return false;
  const before = text.slice(0, owner.start), binding = /\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:await\s*)?$/.exec(before);
  const name = binding && source.code[binding.index] ? binding[1] : undefined, nameAt = name ? before.lastIndexOf(name) : -1;
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let witnessed = false;
  for (const match of text.matchAll(/\bconsole\.(?:log|info|warn|error)\s*\(|(?<![\w$.])(?:print|display)\s*\(/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].length - 1, raw = balancedBlock(text, open);
    if (!raw) return false;
    const end = open + raw.length;
    let expression = text.slice(open + 1, end - 1).trim();
    if (owner.start > open && owner.end < end) expression = `${text.slice(open + 1, owner.start)}$SEND${text.slice(owner.end, end - 1)}`.trim();
    else if (name) expression = expression.replace(new RegExp(`^${name.replace(/[$]/g, "\\$&")}(?=\\.)`), "$SEND");
    const normalized = expression.replace(/\s+/g, "");
    if (/^(?:\$SEND\.stdout\.toString\(\)|(?:await)?newResponse\(\$SEND\.stdout\)\.text\(\)|newTextDecoder\(\)\.decode\(\$SEND\.stdout\))$/.test(normalized)) witnessed = true;
    else {
      const at = open + 1 + (text.slice(open + 1, end - 1).length - text.slice(open + 1, end - 1).trimStart().length), literal = source.strings.get(at);
      if (literal?.value === undefined || text.slice(literal.end, end - 1).trim() || /\b(?:SENT|POSTED) \d{15,22}\b/.test(literal.value)) return false;
    }
    ranges.push({ start: match.index, end });
  }
  if (!witnessed) return false;
  const covered = (at: number): boolean => ranges.some((range) => at >= range.start && at < range.end) || calls.some((call) => at >= call.start && at < call.end);
  for (const match of text.matchAll(/(?<![\w$.])[$\w]+(?:\.[$\w]+|\[[^\]\n]+\])*\s*\(/g)) {
    if (source.code[match.index] && !covered(match.index) && !/^(?:tool\.\w+|if|while|for|switch|catch)\s*\(/.test(match[0])) return false;
  }
  if (name) {
    for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g"))) {
      if (!source.code[match.index] || match.index === nameAt || ranges.some((range) => match.index >= range.start && match.index < range.end)) continue;
      if (!/^\.(?:exited|exitCode|signalCode)\b(?!\s*=(?!=))/.test(text.slice(match.index + name.length))) return false;
    }
  }
  return true;
};

export const commandWords = (command: string): string[] | undefined => {
  let quote = "", end = command.length;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#" && (i === 0 || /[\s;|&()]/.test(command[i - 1] ?? ""))) { end = i; break; }
    if (";|&\n".includes(c) && !(c === "&" && (/[<>]/.test(command[i - 1] ?? "") || command[i + 1] === ">"))) { end = i; break; }
  }
  return shellWords(command.slice(0, end));
};

export const shellCommands = (text: string): { readonly words: readonly string[] | undefined; readonly output: boolean; readonly stdout: boolean }[] => {
  const code = shellSource(text), out: { readonly words: readonly string[] | undefined; readonly output: boolean; readonly stdout: boolean }[] = [];
  let start = 0;
  for (let end = 0; end <= text.length; end++) {
    if (end < text.length && !(code[end] && ";|&\n".includes(text[end] ?? "") && !(text[end] === "&" && (/[<>]/.test(text[end - 1] ?? "") || text[end + 1] === ">")))) continue;
    while (start < end && (!code[start] || /\s/.test(text[start] ?? ""))) start++;
    if (start < end) {
      const raw = text.slice(start, end), words = commandWords(raw);
      let stdout = "captured", stderr = "captured";
      for (const match of raw.matchAll(/(?:^|\s)(\d*)(>&|>>?|&>)\s*/g)) {
        const op = match[2] ?? ">", at = start + match.index + match[0].lastIndexOf(op);
        if (!code[at]) continue;
        const target = shellWords(raw.slice(match.index + match[0].length))?.[0], fd = match[1] || "1";
        const sink = op === ">&" ? target === "1" ? stdout : target === "2" ? stderr : target === "-" ? "silent" : "unknown" : target === "/dev/null" ? "silent" : "unknown";
        if (op === "&>") { stdout = sink; stderr = sink; }
        else if (fd === "1") stdout = sink; else if (fd === "2") stderr = sink;
      }
      const pipe = text[end] === "|" && text[end + 1] !== "|" && text[end - 1] !== "|";
      out.push({ words, output: stdout !== "silent" || stderr !== "silent", stdout: stdout === "captured" && !pipe });
    }
    start = end + 1;
  }
  return out;
};
