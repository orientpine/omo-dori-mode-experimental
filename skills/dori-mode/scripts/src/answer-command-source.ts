type Literal = { readonly end: number; readonly value?: string };
type CommandSource = { readonly code: Uint8Array; readonly strings: ReadonlyMap<number, Literal> };

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
export const executionCommands = (text: string, source: CommandSource): (string | undefined)[] => {
  const out: (string | undefined)[] = [];
  for (const match of text.matchAll(/\btool\.(?:bash|monitor)\s*\(\s*\{/g)) {
    if (!source.code[match.index]) continue;
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    for (let at = open + 1; at < text.length && depth; at++) {
      if (depth === 1 && !/[\w$]/.test(text[at - 1] ?? "") && (source.code[at] || source.strings.get(at)?.value === "command")) {
        const key = /^(?:command\b|"command"|'command')\s*:\s*/.exec(text.slice(at));
        if (key) {
          const start = at + key[0].length, value = source.strings.get(start);
          out.push(value && /^\s*[,}]/.test(text.slice(value.end)) ? value.value : undefined);
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
    out.push(value && (/^\s*[,)]/.test(text.slice(value.end)) || text[start] === "`") ? value.value : undefined);
  }
  return out;
};
