// From upstream dori-superagent src/runtime/hc/deliver.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/src/runtime/hc/deliver.ts; #147 #148 #150 #155, licences in NOTICE).
import type { Exec } from "../exec.ts";
import type { AgentStatus, DeliverOptions, DeliverOutcome, Key } from "../types.ts";
import { hcCall, isKind } from "./exec.ts";
import { probe } from "./probe.ts";

const KEY_NAMES: Readonly<Record<Key, string>> = { enter: "enter", escape: "esc" };

const scrub = (message: string, text: string): string => (text === "" ? message : message.replaceAll(text, "<text>"));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The status after hc refused a compare-and-send; a failed re-read is reported as unknown. */
async function statusNow(exec: Exec, id: string): Promise<AgentStatus> {
  try {
    return (await probe(exec, id)).status;
  } catch {
    return "unknown";
  }
}

/**
 * Delivers one message as one argv element (nothing is expanded by a shell). Probe first: a shell in front is
 * `no-agent` whatever the reported status says (a suspended agent, #66), and blocked/error need `force`. hc's
 * `send` pastes and presses Enter atomically, so its refusals (`status_mismatch`, `blocked`) typed nothing and are
 * `not-ready`; an unknown or finished terminal is `no-agent`; any other failure may have arrived and is
 * `ambiguous` (#89). No outcome, detail or failure carries the text.
 */
export async function deliver(
  exec: Exec,
  id: string,
  text: string,
  opts: DeliverOptions = {},
): Promise<DeliverOutcome> {
  const { when = "idle", force = false } = opts;
  let before: Awaited<ReturnType<typeof probe>>;
  try {
    before = await probe(exec, id);
  } catch (e) {
    process.stderr.write(`dori: hc get ${id} failed (${messageOf(e)}); holding delivery\n`);
    return { kind: "not-ready", status: "unknown" };
  }
  if (before.status === "gone" || before.shellInFront) return { kind: "no-agent" };
  if (!force && (before.status === "blocked" || before.status === "error"))
    return { kind: "not-ready", status: before.status };
  // A terminal that has never reported (status null, no shell in front: an editor, a program without OSC 7501) gets
  // nothing typed into it whatever `when` says: its state is unknown, so the message stays queued.
  if (before.status === "unknown") return { kind: "not-ready", status: "unknown" };
  // `done` is the program's own "turn finished, waiting": typing is what it waits for, and `--if` takes only idle|working.
  const gate = when === "any" || (when === "idle" && before.status === "done") ? [] : ["--if", when];
  const argv = ["send", id, ...gate, ...(force ? ["--force"] : []), "--", text];
  let result: Record<string, unknown>;
  try {
    result = await hcCall(exec, argv, { redact: text });
  } catch (e) {
    if (isKind(e, "blocked")) return { kind: "not-ready", status: "blocked" };
    if (isKind(e, "status_mismatch")) return { kind: "not-ready", status: await statusNow(exec, id) };
    if (isKind(e, "not_found", "finished")) return { kind: "no-agent" };
    const detail = scrub(
      e instanceof Error && "reason" in e && typeof e.reason === "string" ? e.reason : messageOf(e),
      text,
    );
    return {
      kind: "ambiguous",
      detail: detail || "hc send did not complete",
      failure: e instanceof Error ? new Error(scrub(e.message, text)) : detail,
    };
  }
  const turn = typeof result["turn"] === "number" ? result["turn"] : undefined;
  const started = typeof result["started"] === "boolean" ? result["started"] : undefined;
  return { kind: "delivered", ...(turn === undefined ? {} : { turn }), ...(started === undefined ? {} : { started }) };
}

/** The operator's explicit `--to-shell`: only into a session whose probe says `shell`; no gate (a shell reports none). */
export async function typeIntoShell(exec: Exec, id: string, text: string): Promise<boolean> {
  if ((await probe(exec, id)).status !== "shell") return false;
  await hcCall(exec, ["send", id, "--", text], { redact: text });
  return true;
}

export async function keys(exec: Exec, id: string, names: readonly Key[]): Promise<void> {
  await hcCall(exec, ["keys", id, ...names.map((k) => KEY_NAMES[k])]);
}

export async function read(exec: Exec, id: string, lines: number): Promise<string> {
  const result = await hcCall(exec, ["read", id, "--lines", String(lines)]);
  return typeof result["text"] === "string" ? result["text"] : "";
}
