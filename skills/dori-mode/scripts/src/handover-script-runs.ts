// #414 reviews 30-31: a script the handover reads can run another one it does not read, so a script fed to a shell keeps
// its watch when any of its commands (split at ; newlines | & ( ) { } and $( ), quotes kept) has a command word, after
// assignments, control words and env with its -u and NAME=value words, that is a path, a .sh, an expansion, a shell or a
// word that runs another command; or when it puts a job in the background with a lone &.
const RUNNER = /^(?:(?:ba|z|da|k)?sh|source|\.|exec|eval|nohup|setsid|disown|sudo|su|timeout|nice|stdbuf|xargs|command|builtin|time|ssh|node-dori-do|flock|script|systemd-run|tmux|screen|watch|parallel)$/;
const CONTROL_WORD = /^(?:if|then|else|elif|fi|do|done|while|until|for|in|case|esac|function|!|\{|\})$/;
export const runsOther = (text: string): boolean => {
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
    } else if (c === "`") return true;
    else if (c === "#" && !w) i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i) - 1;
    else if (c === "&" && text[i + 1] !== "&" && text[i - 1] !== "&" && text[i - 1] !== ">" && text[i + 1] !== ">") return true;
    else if (c === ")" && outer.length) {
      end();
      const o = outer.pop();
      q = o?.q;
      cur = o?.cmd ?? 0;
      raw = true;
    } else if (/[;\n|&(){}]/.test(c)) start(); else if (/\s/.test(c)) end();
    else w += c;
  }
  end();
  return cmds.some((ws) => {
    let k = 0;
    for (;;) {
      while (CONTROL_WORD.test(ws[k] ?? "") || /^[A-Za-z_]\w*=/.test(ws[k] ?? "")) k++;
      if (ws[k] !== "env") break;
      for (k++; ws[k] === "-u" || /^[A-Za-z_]\w*=/.test(ws[k] ?? ""); ) k += ws[k] === "-u" ? 2 : 1;
    }
    const word = ws[k];
    // after env, any option but -u (-S, -C, -i, --split-string) can hide the command it runs (#414 review 32)
    return word !== undefined && (word.startsWith("-") || word.includes("/") || word.endsWith(".sh") || word.includes("$") || RUNNER.test(word));
  });
};
