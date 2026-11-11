import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { SESSION_FILE, type SessionHit } from "./session-id.ts";

// Child environments survive /clear. Compare their resolved log with current-title logs by write time; an older
// same-name /resume wins when its log was written last, including after its identifying child ended (same-agent record).
const sessionName = (path: string): string | undefined => {
  const fd = openSync(path, "r"); try {
    const buffer = Buffer.alloc(256 * 1024), bytes = readSync(fd, buffer, 0, buffer.length, 0); let name: string | undefined;
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line.includes('"type":"session_info"')) continue;
      try { const entry = JSON.parse(line) as { name?: string }; if (entry.name) name = entry.name; } catch {}
    }
    return name; } finally { closeSync(fd); }
};

export const currentTranscript = (file: { readonly path: string; readonly via?: SessionHit["via"] }, title: string): string => {
  if (!title) return readFileSync(file.path, "utf8");
  const dir = dirname(file.path), matches = readdirSync(dir).filter((n) => SESSION_FILE.test(n)).sort().reverse().map((n) => join(dir, n)).filter((path) => sessionName(path) === title).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = matches[0], resolved = file.via === "child-env" && sessionName(file.path) === title;
  return readFileSync(newest && (!resolved || statSync(newest).mtimeMs > statSync(file.path).mtimeMs) ? newest : file.path, "utf8"); };
