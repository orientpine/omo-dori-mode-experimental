import { close } from "./runtime/omo-host/sessions.ts";
import { Registry, sessionOf, statusOf } from "./registry.ts";
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
  const closed = async (): Promise<boolean> => (await registry.list()).some((lane) => {
    const ref = sessionOf(lane);
    return ref?.runtime === "omo-host" && ref.id === id && statusOf(lane) === "closed";
  });
  if (await closed()) return closedResult;
  let raced = false;
  let result: ExecResult;
  try {
    result = await exec(cmd, argv);
  } finally {
    raced = await closed();
    if (raced) await close(exec, id);
  }
  return raced ? closedResult : result;
};
