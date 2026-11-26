// Whether a work monitor's command runs only in the foreground (handover.ts launchOf, detached): split from the watch
// list (handover-watch.ts) at its line cap; both read commands through the same lexer.
import { ASSIGN, CLOSE, CONTROL, lex, type Simple, type Word } from "./handover-watch-lex.ts";

// #414 review 41: a work monitor ends with its watch (detached false) only when every command word in it, at every depth,
// is a listed foreground tool or shell word; a path, a script, an unknown program or a shell fed a script keeps the watch.
// git is none (--upload-pack, -c core.fsmonitor, --exec run programs); gh only with these subcommands (extensions and aliases run programs)
// only tools that cannot start a program whatever their arguments (#414 review 42): not awk (system), sed (e), journalctl
// or systemctl (a pager), export or set (an environment a later program reads), nor any interpreter, wrapper or runner
const SHELL_READS = new Set(["histchars", "auto_resume"]);
const FOREGROUND = new Set(["sleep", "true", "false", "break", "continue", "cd", "cat", "echo", "date", "grep", "tail", "head", "sha256sum", "cut", "tr", "wc", "stat", "jq", "kill", "tee", "exit", "test", "["]);
// the lone word [ is the test command, not a glob
const plainWord = (w: Word | undefined, set: ReadonlySet<string>): boolean => !!w && !w.quoted && !w.expand && (!w.glob || w.text === "[") && set.has(w.text);
// test and [ only as [ A OP B ], [ OP A ] or [ A ]: OP a literal listed operator, no -v or -R anywhere (they evaluate a
// subscript), an expanded word only as an unsplit operand (#414 review 43); printf is out (-v assigns)
const TEST_BINARY = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge", "=", "!="]);
const TEST_UNARY = new Set(["-f", "-e", "-s", "-d", "-n", "-z"]);
const predicate = (ws: readonly Word[]): boolean => {
  const operand = (w: Word | undefined) => !!w && !w.split && !/^-[vR]$/.test(w.text);
  if (ws.length === 1) return operand(ws[0]);
  if (ws.length === 2) return plainWord(ws[0], TEST_UNARY) && operand(ws[1]);
  return ws.length === 3 && operand(ws[0]) && plainWord(ws[1], TEST_BINARY) && operand(ws[2]);
};
// gh only as a read: pr checkout, repo clone/sync/fork run git and its hooks, pr create/merge can open an editor
const GH_READS = new Map<string, ReadonlySet<string> | undefined>([
  ["pr", new Set(["checks", "view", "list", "status", "diff"])],
  ["run", new Set(["watch", "view", "list"])],
  ["api", undefined],
  ["release", new Set(["view", "list", "download"])],
  ["issue", new Set(["view", "list"])],
  ["repo", new Set(["view"])],
]);
const ghRead = (ws: readonly Word[], k: number): boolean => {
  const [sub, verb] = [ws[k + 1], ws[k + 2]];
  if (!plainWord(sub, new Set(GH_READS.keys()))) return false;
  const verbs = GH_READS.get(sub?.text ?? "");
  return !verbs || plainWord(verb, verbs);
};
export const foregroundOnly = (command: string): boolean => {
  const ok = (cmds: readonly Simple[]): boolean =>
    cmds.every((c) => {
      let k = 0;
      const names: string[] = [];
      for (let x = c.words[k]; x && ((!x.quoted && !x.expand && (CONTROL.has(x.text) || CLOSE.has(x.text))) || ASSIGN.test(x.text)); x = c.words[k]) {
        const name = ASSIGN.exec(x.text)?.[1];
        if (name) names.push(name);
        k++;
      }
      const w = c.words[k];
      // an assignment in front of a command (PAGER=x gh ...) hands that program an environment it may run
      if (names.length && w) return false;
      // a standalone assignment changes what later words run (PATH, IFS, BASH_ENV, PAGER, GH_...): only a lowercase name
      // the shell does not read itself (#414 review 44)
      if (names.some((n) => !/^[a-z_][a-z0-9_]*$/.test(n) || SHELL_READS.has(n))) return false;
      if (plainWord(w, new Set(["test", "["]))) {
        const args = c.words.slice(k + 1);
        if (w?.text === "[" ? !plainWord(args.at(-1), new Set(["]"])) || !predicate(args.slice(0, -1)) : !predicate(args)) return false;
      }
      return (!w || plainWord(w, FOREGROUND) || (plainWord(w, new Set(["gh"])) && ghRead(c.words, k))) && [...c.words, ...c.outs, ...c.ins].every((x) => x.subs.every(ok));
    });
  const r = lex(command, 0, false);
  return !!r && ok(r.cmds);
};
