type Literal = { readonly end: number; readonly value?: string };
export type CommandSource = { readonly code: Uint8Array; readonly strings: ReadonlyMap<number, Literal> };

export const balancedBlock = (text: string, start: number): string | undefined => {
  const close = text[start] === "[" ? "]" : text[start] === "(" ? ")" : "}";
  let depth = 0, quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === text[start]) depth++;
    else if (c === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
};

// Shell quotes, comments and heredoc bodies are data, not JavaScript execution wrappers.
export const shellSource = (text: string): Uint8Array => {
  const positions = new Uint8Array(text.length), documents: { readonly delimiter: string; readonly tabs: boolean }[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { positions[i] = 1; quote = c; continue; }
    if (c === "#" && (i === 0 || /[\s;|&()]/.test(text[i - 1] ?? ""))) {
      while (i < text.length && text[i] !== "\n") i++;
      if (i === text.length) break;
    }
    const document = text[i] === "<" && text[i + 2] !== "<" ? /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w-]+))/.exec(text.slice(i)) : null;
    if (document) {
      documents.push({ delimiter: document[2] ?? document[3] ?? document[4] ?? "", tabs: document[1] === "-" });
      i += document[0].length - 1; continue;
    }
    positions[i] = 1;
    if (text[i] !== "\n" || !documents.length) continue;
    let cursor = i + 1;
    for (const doc of documents) {
      while (cursor < text.length) {
        const next = text.indexOf("\n", cursor), end = next < 0 ? text.length : next, line = text.slice(cursor, end);
        cursor = next < 0 ? text.length : next + 1;
        if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      }
    }
    documents.length = 0; i = cursor - 1;
  }
  return positions;
};

// Keep template text out of executable positions, but scan ${...} as code, including nested templates and objects.
export const commandSource = (text: string): CommandSource => {
  const positions = new Uint8Array(text.length), strings = new Map<number, Literal>();
  let i = 0;
  const literal = (start: number, dynamic: boolean): void => {
    const raw = text.slice(start, i);
    let value: unknown;
    try {
      const quoted = raw[0] === "`" ? `"${raw.slice(1, -1).replace(/\\(?:\r\n|[\s\S])|["\r\n]/g, (part) => part.startsWith("\\") ? ["\\`", "\\$"].includes(part) ? part.slice(1) : part : JSON.stringify(part).slice(1, -1))}"` : raw;
      if (!dynamic) value = Bun.JSON5.parse(quoted);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    strings.set(start, { end: i, ...(typeof value === "string" ? { value } : {}) });
  };
  const scan = (interpolation: boolean): void => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i] ?? "", next = text[i + 1];
      if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
      if (c === '"' || c === "'") {
        const start = i++;
        while (i < text.length) { if (text[i] === "\\") i += 2; else if (text[i++] === c) break; }
        literal(start, false); continue;
      }
      if (c === "`") {
        const start = i++; let dynamic = false;
        while (i < text.length) {
          if (text[i] === "\\") i += 2;
          else if (text[i] === "`") { i++; break; }
          else if (text[i] === "$" && text[i + 1] === "{") { dynamic = true; i += 2; scan(true); }
          else i++;
        }
        literal(start, dynamic); continue;
      }
      if (interpolation && c === "}" && depth === 0) { i++; return; }
      positions[i] = 1;
      if (c === "{") depth++; else if (c === "}") depth--;
      i++;
    }
  };
  scan(false);
  return { code: positions, strings };
};

// Read only the command property of an actual execution wrapper. Other properties may contain dynamic JS values.
export type CommandExecution = { readonly tool: "bash" | "monitor" | "exec"; readonly command: string | undefined; readonly start: number; readonly end: number };
export const executionCommands = (text: string, source: CommandSource): CommandExecution[] => {
  const out: CommandExecution[] = [];
  for (const match of text.matchAll(/\btool\.(bash|monitor)\s*\(\s*\{/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    for (let at = open + 1; at < text.length && depth; at++) {
      if (depth === 1 && !/[\w$]/.test(text[at - 1] ?? "") && (source.code[at] || source.strings.get(at)?.value === "command")) {
        const key = /^(?:command\b|"command"|'command')\s*:\s*/.exec(text.slice(at));
        if (key) {
          const start = at + key[0].length, value = source.strings.get(start);
          const callOpen = match.index + match[0].indexOf("("), call = balancedBlock(text, callOpen);
          out.push({ tool: match[1] === "bash" ? "bash" : "monitor", command: call && value && /^\s*[,}]/.test(text.slice(value.end)) ? value.value : undefined, start: match.index, end: callOpen + (call?.length ?? 1) });
          break;
        }
      }
      const quoted = source.strings.get(at);
      if (quoted) { at = quoted.end - 1; continue; }
      if (source.code[at]) { if (text[at] === "{") depth++; else if (text[at] === "}") depth--; }
    }
  }
  for (const match of text.matchAll(/(?<![\w$.])(?:exec|execSync|subprocess\.run)\s*\(\s*|(?:\bBun\.\$|\$)\s*(?=`)/g)) {
    if (!source.code[match.index]) continue;
    const start = match.index + match[0].length;
    if (text[start] === "[") continue;
    const value = source.strings.get(start);
    const open = text.indexOf("(", match.index), call = text[start] === "`" ? undefined : balancedBlock(text, open);
    out.push({ tool: "exec", command: value && (/^\s*[,)]/.test(text.slice(value.end)) || text[start] === "`") ? value.value : undefined, start: match.index, end: text[start] === "`" ? value?.end ?? start + 1 : open + (call?.length ?? 1) });
  }
  return out;
};
