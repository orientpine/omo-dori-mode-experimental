// From upstream dori-superagent src/runtime/foreground.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/src/runtime/foreground.ts; #147 #148 #150 #155, licences in NOTICE).
import { isAgentCommand } from "../executable.ts";
import type { ForegroundProcess } from "./types.ts";

export const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "ash",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "nu",
  "elvish",
  "xonsh",
  "pwsh",
  "powershell",
  "busybox",
]);

const baseName = (value: string): string => value.replace(/^-/, "").split("/").pop()?.toLowerCase() ?? "";
const isPowerShell = (shell: string): boolean => shell === "pwsh" || shell === "powershell";
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any
// other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  isPowerShell(shell) ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg) : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => isPowerShell(shell) && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when the foreground processes show an interactive shell, or cannot be read (`undefined` or empty is doubt).
 * A suspended agent leaves its shell in front while the runtime may still report it idle (#66). A shell that runs a
 * command flag (`sh -c ...`) is an agent's child, not a prompt, and does not count; any other shell, a script runner
 * such as `bash script.sh` included, is held. A runtime that reports only the group leader passes a one-element list.
 */
export function interactiveShellInFront(processes: readonly ForegroundProcess[] | undefined): boolean {
  if (processes === undefined || processes.length === 0) return true;
  for (const proc of processes) {
    let name = baseName(proc.name);
    let args = proc.argv.slice(1);
    const applet = args[0];
    if (name === "busybox" && applet !== undefined) [name, args] = [baseName(applet), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
  }
  return false;
}

const stem = (value: string): string => baseName(value).replace(/\.[^.]*$/, "");
const RUNS_NEXT: ReadonlySet<string> = new Set([".", "source", "exec"]);
const COMMAND_ZERO = /^(?:\$0|"\$0")$/;
// the fork's omo runs as bun (or node) on senpi's bundle and reports app omo (review 4 of #521): only that script as the
// runtime's first argument counts, never the bundle's path elsewhere on a command line (an editor opening it)
const JS_RUNTIMES: ReadonlySet<string> = new Set(["bun", "node"]);
const omoBundle = (argv: readonly string[]): boolean => JS_RUNTIMES.has(stem(argv[0] ?? "")) && isAgentCommand(argv[1] ?? "");

/** upstream sisyphuslabs/dori-superagent#277: accept an executable or a shell launcher that actually runs its $0. */
export function namesAgent(processes: readonly ForegroundProcess[], app: string): boolean {
  const want = app.toLowerCase();
  const matches = (word: string): boolean => {
    const name = stem(word);
    return name === want || name.startsWith(`${want}-`);
  };
  return processes.some(({ name, argv }) => {
    const executable = baseName(name);
    if (want === "omo" && omoBundle(argv)) return true;
    if (!SHELLS.has(executable)) return matches(argv[0] ?? name);
    const flag = argv.findIndex((arg, i) => i > 0 && runsCommand(executable, arg));
    if (flag < 0) return false;
    const zero = flag + (RUNS_NEXT.has(argv[flag + 1] ?? "") ? 2 : 1);
    const script = argv[zero + 1];
    return COMMAND_ZERO.test(argv[zero] ?? "") && script?.includes("/") === true && matches(script);
  });
}
