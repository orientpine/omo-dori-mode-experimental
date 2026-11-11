// Which monitor commands only watch (#414). A command is a watch only when every command in it, at every depth ($( )
// too), is one of the plain poll shapes of the real handover notes (2026-11-11: 45 distinct commands in 86 lane and
// lead notes): tail -F | grep, until/while loops of sleep over grep, test, date or kill -0 <pid>, gh pr/run/api reads,
// git fetch/rev-parse/log polls, a plain sed or awk filter, a state file under $SENPI_MONITOR_STATE_DIR, and the same
// run as another account or host (node-dori-do, ssh). Anything else is work and keeps its watch, so a new session never
// arms it again (reviews 4-21 of #414 found a way around every list of forms that start work). Threat model: these are
// the lane's own monitors, not an attacker's; the list keeps ordinary work (a bun test, a dori review, a remote ci) from
// running twice. It trusts the listed programs and options to only read, and the session's environment. What it cannot
// read (a subshell, a background job, a here-doc, $(( )), ${ }, a comment) is work; a real watch missing here is work
// too, and the new session arms a watch-only monitor in its place: a manual step, never a second run.
// A word with its quotes removed; each $( ) in it is lexed as commands of its own (subs) and left as \0 in the text.
type Word = { readonly text: string; readonly quoted: boolean; readonly expand: boolean; readonly subs: readonly Simple[][] };
// A simple command: its words, its output redirection targets ("&1" for a descriptor copy) and its input files.
type Simple = { readonly words: Word[]; readonly outs: Word[]; readonly ins: Word[] };

// ; && || | and newlines split commands; ( ` # & alone, |&, ;;, here-docs and <( ) are never a plain poll, so the lexer gives up.
const lex = (s: string, start: number, inSub: boolean): { cmds: Simple[]; end: number } | undefined => {
  const cmds: Simple[] = [{ words: [], outs: [], ins: [] }];
  const cur = (): Simple => cmds[cmds.length - 1] as Simple;
  let i = start;
  const word = (): Word | undefined => {
    let text = "", quoted = false, expand = false;
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
        text += c;
        i++;
      }
    }
    return { text, quoted, expand, subs };
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
        cur().outs.push({ text: `&${n[0]}`, quoted: false, expand: false, subs: [] });
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

