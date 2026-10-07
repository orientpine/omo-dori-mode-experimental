import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";

// A report the agent UI wrapped over several lines continues until the next blank line.
export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|done) \\| (?!<what)\\S`);
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => grammar.test(l));
  if (at < 0) return null;
  const parts = [lines[at]?.slice(lines[at]?.indexOf("[REPORT]")) ?? ""];
  for (const l of lines.slice(at + 1, at + 8)) {
    if (!l.trim() || l.includes("[REPORT]")) break;
    parts.push(l);
  }
  return parts.map((p) => p.trim()).join(" ").replace(/["'\])\s,]+$/, "");
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = { readonly kind: "nudged" | "nudge-failed" | "posted" | "no-report"; readonly lane: string; readonly detail: string };

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

// Lanes send [REPORT] lines to the lead pane, so that is where they are read first; the lane's own screen is the fallback.
// A report not seen before counts as hearing from the lane.
export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  let leadScreen: string | undefined;
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    leadScreen ??= deps.config.leadPane ? await readScreen(deps.run, deps.config.backend, deps.config.leadPane, 3000) : "";
    const report = lastReportLine(leadScreen, lane.key) ?? lastReportLine(await readScreen(deps.run, deps.config.backend, lane.pane, 200), lane.key);
    let current = lane;
    if (report && report !== lane.lastReport) {
      current = { ...current, lastReport: report, lastReplyAt: now };
      await deps.registry.patch(lane.key, { lastReport: report, lastReplyAt: now });
    }
    const heard = lastHeard(current);
    const silentMin = Math.round((now - heard) / 60_000);
    if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      const delivered = await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
      current = { ...current, lastNudgeAt: now };
      await deps.registry.patch(lane.key, { lastNudgeAt: now });
      acts.push({ kind: delivered ? "nudged" : "nudge-failed", lane: lane.key, detail: delivered ? `${silentMin} min silent` : `${silentMin} min silent; the nudge did not reach pane ${lane.pane}` });
    }
    const hook = deps.config.hooks.threadReply;
    if (silentMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) < heard) {
      if (!report) {
        acts.push({ kind: "no-report", lane: lane.key, detail: "pane has no [REPORT] line" });
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report, home)}`;
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      await deps.registry.patch(lane.key, { lastAutoReplyAt: now });
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};
