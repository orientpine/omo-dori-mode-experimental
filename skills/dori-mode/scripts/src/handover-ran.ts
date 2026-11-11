// A command watch the new session armed and ran to its end is not missing: omo drops an ended watch from its manifest, so
// the handover reads its wake in the session log instead (SooDori's lead handover 20261111-142213 rolled back on a gate
// that printed UPDATE_QUIET_456 and exited 0 two minutes before the check). omo writes no exit record to the log, only
// the wake's text, which a watch's own lines can forge; the end counts only where they cannot: omo passes a line only
// when the watch's filter matches it (command-monitor-source.js), its own summary "watcher completed (exit code 0)" goes
// in after the watch's last line (a line that reads like it, \r redraws included, comes before it), and a wake's details
// name the monitors it carries. So a watch counts as ended well when a wake carrying it alone has a summary kind and ends
// with that summary's words, its filter cannot match them, and an earlier or the same wake carried a line of it (its
// signal); an omo notice after the summary (overflow, pause) leaves it missing. A watch with no filter, an exit other than 0, a kill, or two watches
// of one description with different commands stay missing.
import { readFileSync } from "node:fs";

import { launchOf, type MonitorSpec, sameCommand } from "./handover.ts";
import { sameWatch } from "./handover-monitors.ts";
import { sessionFile } from "./rollover.ts";

const DONE = "watcher completed (exit code 0)";
type Armed = { readonly description?: string; readonly command?: string; readonly filter?: string; readonly persistent?: boolean };
type Row = { readonly armed: Armed } | { readonly wake: { readonly description: string; readonly kinds: readonly string[]; readonly bodies: readonly string[] } };
type Line = {
  type?: string;
  customType?: string;
  content?: unknown;
  details?: { monitors?: { description?: string; kinds?: string[] }[] };
  message?: { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: { type?: string; id?: string; name?: string; arguments?: Armed }[]; details?: { toolCalls?: { name?: string; ok?: boolean; args?: Armed }[] } };
};

// the new session's monitor calls (in an eval cell, or the monitor tool itself) and its single-monitor wakes, in order
const rows = (text: string): Row[] => {
  const out: Row[] = [];
  const calls = new Map<string, Armed>();
  for (const raw of text.split("\n")) {
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const m = l.message;
    if (l.type === "message" && m?.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall" && c.name === "monitor" && c.id && c.arguments) calls.set(c.id, c.arguments);
    if (l.type === "message" && m?.role === "toolResult" && m.toolName === "eval") for (const c of m.details?.toolCalls ?? []) if (c.name === "monitor" && c.ok === true && c.args) out.push({ armed: c.args });
    const direct = m?.toolCallId ? calls.get(m.toolCallId) : undefined;
    if (l.type === "message" && m?.role === "toolResult" && m.toolName === "monitor" && !m.isError && direct) out.push({ armed: direct });
    const only = l.details?.monitors?.length === 1 ? l.details.monitors[0] : undefined;
    if (l.type !== "custom_message" || l.customType !== "senpi-monitor:notification" || typeof l.content !== "string" || !only?.description) continue;
    const header = `<system-reminder>Monitor event(${only.description}): `;
    if (!l.content.startsWith(header) || !l.content.endsWith("</system-reminder>")) continue;
    out.push({ wake: { description: only.description, kinds: only.kinds ?? [], bodies: l.content.slice(header.length, -"</system-reminder>".length).split("\n") } });
  }
  return out;
};

const cannotPass = (filter: string | undefined): boolean => {
  try {
    return !!filter && !new RegExp(filter).test(DONE);
  } catch {
    return false;
  }
};

// done for missingMonitors: the new session armed m again (a LAUNCHES_WORK one as a watch-only one with its description or
// filter, any other with its command and filter) and that watch ended with exit code 0 after its signal; or also(m)
export const ranToEnd = (sessionDir: string, session: string, home: string, also: (m: MonitorSpec) => boolean = () => false): ((m: MonitorSpec) => boolean) => {
  let log: Row[] | undefined;
  const read = (): Row[] => {
    if (log) return log;
    const file = sessionFile(sessionDir, session);
    try {
      log = file ? rows(readFileSync(file, "utf8")) : [];
    } catch {
      log = [];
    }
    return log;
  };
  return (m) => {
    if (also(m)) return true;
    if (!m.command) return false;
    const launch = m.launch ?? launchOf(m.command, home);
    const carries = (a: Armed): boolean =>
      a.persistent === true && !!a.command && (launch
        ? !launchOf(a.command, home) && (sameWatch(m.description, a.description) || (!!m.filter && a.filter === m.filter))
        : sameCommand(m.command ?? "", a.command, home) && (!m.filter || a.filter === m.filter));
    const all = read();
    return all.some((r, i) => {
      if (!("armed" in r) || !carries(r.armed) || !cannotPass(r.armed.filter) || !r.armed.description) return false;
      const { description, command, filter } = r.armed;
      // one description, one watch: a wake names its monitor only by description
      if (all.some((o) => "armed" in o && o.armed.description === description && (o.armed.command !== command || o.armed.filter !== filter))) return false;
      const wakes = all.slice(i + 1).flatMap((o) => ("wake" in o && o.wake.description === description ? [o.wake] : []));
      const end = wakes.findIndex((w) => w.kinds.includes("summary") && w.bodies.at(-1) === DONE);
      return end >= 0 && wakes.slice(0, end + 1).some((w) => w.kinds.includes("line"));
    });
  };
};
