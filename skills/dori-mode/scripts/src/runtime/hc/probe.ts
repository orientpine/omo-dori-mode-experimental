// From upstream dori-superagent src/runtime/hc/probe.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/src/runtime/hc/probe.ts; #147 #148 #150 #155, licences in NOTICE).
import { interactiveShellInFront, namesAgent } from "../foreground.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import type { Exec } from "../exec.ts";
import { hcCall, isKind } from "./exec.ts";
import { foregroundGroup } from "./front.ts";

const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "error", "done"]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function foregroundOf(value: unknown): ForegroundProcess | undefined {
  const fg = rec(value);
  const name = text(fg?.["name"]);
  if (fg === undefined || name === undefined) return undefined;
  const argv = Array.isArray(fg["argv"]) ? fg["argv"].filter((a): a is string => typeof a === "string") : [name];
  const pid = num(fg["pid"]);
  return { name, argv, ...(pid === undefined ? {} : { pid }) };
}

/** The status word of hc's `status` field (an object `{state}`, or a bare word in `ls` rows); undefined when it never reported. */
export function statusWord(value: unknown): AgentStatus | undefined {
  const word = typeof value === "string" ? value : text(rec(value)?.["state"]);
  if (word === undefined) return undefined;
  return REPORTED.has(word) ? (word as AgentStatus) : "unknown";
}

/**
 * One `hc get` record as a Probe. The status is the program's own OSC 7501 word; a program that never reported is a
 * `shell` when an interactive shell leads the foreground, else `unknown`. No screen reading: the word is authoritative.
 */
export function parseProbe(terminal: unknown): Probe {
  const t = rec(terminal) ?? {};
  if (t["state"] === "finished") return { status: "gone", shellInFront: false };
  const fg = foregroundOf(t["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const shellInFront = interactiveShellInFront(foreground);
  const status = statusWord(t["status"]) ?? (shellInFront ? "shell" : "unknown");
  const agent = text(rec(t["status"])?.["app"]) ?? fg?.name;
  const [rootPid, turn, title, cwd] = [num(t["pid"]), num(t["turn"]), text(t["title"]), text(t["cwd"])];
  return {
    status,
    ...(agent === undefined ? {} : { agent }),
    ...(fg?.pid === undefined ? {} : { pgid: fg.pid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(turn === undefined ? {} : { turn }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/**
 * upstream sisyphuslabs/dori-superagent#277: hc can report a status with no `foreground` (seen for up to ~0.5 s after a
 * first report), which alone proves nothing (a suspended agent, #66). The OS process table is read instead: the agent is
 * in front only when the terminal's foreground group holds no interactive shell and a member names the app hc reported.
 * Anything less leaves the doubt (`shellInFront`) as it was. A remote address (`machine/t7`) is never matched against
 * this machine's table.
 */
async function withOsForeground(exec: Exec, id: string, parsed: Probe): Promise<Probe> {
  const { foreground, agent, rootPid } = parsed;
  if (foreground !== undefined || agent === undefined || rootPid === undefined || id.includes("/")) return parsed;
  const group = await foregroundGroup(exec, rootPid);
  if (group === undefined || interactiveShellInFront(group.processes) || !namesAgent(group.processes, agent)) return parsed;
  return { ...parsed, pgid: group.pgid, shellInFront: false, foreground: group.processes };
}

/** `hc get`: a terminal hc no longer knows is `gone`; any other failure throws (the caller decides what doubt means). */
export async function probe(exec: Exec, id: string): Promise<Probe> {
  let parsed: Probe;
  try {
    parsed = parseProbe(await hcCall(exec, ["get", id]));
  } catch (e) {
    if (isKind(e, "not_found")) return { status: "gone", shellInFront: false };
    throw e;
  }
  return withOsForeground(exec, id, parsed);
}
