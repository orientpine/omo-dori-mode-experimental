import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRef } from "./runtime/types.ts";
import { runtimesOf, type Runner } from "./run.ts";
import { submitHosted } from "./sessions.ts";
import type { Submitted } from "./submit.ts";
import { asText, rec } from "./runtime/omo-host/exec.ts";

const consumedSince = (path: string, text: string, since: number): boolean => {
  let transcript: string;
  try { transcript = readFileSync(path, "utf8"); } catch { return false; }
  return transcript.split("\n").some((line) => {
    try {
      const entry = rec(JSON.parse(line));
      const message = rec(entry["message"]);
      const raw = message["timestamp"] ?? entry["timestamp"];
      const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
      const content = message["content"];
      const words = Array.isArray(content) ? content.map((part) => rec(part)["text"] ?? "").join("") : content;
      return entry["type"] === "message" && message["role"] === "user" && at >= since && (words === text || words === asText(text));
    } catch { return false; }
  });
};

type Mark = { at: number; status: "QUEUED" | "AMBIGUOUS" };

// Upstream https://github.com/sisyphuslabs/dori-superagent/pull/282 (hosted lanes); review 5 of PR 527.
// Claim the exact payload before the RPC. A concurrent call or a crash after dispatch must never replay it blindly.
export const verifiedHosted = async (run: Runner, stateDir: string, ref: SessionRef, text: string, now: number): Promise<Submitted> => {
  const dir = join(stateDir, "hosted-delivery", ref.id);
  const file = join(dir, createHash("sha256").update(text).digest("hex"));
  const rts = runtimesOf(run, { stateDir });
  const first: Mark = { at: now, status: "AMBIGUOUS" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, JSON.stringify(first), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let mark: Mark;
    try { mark = JSON.parse(readFileSync(file, "utf8")) as Mark; } catch { return { status: "AMBIGUOUS", reason: "prior hosted delivery cannot be verified; do not resend" }; }
    const rt = rts.for(ref);
    const probe = await (async () => await rt.observe?.(ref) ? rt.probe(ref) : undefined)().catch(() => undefined);
    if (probe?.transcriptPath && consumedSince(probe.transcriptPath, text, mark.at)) {
      // settled: the same text sent later is a new delivery, not this one again
      rmSync(file, { force: true });
      return { status: "SUBMITTED", reason: "prior hosted delivery found in the transcript" };
    }
    return { status: mark.status, reason: "prior hosted delivery is pending reconciliation; do not resend" };
  }
  const result = await submitHosted(rts, ref, text);
  if (result.status === "QUEUED") writeFileSync(file, JSON.stringify({ ...first, status: "QUEUED" } satisfies Mark), { mode: 0o600 });
  else if (result.status !== "AMBIGUOUS") rmSync(file);
  return result;
};
