// The lexer of the watch classifier (handover-watch.ts): words with quotes removed, $( ) bodies lexed as commands of their
// own, output and input redirections kept per simple command; anything it does not handle ends the lex as work (undefined).
// A word with its quotes removed, each $( ) lexed as commands of its own (subs, \0 in the text); glob: an unquoted {*?[;
// split: an expansion or glob outside double quotes, which the shell may turn into more than one word; dup: a descriptor
// copy (>&1) the lexer read as an operator, never a quoted or expanded word that spells one (#414 review 28)
export type Word = { readonly text: string; readonly quoted: boolean; readonly expand: boolean; readonly glob: boolean; readonly split: boolean; readonly dup?: true; readonly subs: readonly Simple[][] };
// A simple command: its words, its output redirection targets ("&1" for a descriptor copy) and its input files.
export type Simple = { readonly words: Word[]; readonly outs: Word[]; readonly ins: Word[] };

// The words that open or continue a compound command in front of a simple one (do cmd, if cmd, { cmd).
export const CONTROL = new Set(["if", "then", "else", "elif", "while", "until", "do", "{", "!"]);
export const CLOSE = new Set(["fi", "done", "}", "esac"]);
export const ASSIGN = /^([A-Za-z_]\w*)=/;
const bare = (w: Word | undefined, text: string): boolean => !!w && !w.quoted && !w.expand && !w.glob && w.text === text;

// ; && || | and newlines split commands; ( ` # & alone, |&, here-docs and <( ) are never a plain poll, so the lexer gives up.
// A case statement (moodori lead, 2026-11-26) is read as commands too: its header [case, word, in], each list of patterns
// as one command whose first word is a bare ")" (no word the lexer reads spells one), ;; between clauses, esac a closing
// word; ;& ;;& and (pattern) are not read (a lone & ends the lex, an empty pattern word too).
export const lex = (s: string, start: number, inSub: boolean): { cmds: Simple[]; end: number } | undefined => {
  const cmds: Simple[] = [{ words: [], outs: [], ins: [] }];
  const cur = (): Simple => cmds[cmds.length - 1] as Simple;
  let i = start;
  let cases = 0, pattern = false;
  const word = (): Word | undefined => {
    // a # starting a word is a comment wherever the word is read: a command, a redirection target, a case pattern (#532 review 2)
    if (s[i] === "#") return undefined;
    let text = "", quoted = false, expand = false, glob = false, split = false;
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
        // an escaped character is quoted: \esac or \do is a plain word, never the shell's reserved one (#532 review 1)
        text += s[i + 1] ?? "";
        quoted = true;
        i += 2;
      } else if (c === "`" || (c === "$" && s[i + 1] === "{")) return undefined;
      else if (c === "$" && s[i + 1] === "(") {
        split = true;
        if (!sub()) return undefined;
      } else {
        expand ||= c === "$";
        glob ||= /[*?[{]/.test(c);
        split ||= c === "$" || glob;
        text += c;
        i++;
      }
    }
    return { text, quoted, expand, glob, split, subs };
  };
  const blanks = () => {
    while (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++;
  };
  while (i < s.length) {
    const c = s[i] ?? "";
    const fd = /^\d*[<>]/.exec(s.slice(i, i + 12));
    if (pattern) {
      blanks();
      if (i >= s.length) break;
      const first = word();
      if (!first?.text) return undefined;
      if (bare(first, "esac")) {
        cur().words.push(first);
        cases--;
        pattern = false;
        continue;
      }
      const pats = [first];
      for (blanks(); s[i] === "|"; blanks()) {
        i++;
        blanks();
        const w = word();
        if (!w?.text) return undefined;
        pats.push(w);
      }
      if (s[i] !== ")") return undefined;
      i++;
      cur().words.push({ text: ")", quoted: false, expand: false, glob: false, split: false, subs: [] }, ...pats);
      cmds.push({ words: [], outs: [], ins: [] });
      pattern = false;
    } else if (c === " " || c === "\t") i++;
    else if (c === ";" && s[i + 1] === ";") {
      if (!cases) return undefined;
      cmds.push({ words: [], outs: [], ins: [] });
      i += 2;
      pattern = true;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      if ((c === "&" && s[i + 1] !== "&") || (c === "|" && s[i + 1] === "&")) return undefined;
      cmds.push({ words: [], outs: [], ins: [] });
      i += (c === "&" || c === "|") && s[i + 1] === c ? 2 : 1;
    } else if (c === ")") return inSub && !cases ? { cmds, end: i + 1 } : undefined;
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
      const at = i;
      i += fd[0].length;
      if (s[i] === ">") i++;
      if (s[i] === "(" || s[i] === "|") return undefined;
      if (s[i] === "&") {
        // only the exact word 2>&1 copies a descriptor; >&1.log writes the file 1.log (#414 review 29)
        if (s.slice(at, i + 2) !== "2>&1" || !/^(?:[\s;&|)]|$)/.test(s.slice(i + 2, i + 3))) return undefined;
        cur().outs.push({ text: "&1", quoted: false, expand: false, glob: false, split: false, dup: true, subs: [] });
        i += 2;
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
      const ws = cur().words;
      ws.push(w);
      const lead = ws.findIndex((x) => !(CONTROL.has(x.text) && bare(x, x.text)));
      if (cases && bare(w, "esac") && lead === ws.length - 1) cases--;
      if (ws.length - lead === 3 && bare(ws[lead], "case") && bare(w, "in")) {
        cmds.push({ words: [], outs: [], ins: [] });
        cases++;
        pattern = true;
      }
    }
  }
  return inSub || cases || pattern ? undefined : { cmds, end: i };
};
