import { Registry, statusOf } from "./registry.ts";
import type { Exec, ExecResult } from "./runtime/exec.ts";

let defaultStateDir: string | undefined;
export const useHostedCustody = (stateDir: string | undefined): void => { defaultStateDir = stateDir; };

const closedResult: ExecResult = { code: 3, stdout: '{"action":"refuse","reason":"unknown_session","detail":"Dori closed this lane"}', stderr: "" };
const resumes = new Set(["state", "read", "prompt", "steer", "abort"]);

// These verbs can resurrect a parked session. Check the registry on both sides of the real call, including failures.
export const hostedCustody = (exec: Exec, stateDir?: string): Exec => async (cmd, argv) => {
  const verb = argv[2];
  const id = argv[3];
  const dir = stateDir ?? defaultStateDir;
  if (!dir || !verb || !id || !resumes.has(verb)) return exec(cmd, argv);
  const registry = new Registry(dir);
  const pane = `omo-host:${id}`;
  const closed = async (): Promise<boolean> => (await registry.list()).some((lane) => lane.pane === pane && statusOf(lane) === "closed");
  if (await closed()) return closedResult;
  let raced = false;
  let result: ExecResult;
  try {
    result = await exec(cmd, argv);
  } finally {
    raced = await closed();
    if (raced) {
      const close = await exec(cmd, ["host", "session", "close", id, "--json"]);
      if (close.code !== 0 && !close.stdout.includes('"unknown_session"')) throw new HostedCustodyError(id);
    }
  }
  return raced ? closedResult : result;
};

class HostedCustodyError extends Error {
  constructor(readonly id: string) { super(`could not re-close hosted session ${id} after a concurrent lane close`); }
}
