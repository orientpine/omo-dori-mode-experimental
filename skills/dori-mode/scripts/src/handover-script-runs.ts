// #414 reviews 30-33: a script the handover reads can run another one it does not read, so a script fed to a shell ends
// with its watch only when every command in it (split at ; newlines | & ( ) { } and $( ), quotes kept), after assignments,
// control words, redirections at its start and env with only -u and NAME=value, starts with a word of this list (the
// commands of the real remote ci script and the QA job); anything else, a lone &, a backtick, an unclosed quote or $( ),
// or a redirection with no target keeps the watch.
const PLAIN = new Set(["cd", "bun", "git", "echo", "printf", "set", "export", "test", "[", "cat", "sleep", "true", "false", "exit", "mkdir", "date", "hostname", "cut", "nproc"]);
const REDIRECT = /^\d*(?:[<>]|&>)/;
const OPERATOR_ONLY = /^\d*(?:>>?|<|>&|&>>?|>\|)$/;
const CONTROL_WORD = /^(?:if|then|else|elif|fi|do|done|while|until|for|in|case|esac|function|!|\{|\})$/;
export const runsOther = (text: string): boolean => {
  // a backtick runs a command even inside double quotes (#414 review 34); a backslash escape is grammar this reader
  // does not follow, and an escaped quote opens no quote (review 35)
  if (text.includes("`") || text.includes("\\")) return true;
  const cmds: string[][] = [[]];
  let cur = 0;
  let w = "";
  let raw = false;
  const end = () => {
    if (w || raw) cmds[cur]?.push(w);
    w = "";
    raw = false;
  };
  const start = () => {
    end();
    cur = cmds.push([]) - 1;
  };
  // a $( ) body is commands of its own; after its ) the outer command goes on
  const outer: { readonly q: string | undefined; readonly cmd: number }[] = [];
  let q: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (q === "'") {
      if (c === "'") q = undefined;
      else w += c;
    } else if (c === "$" && text[i + 1] === "(") {
      end();
      outer.push({ q, cmd: cur });
      q = undefined;
      start();
      i++;
    } else if (q === '"') {
      if (c === '"') q = undefined;
      else w += c;
    } else if (c === "'" || c === '"') {
      q = c;
      raw = true;
    } else if (c === "#" && !w) i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i) - 1;
    else if (c === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) w += c;
    else if (c === "&" && text[i + 1] !== "&" && text[i - 1] !== "&") return true;
    else if (c === ")" && outer.length) {
      end();
      const o = outer.pop();
      q = o?.q;
      cur = o?.cmd ?? 0;
      raw = true;
    } else if (/[;\n|&(){}]/.test(c)) start(); else if (/\s/.test(c)) end();
    else w += c;
  }
  if (q || outer.length) return true;
  end();
  return cmds.some((ws) => {
    let k = 0;
    for (;;) {
      for (;;) {
        const x = ws[k] ?? "";
        if (CONTROL_WORD.test(x) || /^[A-Za-z_]\w*=/.test(x)) k++;
        else if (REDIRECT.test(x)) k += OPERATOR_ONLY.test(x) ? 2 : 1;
        else break;
      }
      if (k > ws.length) return true;
      if (ws[k] !== "env") break;
      for (k++; ws[k] === "-u" || /^[A-Za-z_]\w*=/.test(ws[k] ?? ""); ) k += ws[k] === "-u" ? 2 : 1;
    }
    const word = ws[k];
    // test and [ evaluate an array subscript with -v and -R and in arithmetic operands (#414 review 36)
    const args = word === "[" && ws.at(-1) === "]" ? ws.slice(k + 1, -1) : ws.slice(k + 1);
    if ((word === "test" || word === "[") && args.some((a) => /^-(?:v|R|eq|ne|lt|le|gt|ge)$/.test(a) || a.includes("[") || a.includes("$"))) return true;
    // printf -v assigns to a name, and a name with a subscript runs code; so can export (in the name before =) and set
    if (word === "printf" && args.includes("-v")) return true;
    if (word === "export" && args.some((a) => /[[$]/.test(a.split("=")[0] ?? ""))) return true;
    if (word === "set" && args.some((a) => /[[$]/.test(a))) return true;
    return word !== undefined && !PLAIN.has(word);
  });
};
