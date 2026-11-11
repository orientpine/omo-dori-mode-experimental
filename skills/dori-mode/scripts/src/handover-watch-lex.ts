// The lexer of the watch classifier (handover-watch.ts): words with quotes removed, $( ) bodies lexed as commands of their
// own, output and input redirections kept per simple command; anything it does not handle ends the lex as work (undefined).
// A word with its quotes removed, each $( ) lexed as commands of its own (subs, \0 in the text); glob: an unquoted {*?[
export type Word = { readonly text: string; readonly quoted: boolean; readonly expand: boolean; readonly glob: boolean; readonly subs: readonly Simple[][] };
// A simple command: its words, its output redirection targets ("&1" for a descriptor copy) and its input files.
export type Simple = { readonly words: Word[]; readonly outs: Word[]; readonly ins: Word[] };

// ; && || | and newlines split commands; ( ` # & alone, |&, ;;, here-docs and <( ) are never a plain poll, so the lexer gives up.
export const lex = (s: string, start: number, inSub: boolean): { cmds: Simple[]; end: number } | undefined => {
  const cmds: Simple[] = [{ words: [], outs: [], ins: [] }];
  const cur = (): Simple => cmds[cmds.length - 1] as Simple;
  let i = start;
  const word = (): Word | undefined => {
    let text = "", quoted = false, expand = false, glob = false;
    const subs: Simple[][] = [];
    const sub = (): boolean => {
      const r = s[i + 2] === "(" ? undefined : lex(s, i + 2, true);
      if (!r) return false;
      subs.push(r.cmds);
      i = r.end;
      text += "\0";
      expand = true;
      return true;
    };
    while (i < s.length && !/[\s;&|()<>]/.test(s[i] ?? "")) {
      const c = s[i] ?? "";
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) return undefined;
        text += s.slice(i + 1, j);
        quoted = true;
        i = j + 1;
      } else if (c === '"') {
        quoted = true;
        for (i++; s[i] !== '"'; ) {
          const d = s[i];
          if (d === undefined || d === "`" || (d === "$" && s[i + 1] === "{")) return undefined;
          if (d === "\\") {
            text += s[i + 1] ?? "";
            i += 2;
          } else if (d === "$" && s[i + 1] === "(") {
            if (!sub()) return undefined;
          } else {
            expand ||= d === "$";
            text += d;
            i++;
          }
        }
        i++;
      } else if (c === "\\") {
        text += s[i + 1] ?? "";
        i += 2;
      } else if (c === "`" || (c === "$" && s[i + 1] === "{")) return undefined;
      else if (c === "$" && s[i + 1] === "(") {
        if (!sub()) return undefined;
      } else {
        expand ||= c === "$";
        glob ||= /[*?[{]/.test(c);
        text += c;
        i++;
      }
    }
    return { text, quoted, expand, glob, subs };
  };
  while (i < s.length) {
    const c = s[i] ?? "";
    const fd = /^\d*[<>]/.exec(s.slice(i, i + 12));
    if (c === " " || c === "\t") i++;
    else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      if ((c === ";" && s[i + 1] === ";") || (c === "&" && s[i + 1] !== "&") || (c === "|" && s[i + 1] === "&")) return undefined;
      cmds.push({ words: [], outs: [], ins: [] });
      i += (c === "&" || c === "|") && s[i + 1] === c ? 2 : 1;
    } else if (c === ")") return inSub ? { cmds, end: i + 1 } : undefined;
    else if (c === "(" || c === "`" || c === "#") return undefined;
    else if (fd?.[0].endsWith("<")) {
      // an input file a listed program reads; <<, <<<, <( ), <& and <> are not
      i += fd[0].length;
      if (/[<(&>]/.test(s[i] ?? "")) return undefined;
      while (s[i] === " " || s[i] === "\t") i++;
      const w = /[\s;&|()<>]/.test(s[i] ?? ";") ? undefined : word();
      if (!w) return undefined;
      cur().ins.push(w);
    } else if (fd) {
      i += fd[0].length;
      if (s[i] === ">") i++;
      if (s[i] === "(" || s[i] === "|") return undefined;
      if (s[i] === "&") {
        const n = /^\d+/.exec(s.slice(i + 1));
        if (!n) return undefined;
        cur().outs.push({ text: `&${n[0]}`, quoted: false, expand: false, glob: false, subs: [] });
        i += 1 + n[0].length;
        continue;
      }
      while (s[i] === " " || s[i] === "\t") i++;
      const w = /[\s;&|()<>]/.test(s[i] ?? ";") ? undefined : word();
      if (!w) return undefined;
      cur().outs.push(w);
    } else {
      // every step advances: a blank the lexer does not split on (a carriage return) ends here as work (#414 review 22)
      const at = i;
      const w = word();
      if (!w || i === at) return undefined;
      cur().words.push(w);
    }
  }
  return inSub ? undefined : { cmds, end: i };
};
