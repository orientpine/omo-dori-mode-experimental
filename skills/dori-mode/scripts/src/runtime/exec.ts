// From upstream dori-superagent src/runtime/exec.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/src/runtime/exec.ts; #147 #148 #150 #155, licences in NOTICE).
// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
// env: variables for this one call on top of the inherited environment; an undefined value removes the variable
export type ExecEnv = Readonly<Record<string, string | undefined>>;
export type Exec = (cmd: string, argv: readonly string[], env?: ExecEnv) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv, env) => {
  const childEnv = env && Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined));
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore", ...(childEnv ? { env: childEnv } : {}) });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. */
export class ToolError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: ExecResult,
    tool: string,
  ) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}