// The options each listed program may take (flags: short options alone; vals: short options with a value; num: -N),
// and what its other words may be. Any other option is work (date -s, grep -r, sort -o are not on the list).
type Spec = { readonly flags?: string; readonly vals?: string; readonly long?: readonly string[]; readonly longVals?: readonly string[]; readonly num?: boolean; readonly raw?: boolean; readonly operand?: (w: Word) => boolean };
const PROGRAMS = new Map<string, Spec>([
  ...["sleep", "true", "false", "break", "continue", "cd", "cat"].map((n) => [n, {}] as const),
  ...["echo", "printf", "test", "["].map((n) => [n, { raw: true }] as const),
  ["date", { flags: "u", vals: "d", operand: (w) => w.text.startsWith("+") }],
  ["grep", { flags: "qExvicFnsw", vals: "e", long: ["line-buffered"] }],
  ["tail", { flags: "Ff", vals: "n", num: true }],
  ["head", { vals: "nc", num: true }],
  ["sha256sum", {}],
  ["journalctl", { vals: "un", long: ["no-pager"] }],
  ["cut", { vals: "fcd" }],
  ["tr", { flags: "ds" }],
  ["wc", { flags: "lcw" }],
  ["stat", { vals: "c" }],
  // a filter on its input only: sed printing, quitting or substituting (no w, e or r command, no file), awk printing fields
  ["sed", { flags: "un", operand: (w) => /^(?:\/(?:[^/\\]|\\.)*\/[qpd]|s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/g?)$/.test(w.text) }],
  ["awk", { operand: (w) => /^\{\s*print(?:\s*(?:\$\d+|"[^"\\|>]*"|,))*\s*\}$/.test(w.text) }],
]);
const GH = new Map<string, Spec>([
  ["pr view", { vals: "Rq", longVals: ["repo", "json", "jq"] }],
  ["pr checks", { vals: "Rq", long: ["watch"], longVals: ["repo", "json", "jq", "interval"] }],
  ...["run list", "run view", "run watch"].map((n) => [n, { vals: "RLbq", long: ["exit-status"], longVals: ["repo", "branch", "limit", "json", "jq", "interval"] }] as const),
]);
const GH_API: Spec = { vals: "q", long: ["paginate"], longVals: ["jq"] }; // a GET: no -X, -f, -F or --input
const GIT = new Map<string, Spec>([["fetch", { flags: "q", long: ["quiet"] }], ["rev-parse", {}], ["log", { vals: "n", num: true, longVals: ["format"] }]]);
const RAW = new Set(["echo", "printf", "test", "["]);
const CONTROL = new Set(["if", "then", "else", "elif", "while", "until", "do", "{", "!"]);
const CLOSE = new Set(["fi", "done", "}"]);
const ASSIGN = /^([A-Za-z_]\w*)=/;
const SSH_OPTION = /^(?:BatchMode|ConnectTimeout|ServerAliveInterval|StrictHostKeyChecking)=[\w.-]+$/;
const VAR = /^[a-z_][a-z0-9_]*$/;
// the environment a watch may set for gh: its config folder, and a pager that only prints
const ENV = (w: Word): boolean => !w.subs.length && (/^GH_CONFIG_DIR=/.test(w.text) || w.text === "GH_PAGER=cat");

const argsOk = (spec: Spec, args: readonly Word[]): boolean => {
  if (spec.raw) return true;
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as Word).text;
    if (t.startsWith("--")) {
      const [name = "", value] = t.slice(2).split(/=(.*)/s);
      if (spec.longVals?.includes(name)) k += value === undefined ? 1 : 0;
      else if (!spec.long?.includes(name) || value !== undefined) return false;
    } else if (t.length > 1 && t.startsWith("-")) {
      if (spec.num && /^-\d+$/.test(t)) continue;
      for (let j = 1; j < t.length; j++) {
        const ch = t[j] ?? "";
        if (spec.vals?.includes(ch)) {
          k += j === t.length - 1 ? 1 : 0;
          break;
        }
        if (!spec.flags?.includes(ch)) return false;
      }
    } else if (spec.operand && !spec.operand(args[k] as Word)) return false;
  }
  return true;
};

// A state file: a path under $SENPI_MONITOR_STATE_DIR, or a variable every assignment of which in the command is one.
const stateFile = (aliases: ReadonlySet<string>) => (w: Word): boolean =>
  !w.subs.length && ((/^\$SENPI_MONITOR_STATE_DIR(?:\/[\w.-]+)+$/.test(w.text) && !w.text.split("/").includes("..")) || aliases.has(/^\$([a-z_]\w*)$/.exec(w.text)?.[1] ?? "\0"));

const simpleOk = (c: Simple, state: (w: Word) => boolean, hash: (w: Word) => boolean): boolean => {
  const w = c.words;
  const plain = (x: Word | undefined): x is Word => !!x && !x.quoted && !x.expand;
  let k = 0;
  while (plain(w[k]) && CONTROL.has(w[k]?.text ?? "")) k++;
  const rest = w.slice(k);
  if (!c.outs.every((o) => o.text === "/dev/null" || /^&\d+$/.test(o.text) || state(o))) return false;
  if (rest.every((x) => plain(x) && CLOSE.has(x.text))) return true;
  // a statement of assignments only, to lowercase shell variables (an exported or uppercase name reaches programs)
  if (rest.every((x) => ASSIGN.test(x.text))) return rest.every((x) => VAR.test(ASSIGN.exec(x.text)?.[1] ?? ""));
  let e = 0;
  while (ENV(rest[e] as Word) && rest[e + 1]?.text === "gh") e++;
  const [name, ...args] = rest.slice(e);
  if (!plain(name) || name.subs.length) return false;
  // an expansion ($name or $( )) may become options or other words, so it is an argument only of echo, printf, test and
  // [ and the right side of an assignment; elsewhere only a state file, and for git a hash from git rev-parse (#414 reviews 22, 23)
  if (!RAW.has(name.text) && name.text !== "export" && !args.every((x) => !x.expand || state(x) || (name.text === "git" && hash(x)))) return false;
  const a = args.map((x) => x.text);
  if (name.text === "tee") return argsOk({ flags: "a", operand: (x) => x.text === "/dev/null" || state(x) }, args);
  if (name.text === "kill") return a[0] === "-0" && a.length > 1 && a.slice(1).every((p) => /^\d+$/.test(p));
  if (name.text === "export") return args.every(ENV);
  if (name.text === "systemctl") return a.length === 2 && a[0] === "is-active" && !a[1]?.startsWith("-");
  if (name.text === "gh" && a[0] === "api") return !!a[1] && !a[1].startsWith("-") && argsOk(GH_API, args.slice(2));
  if (name.text === "gh") return !!GH.get(`${a[0]} ${a[1]}`) && argsOk(GH.get(`${a[0]} ${a[1]}`) as Spec, args.slice(2));
  // a watch run as another account (node-dori-do <account>) or host (ssh, a few plain options): its words are read
  // again as a command, as the remote shell reads them; anything there that is not a watch makes the whole command work
  if (name.text === "node-dori-do" || name.text === "ssh") {
    let k = 0;
    // only the ssh options of the real watches: -o with a value that runs nothing (no LocalCommand or ProxyCommand)
    while (name.text === "ssh" && (/^-[Tnq]$/.test(a[k] ?? "") || (a[k] === "-o" && SSH_OPTION.test(a[k + 1] ?? "")))) k += a[k] === "-o" ? 2 : 1;
    const remote = a.slice(k + 1).join(" ");
    const r = a[k] && !a[k]?.startsWith("-") && remote ? lex(remote, 0, false) : undefined;
    return !!r && cmdsOk(r.cmds, () => false, () => false);
  }
  if (name.text === "git") {
    const g = a[0] === "-C" ? args.slice(2) : args;
    const spec = GIT.get(g[0]?.text ?? "");
    return !!spec && argsOk(spec, g.slice(1));
  }
  const spec = PROGRAMS.get(name.text);
  return !!spec && argsOk(spec, args);
};

const cmdsOk = (cmds: readonly Simple[], state: (w: Word) => boolean, hash: (w: Word) => boolean): boolean =>
  cmds.every((c) => simpleOk(c, state, hash) && [...c.words, ...c.outs, ...c.ins].every((w) => w.subs.every((s) => cmdsOk(s, state, hash))));

const allWords = (cmds: readonly Simple[]): Word[] => cmds.flatMap((c) => [...c.words, ...c.outs, ...c.ins]).flatMap((w) => [w, ...w.subs.flatMap(allWords)]);

// true when the command only watches; false for work and for anything the list does not cover.
export const watchOnly = (command: string): boolean => {
  const r = lex(command, 0, false);
  if (!r) return false;
  const words = allWords(r.cmds);
  const values = new Map<string, Word[]>();
  for (const w of words) {
    const name = ASSIGN.exec(w.text)?.[1];
    if (name) values.set(name, [...(values.get(name) ?? []), { ...w, text: w.text.slice(name.length + 1) }]);
  }
  const direct = stateFile(new Set());
  // a variable every assignment of which is $(git [-C dir] rev-parse <words>): a hash, or one of those option-free words back
  const revParse = (v: Word): boolean => {
    const [c, ...more] = v.text === "\0" ? (v.subs[0] ?? []) : [];
    if (!c || more.length || c.outs.length || c.ins.length || c.words.some((x) => x.expand)) return false;
    const w = c.words.map((x) => x.text);
    const rest = w[1] === "-C" ? w.slice(3) : w.slice(1);
    return w[0] === "git" && rest[0] === "rev-parse" && rest.every((x) => !x.startsWith("-"));
  };
  const hashes = new Set([...values].filter(([n, vs]) => VAR.test(n) && vs.every(revParse)).map(([n]) => n));
  const aliases = new Set([...values].filter(([n, vs]) => VAR.test(n) && vs.every(direct)).map(([n]) => n));
  return r.cmds.some((c) => c.words.length > 0) && cmdsOk(r.cmds, stateFile(aliases), (w) => !w.subs.length && hashes.has(/^\$([a-z_]\w*)$/.exec(w.text)?.[1] ?? "\0"));
};
