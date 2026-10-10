export type Ran = { readonly code: number; readonly out: string; readonly err: string };
export type RunOptions = { readonly cwd?: string; readonly timeoutMs?: number };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

export const run: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    // env: process.env explicitly, or Bun hands the child its start-up environment without what loadEnvFile added from dori.env
    p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", env: process.env, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}) });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code: p.signalCode ? 124 : code, out: out.trim(), err: (p.signalCode ? `killed by ${p.signalCode} (timeout)` : err).trim() };
};

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();
