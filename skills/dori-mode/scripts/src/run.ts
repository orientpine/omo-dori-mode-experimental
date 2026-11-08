import { join } from "node:path";

import type { Exec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { ConfigError, type RuntimeSource } from "./runtime/select.ts";
import type { RuntimeKind, SessionRuntime } from "./runtime/types.ts";

export type Ran = { readonly code: number; readonly out: string; readonly err: string };
// env: variables set for this one command on top of the process environment; an undefined value removes the variable
// preserveOutput: stdout as printed, not trimmed (git status -z starts with a status column that may be a space)
export type RunOptions = { readonly cwd?: string | undefined; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string | undefined>>; readonly preserveOutput?: boolean };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

// aoe and tmux can start the tmux server, and every pane it opens later inherits the server's environment: a Dori's
// variables (token, inbox, lead) handed to them would make every session, another Dori's included, run as this one.
// herdr's panes take the herdr server's environment too, so herdr gets the same.
export const childEnv = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> =>
  ["aoe", "tmux", "herdr"].includes(argv[0]?.split("/").pop() ?? "") ? Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DORI_"))) : { ...env };

// A hook such as ["dori", "thread", "reply", ...] names the dori command. On native Windows that command is dori.ps1,
// which Bun.spawn cannot start, so the hook runs this CLI with this Bun directly (no shell, the arguments as they are).
export const commandArgv = (argv: readonly string[], platform: string = process.platform): readonly string[] =>
  platform === "win32" && argv[0] === "dori" ? [process.execPath, join(import.meta.dir, "cli.ts"), ...argv.slice(1)] : argv;

export const run: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  argv = commandArgv(argv);
  try {
    // env: process.env explicitly, or Bun hands the child its start-up environment without what loadEnvFile added from dori.env
    const env = Object.fromEntries(Object.entries(childEnv(argv, opts.env ? { ...process.env, ...opts.env } : process.env)).filter(([, v]) => v !== undefined));
    p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", env, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}) });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code: p.signalCode ? 124 : code, out: opts.preserveOutput ? out : out.trim(), err: (p.signalCode ? `killed by ${p.signalCode} (timeout)` : err).trim() };
};

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

// The session runtime of upstream #154 (https://github.com/sisyphuslabs/dori-superagent/pull/154, its run.ts): one registry of
// runtimes per process, each stored session answered by its own kind, new sessions opened on the chosen one.
type Env = Readonly<Record<string, string | undefined>>;
// "default": nothing chose one, so herdr, where every Dori runs (owner Q22 2026-11-08: the default stays herdr). Upstream
// detects instead (HC_TERMINAL_ID, HERDR_PANE_ID, the one binary on PATH) and refuses both or neither, which would stop a
// timer that runs outside any pane.
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource | "default" };

const KINDS: Readonly<Record<RuntimeKind, true>> = { herdr: true, hc: true };
const isKind = (value: string): value is RuntimeKind => Object.hasOwn(KINDS, value);

// The kinds a Dori may open its sessions on. hc waits: the fork's own openers and readers (launch, handover, revive, the
// screen reads and the close of a lane) still address a session by its pane id, where an hc id (t7) reads as a tmux name
// (docs/follow-ups.md, review 1 of #393), so a Dori on hc would list its sessions there and drive them on herdr or tmux.
export const FORK_RUNTIMES: readonly RuntimeKind[] = ["herdr"];
const notWired = (kind: RuntimeKind, where: string): ConfigError =>
  new ConfigError(`${where} "${kind}" is not wired in this fork yet (lanes would still be opened, read and closed on herdr or tmux; docs/follow-ups.md): leave it unset or "herdr"`);

// DORI_RUNTIME > the config's runtime > herdr
export const runtimeChoice = (config: { readonly runtime?: RuntimeKind | undefined }, env: Env): RuntimeChoice => {
  const fromEnv = env["DORI_RUNTIME"];
  if (fromEnv) {
    if (!isKind(fromEnv)) throw new ConfigError(`DORI_RUNTIME must be "herdr" or "hc", got ${JSON.stringify(fromEnv)}`);
    if (!FORK_RUNTIMES.includes(fromEnv)) throw notWired(fromEnv, "DORI_RUNTIME");
    return { kind: fromEnv, source: "env" };
  }
  if (config.runtime && !FORK_RUNTIMES.includes(config.runtime)) throw notWired(config.runtime, "runtime");
  return config.runtime ? { kind: config.runtime, source: "config" } : { kind: "herdr", source: "default" };
};

// A choice that failed (a bad DORI_RUNTIME) is thrown only where a new session would open or every kind is listed
// (default): a stored session (for) and the caller's own (selfAny) still resolve.
export class ChosenRuntimes extends Runtimes {
  readonly choice: RuntimeChoice | undefined;
  readonly failure: Error | undefined;

  constructor(pick: () => RuntimeChoice, make: (kind: RuntimeKind) => SessionRuntime) {
    let choice: RuntimeChoice | undefined;
    let failure: Error | undefined;
    try {
      choice = pick();
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    super(choice?.kind ?? "herdr", make);
    this.choice = choice;
    this.failure = failure;
  }

  override get default(): SessionRuntime {
    if (this.failure) throw this.failure;
    return super.default;
  }
}

// Every runtime behind the scripts' Runner, so a test's fake runner answers the runtime's calls as it answered the herdr
// calls before (the same argv, ["herdr", ...]); sleeps go through the clock.
export const execOf = (runner: Runner): Exec => async (cmd, argv) => {
  const r = await runner([cmd, ...argv]);
  return { code: r.code, stdout: r.out, stderr: r.err };
};

export const runtimesFor = (config: { readonly runtime?: RuntimeKind | undefined }, env: Env, runner: Runner = run, clock: Clock = realClock): ChosenRuntimes => {
  const exec = execOf(runner);
  const make: Record<RuntimeKind, () => SessionRuntime> = {
    herdr: () => new HerdrRuntime(exec, env["DORI_HERDR_SESSION"], { env, sleep: clock.sleep }),
    hc: () => new HcRuntime(exec, { env, sleep: clock.sleep }),
  };
  return new ChosenRuntimes(() => runtimeChoice(config, env), (kind) => make[kind]());
};

const built = new WeakMap<Runner, Map<string, ChosenRuntimes>>();

// One registry per Runner and configured runtime, so a sweep's calls share the runtimes it built.
export const runtimesOf = (runner: Runner, config: { readonly runtime?: RuntimeKind | undefined } = {}): ChosenRuntimes => {
  const byKind = built.get(runner) ?? new Map<string, ChosenRuntimes>();
  built.set(runner, byKind);
  const key = config.runtime ?? "";
  const rts = byKind.get(key) ?? runtimesFor(config, process.env, runner);
  byKind.set(key, rts);
  return rts;
};
