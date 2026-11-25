import { readFileSync } from "node:fs";
import { liveSessions, sessionFor } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import { runtimesOf, type Runner } from "./run.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";

// The session's transcript holds the text as a user message at or after since (ms). A long text is matched by its first
// line, which omo keeps as typed; a paste-folded text shows up whole in the transcript.
export const transcriptHas = (transcript: string, text: string, since: number): boolean => {
  const head = (text.split("\n")[0] ?? "").trim().slice(0, 80);
  if (!head) return false;
  return transcript.split("\n").some((line) => {
    if (!line.includes('"user"')) return false;
    try {
      const o = JSON.parse(line) as { timestamp?: string; message?: { role?: string; content?: unknown } };
      if (o.message?.role !== "user" || !(Date.parse(o.timestamp ?? "") >= since)) return false;
      const c = o.message.content;
      const said = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("\n") : "";
      return said.includes(head);
    } catch {
      return false;
    }
  });
};

export const hostedTranscript = async (run: Runner, config: { readonly stateDir?: string }, ref: SessionRef): Promise<string | undefined> => {
  const rt = runtimesOf(run, config).for(ref);
  return await rt.observe?.(ref) ? (await rt.probe(ref)).transcriptPath : undefined;
};

export const paneTranscript = async (run: Runner, sessionsDir: string, pane: string): Promise<string | undefined> => {
  const ref = parseRef(pane);
  if (ref?.runtime === "omo-host") return hostedTranscript(run, {}, ref);
  const cwd = sessionFor(await liveSessions(run), pane)?.path;
  return cwd ? (await sessionFile(run, sessionsDir, pane, cwd))?.path : undefined;
};

export const paneTranscriptHas = async (run: Runner, sessionsDir: string, pane: string, text: string, since: number): Promise<boolean> => {
  const path = await paneTranscript(run, sessionsDir, pane).catch(() => undefined);
  try {
    return !!path && transcriptHas(readFileSync(path, "utf8"), text, since);
  } catch {
    return false;
  }
};
