import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, join } from "node:path";
import { envFileEntries, envFilePath } from "./config-env.ts";

import type { Exec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { ConfigError, type RuntimeSource } from "./runtime/select.ts";
import type { RuntimeKind, SessionRuntime } from "./runtime/types.ts";

export type Ran = { readonly code: number; readonly out: string; readonly err: string };
// env: variables set for this one command on top of the process environment; an undefined value removes the variable
// preserveOutput: stdout as printed, not trimmed (git status -z starts with a status column that may be a space)
// stdin: text written to the command's stdin, which is then closed (unset: no stdin)
export type RunOptions = { readonly cwd?: string | undefined; readonly timeoutMs?: number; readonly stdin?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly preserveOutput?: boolean };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

// aoe and tmux can start the tmux server, and every pane it opens later inherits the server's environment: a Dori's
// variables (token, inbox, lead) handed to them would make every session, another Dori's included, run as this one.
// herdr's panes take the herdr server's environment too, so herdr gets the same, and so does hc: any hc call may start
// the core, whose terminals inherit its environment (review 8 of #404). An hc call also goes to this Dori's own core,
// `core` (HC_SESSION from its dori.env, else the default core), never the caller's HC_SESSION: a stored hc:t<n> names a
// terminal of one core only, so a unit or shell that selects another core would act on someone else's terminal (H188).
// Nor do they get the caller's omo session (senpi's SESSION_ENVIRONMENT_KEYS, kernels/session-env.ts): an hc core a lead's
// shell started handed it to the next lead's agent and every monitor of it, which then named the old lead's session (MooDori
// hc:t1, 2026-11-11), nor the marker of the monitor that ran the call (SENPI_MONITOR_*): the next agent's tools would pass
// for monitors (review 6 of #460).
const OMO_SESSION = new Set(["PI_SESSION_ID", "PI_SESSION_FILE", "PI_SESSION_CWD", "PI_GOAL_STORE_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "OMO_BROWSER_ENGINE"]);
const SERVERS = ["aoe", "tmux", "herdr", "hc"];
export const childEnv = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>, core?: string, named = false): Record<string, string | undefined> => {
  const tool = argv[0]?.split("/").pop() ?? "";
  if (!SERVERS.includes(tool)) return { ...env };
  // HC_SOCKET outranks the session's socket in hc (paths.rs), so it goes with HC_SESSION (review 10 of #404)
  const clean: Record<string, string | undefined> = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DORI_") && !OMO_SESSION.has(name) && !name.startsWith("SENPI_MONITOR_") && (tool !== "hc" || (name !== "HC_SESSION" && (named || name !== "HC_SOCKET")))));
  return tool === "hc" && core ? { ...clean, HC_SESSION: core } : clean;
};

// the HC_SESSION a Dori's dori.env names, else none (the default core); read at each hc call
export const doriCore = (path: string = envFilePath()): string | undefined => {
  try {
    return envFileEntries(readFileSync(path, "utf8")).get("HC_SESSION") || undefined;
  } catch {
    return undefined;
  }
};

// hc's core listens at $XDG_RUNTIME_DIR/herdr-core/<core>.sock. It runs only when that socket accepts a connection within
// timeoutMs: a path alone may be a socket a killed core left (review 10 of #436). Read without an hc call, since any hc call
// starts a core.
export const hcCoreRunning = (core: string | undefined = doriCore(), env: Readonly<Record<string, string | undefined>> = process.env, timeoutMs = 1000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ path: join(env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid?.() ?? 0}`, "herdr-core", `${core ?? "default"}.sock`) });
    const done = (running: boolean) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

// A hook such as ["dori", "thread", "reply", ...] names the dori command. On native Windows that command is dori.ps1,
// which Bun.spawn cannot start, so the hook runs this CLI with this Bun directly (no shell, the arguments as they are).
export const commandArgv = (argv: readonly string[], platform: string = process.platform): readonly string[] =>
  platform === "win32" && argv[0] === "dori" ? [process.execPath, join(import.meta.dir, "cli.ts"), ...argv.slice(1)] : argv;

export const run: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  argv = commandArgv(argv);
  try {
    // env: process.env explicitly, or Bun hands the child its start-up environment without what loadEnvFile added from dori.env
    // a caller that names a core in opts.env keeps it (doriterm's bridges run in the host's own core, review 9 of #404)
    const named = opts.env !== undefined && Object.hasOwn(opts.env, "HC_SESSION");
    const core = argv[0]?.split("/").pop() !== "hc" ? undefined : named ? opts.env?.["HC_SESSION"] : doriCore();
    const env = Object.fromEntries(Object.entries(childEnv(argv, opts.env ? { ...process.env, ...opts.env } : process.env, core, named)).filter(([, v]) => v !== undefined));
    p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", env, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.stdin !== undefined ? { stdin: new Blob([opts.stdin]) } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}) });
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
// "default": nothing chose one and neither binary is on PATH, so herdr (an aoe Dori runs neither), where upstream refuses.
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource | "default" };

const KINDS: Readonly<Record<RuntimeKind, true>> = { herdr: true, hc: true };
export const isRuntimeKind = (value: unknown): value is RuntimeKind => typeof value === "string" && Object.hasOwn(KINDS, value);

const executable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// upstream #177 (https://github.com/sisyphuslabs/dori-superagent/pull/177, c275b55, its run.ts and runtime/select.ts):
// DORI_RUNTIME > the config's runtime > inside an hc terminal > inside a herdr pane > hc on PATH > herdr on PATH > herdr
export const runtimeChoice = (config: { readonly runtime?: RuntimeKind | undefined }, env: Env, exists: (path: string) => boolean = executable): RuntimeChoice => {
  const fromEnv = env["DORI_RUNTIME"];
  if (fromEnv) {
    if (!isRuntimeKind(fromEnv)) throw new ConfigError(`DORI_RUNTIME must be "herdr" or "hc", got ${JSON.stringify(fromEnv)}`);
    return { kind: fromEnv, source: "env" };
  }
  if (config.runtime) return { kind: config.runtime, source: "config" };
  if (env["HC_TERMINAL_ID"]) return { kind: "hc", source: "detect:HC_TERMINAL_ID" };
  if (env["HERDR_PANE_ID"]) return { kind: "herdr", source: "detect:HERDR_PANE_ID" };
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  for (const kind of ["hc", "herdr"] as const) if (dirs.some((dir) => exists(join(dir, kind)))) return { kind, source: "detect:path" };
  return { kind: "herdr", source: "default" };
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

// The Dori's own config.runtime, set once by the CLI after it loaded the config: a caller with no config at hand (an
// opener, a listing) then opens and lists on the runtime the config chose, not only on what DORI_RUNTIME says.
let configured: RuntimeKind | undefined;
export const useConfiguredRuntime = (kind: RuntimeKind | undefined): void => {
  configured = kind;
};

// One registry per Runner and configured runtime, so a sweep's calls share the runtimes it built.
export const runtimesOf = (runner: Runner, config: { readonly runtime?: RuntimeKind | undefined } = { runtime: configured }): ChosenRuntimes => {
  const byKind = built.get(runner) ?? new Map<string, ChosenRuntimes>();
  built.set(runner, byKind);
  const key = config.runtime ?? "";
  const rts = byKind.get(key) ?? runtimesFor(config, process.env, runner);
  byKind.set(key, rts);
  return rts;
};

// The runtime a new session of this backend opens on, picked as aoe.ts openAoeSession and herdr.ts openHerdrSession pick it,
// so a handover dry run names hc where the move opens hc (수돌 2026-11-11: the dry run said herdr, the move opened hc:t7)
export const openingRuntime = (runner: Runner, backend: "aoe" | "herdr"): string => (backend === "herdr" ? runtimesOf(runner).default.kind : "aoe");
