import { balancedBlock, commandSource, type CommandSource, shellSource } from "./answer-command-source.ts";
import { shellWords } from "./handover.ts";

export type OutputCall = { readonly start: number; readonly end: number; readonly shape: "process" | "stdout" | "shell" | "tool" };
export type NativeCall = OutputCall & { readonly buffered: boolean };
export const nativeCalls = (text: string, source: CommandSource): NativeCall[] => {
  const out: NativeCall[] = [];
  for (const match of text.matchAll(/(?<![\w$.])(?:exec|execSync|spawn|execFile|execa|subprocess\.run)\s*\(|\bBun\.spawn(?:Sync)?\s*\(|(?:\bBun\.\$|\$)\s*(?=`)/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].length - 1, block = text[open] === "(" ? balancedBlock(text, open) : undefined;
    const args = block?.slice(1, -1).trim() ?? "", argv = args[0] === "[" ? balancedBlock(args, 0) : undefined;
    // spawnSync's default stdout and stderr are pipes. Its discarded result adds no cell output.
    const shape = /^execSync\s*\(/.test(match[0]) ? "stdout" : /^(?:Bun\.\$|\$)/.test(match[0]) ? "shell" : "process";
    out.push({ start: match.index, end: block ? open + block.length : source.strings.get(open + 1)?.end ?? open + 1, shape, buffered: match[0].startsWith("Bun.spawnSync") && argv !== undefined && args.slice(argv.length).trim() === "" });
  }
  return out;
};

// A sole native operation can stream its own receipt. Explicit printed data still needs stdout provenance:
// even one subprocess cannot claim output supplied by a file read, an unknown consumer or another operation.
export const outputReceipt = (text: string, source: CommandSource, owner: OutputCall): boolean => {
  const calls = nativeCalls(text, source);
  if (calls.some((call) => call.start !== owner.start && !call.buffered)) return false;
  const before = text.slice(0, owner.start), binding = /\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:await\s*)?$/.exec(before);
  const name = binding && source.code[binding.index] ? binding[1] : undefined, nameAt = name ? before.lastIndexOf(name) : -1;
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let witnessed = owner.shape === "tool" || calls.length === 1;
  for (const match of text.matchAll(/\bconsole\.(?:log|info|warn|error)\s*\(|(?<![\w$.])(?:print|display)\s*\(/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].length - 1, raw = balancedBlock(text, open);
    if (!raw) return false;
    const end = open + raw.length;
    let expression = text.slice(open + 1, end - 1).trim();
    let attributed = false;
    if (owner.start > open && owner.end < end) { expression = `${text.slice(open + 1, owner.start)}$SEND${text.slice(owner.end, end - 1)}`.trim(); attributed = true; }
    else if (name) {
      const syntax = commandSource(expression);
      expression = expression.replace(new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g"), (word, at: number) => { if (!syntax.code[at]) return word; attributed = true; return "$SEND"; });
    }
    const syntax = commandSource(expression);
    let value = expression.replace(/(?<![\w$.])await(?![\w$])|\s+/g, (part, at: number) => syntax.code[at] ? "" : part);
    // These operations only remove boundary whitespace or unwrap a value. They cannot insert another source's receipt.
    for (;;) {
      const formatted = value.replace(/\.(?:trim|trimStart|trimEnd|strip|lstrip|rstrip)\(\)$/, "");
      if (formatted !== value) { value = formatted; continue; }
      const syntax = commandSource(value);
      let grouped = false;
      for (let at = 0; at < value.length; at++) {
        // A call's argument parentheses remain significant; a grouping receiver can occur anywhere in a decoder.
        if (value[at] !== "(" || !syntax.code[at] || /[\w$\])]/.test(value[at - 1] ?? "")) continue;
        const group = balancedBlock(value, at);
        if (!group) return false;
        value = value.slice(0, at) + group.slice(1, -1) + value.slice(at + group.length);
        grouped = true; break;
      }
      if (!grouped) break;
    }
    const root = { process: "\\$SEND\\.stdout", stdout: "\\$SEND", shell: "\\$SEND\\.stdout", tool: "\\$SEND\\.text" }[owner.shape], encoding = '(?:["\\\']utf-?8["\\\'])?';
    if (attributed && (new RegExp(`^(?:${root}(?:\\.(?:toString|decode)\\(${encoding}\\))?|newResponse\\(${root}\\)\\.text\\(\\)|newTextDecoder\\(${encoding}\\)\\.decode\\(${root}\\))$`).test(value) || owner.shape === "shell" && value === "$SEND.text()" || owner.shape === "tool" && value === "$SEND")) witnessed = true;
    else {
      const literal = commandSource(value).strings.get(0);
      if (literal?.value === undefined || literal.end !== value.length || /\b(?:SENT|POSTED) \d{15,22}\b/.test(literal.value)) return false;
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
      const args = words?.slice(1) ?? [], mode = /^(?:errexit|nounset|noglob|noclobber|pipefail)$/;
      // Only nonprinting set modes and literal absolute cd targets are silent setup. set/set -o, xtrace and cd -
      // can print; a cd error can quote its target, so a receipt-shaped target cannot establish silence either.
      const setup = words?.[0] === "set" && args.length > 0 && args.every((word, i) => /^[+-][efuC]+$/.test(word) || /^[+-][efuC]*o$/.test(word) && mode.test(args[i + 1] ?? "") || mode.test(word) && /^[+-][efuC]*o$/.test(args[i - 1] ?? ""))
        || words?.[0] === "cd" && args.length === 1 && args[0]?.startsWith("/") && !/[$`*?{}[\]]|\b(?:SENT|POSTED) \d{15,22}\b/.test(args[0]);
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
      out.push({ words, output: !setup && (stdout !== "silent" || stderr !== "silent"), stdout: stdout === "captured" && !pipe });
    }
    start = end + 1;
  }
  return out;
};
