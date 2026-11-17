import { isAbsolute, join } from "node:path";
import { laneSessionFiles } from "./auto-signals.ts";
import { leadText } from "./directives.ts";
import type { FlowDeps } from "./done-flow.ts";
import { leadSessionFiles, leadSessionIds } from "./lead-sessions.ts";
import type { Lane } from "./registry.ts";
import { skillRead } from "./skill-read.ts";
import { watchLog } from "./watch-log.ts";

type Block = { type?: string; name?: string; arguments?: unknown; text?: string };
type Entry = { type?: string; id?: string; customType?: string; timestamp?: string; message?: { role?: string; content?: string | Block[] } };

const namedSkills = (brief: string): string[] => {
  const text = leadText(brief);
  const names = new Set<string>();
  for (const m of text.matchAll(/\bload_skills\b["']?\s*[:=]\s*\[([^\]]*)\]/g)) {
    for (const n of (m[1] ?? "").matchAll(/["']([a-z][a-z0-9-]*)["']/g)) if (n[1]) names.add(n[1]);
  }
  for (const m of text.matchAll(/(?:\$|\bskill\s+[`"']?)([a-z][a-z0-9-]*)\b/g)) if (m[1]) names.add(m[1]);
  for (const m of text.matchAll(/\b([a-z][a-z0-9-]*)\/SKILL\.md\b/g)) if (m[1]) names.add(m[1]);
  for (const m of text.matchAll(/\bulw[- ](research|loop|plan)\b/g)) names.add(`ulw-${m[1]}`);
  if (/\bmass[- ]ulw\b/.test(text)) names.add("mass-ulw");
  return [...names];
};

const entries = (text: string): Entry[] => text.split("\n").flatMap((line) => {
  try { return [JSON.parse(line) as Entry]; }
  catch { return []; } // blank lines or the last entry still being written
});
const blocks = (e: Entry): Block[] => typeof e.message?.content === "string" ? [{ type: "text", text: e.message.content }] : e.message?.content ?? [];

// Warns after a successful claim, without changing its result or sends. Unknown/unreadable
// transcripts are not evidence of a missing read. Only the lane's own sessions count.
export const warnClaimSkills = async (deps: Pick<FlowDeps, "config" | "clock">, lane: Lane): Promise<void> => {
  let missing: string[];
  try {
    const brief = isAbsolute(lane.brief) ? lane.brief : join(lane.cwd ?? deps.config.defaultCwd, lane.brief);
    const skills = namedSkills(await Bun.file(brief).text());
    if (!skills.length) return;
    const lead = new Set(leadSessionFiles(deps.config.scorecard.leadSessions, deps.config.stateDir));
    const leadIds = leadSessionIds(deps.config.stateDir);
    const ids = new Set([lane.session, ...(lane.priorSessions ?? [])].filter(Boolean));
    const own: Entry[] = [];
    for (const file of laneSessionFiles(deps.config, lane)) {
      const text = await Bun.file(file).text();
      const rows = entries(text);
      const id = rows.find((e) => e.type === "session")?.id;
      // The lead's unknown-identity folder fallback may also hold this lane's identified session.
      if ((id && leadIds.has(id)) || (!ids.size && lead.has(file))) continue;
      if (ids.size ? !ids.has(id) : !text.includes(`[REPORT] ${lane.key} |`)) continue;
      own.push(...rows);
    }
    if (!own.length) return;
    const since = Date.parse(lane.openedAt);
    missing = skills.filter((skill) => !own.some((e) => {
      if (Date.parse(e.timestamp ?? "") < since) return false;
      if (e.type === "custom_message" && e.customType === `omo-${skill}:skill-pointer`) return true;
      return blocks(e).some((b) =>
        (e.message?.role === "user" && b.type === "text" && b.text?.includes(`<omo-${skill}-pointer>`)) ||
        (e.message?.role === "assistant" && b.type === "toolCall" && skillRead(b.name, b.arguments, skill)));
    }));
  } catch { return; } // unavailable brief/session files: preserve claim-done's behavior
  for (const skill of missing) {
    const line = `SKILL_NOT_READ ${lane.key}: ${skill} has no SKILL.md read or attached skill pointer in the lane's sessions (directive skill-check; a warning for now, refusal to be reviewed on 2026-12-01)`;
    console.error(line);
    try { watchLog(deps.config.watchLog, deps.clock, { source: "claim-done", line }); }
    catch { /* A warning must not fail a recorded claim when the log is unavailable. */ }
  }
};
