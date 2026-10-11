import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { researchCheck } from "./explore.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { fixTag, recordFix } from "./same-fix.ts";
import { statusLine } from "./lane-handover.ts";
import { crossed, repeatsOf, type Signals, type Who } from "./rollover.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchLog } from "./watch-log.ts";

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

export type SweepAct = { readonly kind: "nudged" | "nudge-failed" | "posted" | "no-report" | "same_fix_3" | "stuck" | "intent_check" | "research_started" | "research_not_started" | "rollover_due" | "rollover_auto"; readonly lane: string; readonly detail: string };

export type RolloverHooks = {
  // the length signals of the session in a pane: context use, compactions, age
  readonly signals: (pane: string, model: string) => Promise<Signals>;
  // starts a rollover without asking (handover.autoRolloverLanes / autoRolloverLead on); the line says what it started
  readonly auto?: (who: Who, key: string) => Promise<string>;
};

const screenSignals = (deps: FlowDeps): RolloverHooks => ({ signals: async (pane, model) => ({ contextPct: statusLine(await readScreen(deps.run, deps.config.backend, pane, 8), model).contextPct }) });

const leadDueFile = (stateDir: string): string => join(stateDir, "handover", "lead-due.json");

// A session past a threshold is due for a rollover. Freshness says so once per pane and only suggests: the lead asks the
// owner (dori rollover-propose) and runs the handover with their approval, unless the owner turned the auto key on.
const rolloverDue = async (deps: FlowDeps, hooks: RolloverHooks, who: Who, key: string, pane: string, model: string, seenPane: string | undefined, save: (pane: string, at: string, crossed: string[]) => Promise<void>, extra: Signals = {}): Promise<SweepAct[]> => {
  const h = deps.config.handover;
  if (deps.config.backend !== "aoe" || seenPane === pane) return [];
  const limits = who === "lane" ? { contextPct: h.laneContextPct, compactions: h.laneCompactions, ageH: h.laneAgeH, repeats: h.laneRepeats } : { contextPct: h.leadContextPct, compactions: h.leadCompactions, ageH: h.leadAgeH };
  const hit = crossed({ ...(await hooks.signals(pane, model).catch(() => ({}))), ...extra }, limits);
  if (!hit.length) return [];
  await save(pane, new Date(deps.clock.now()).toISOString(), hit);
  const run = who === "lane" ? `dori handover --lane ${key} --approved-by <card>` : "dori handover --approved-by <card>";
  const acts: SweepAct[] = [{ kind: "rollover_due", lane: key, detail: `${hit.join(", ")} in ${pane}: ask the owner with dori rollover-propose ${key} (a card with the note preview); with a yes, ${who === "lane" ? `once the lane is at a safe point (dori handover ready ${key}), ` : ""}run ${run}` }];
  const autoOn = who === "lane" ? h.autoRolloverLanes : h.autoRolloverLead;
  if (autoOn && hooks.auto) acts.push({ kind: "rollover_auto", lane: key, detail: await hooks.auto(who, key) });
  return acts;
};

// A milestone report that announces a new stage or phase is the moment to compare the lane's direction with the owner's goal.
export const stageChange = (report: string, pattern: string): boolean => /\| milestone \|/.test(report) && new RegExp(pattern, "i").test(report.replace(/^\[REPORT\][^|]*\|[^|]*\|/, ""));

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

// Lanes send [REPORT] lines to the lead pane, so that is where they are read first; the lane's own screen is the fallback.
// A report not seen before counts as hearing from the lane.
export const freshnessTick = async (deps: FlowDeps, home: string, hooks: RolloverHooks = screenSignals(deps)): Promise<SweepAct[]> => {
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
      const tag = fixTag(report);
      if (tag) {
        const { alert, notes } = await recordFix(deps, lane.key, { at: new Date(now).toISOString(), ...tag, via: "report" });
        if (alert) acts.push({ kind: "same_fix_3", lane: lane.key, detail: alert });
        for (const n of notes) acts.push({ kind: "stuck", lane: lane.key, detail: n });
      }
      if (stageChange(report, deps.config.explore.stagePattern)) {
        const detail = `stage change in a milestone report: run dori intent-check ${lane.key} and compare its direction with the owner's goal${lane.goal ? "" : " (no goal on record: set one with --goal)"}`;
        watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `INTENT_CHECK ${lane.key} ${detail}` });
        acts.push({ kind: "intent_check", lane: lane.key, detail });
      }
    }
    // a ulw research text sent to the lane: does its session log show the skill starting (RESEARCH_STARTED / _NOT_STARTED)
    if (lane.research && !lane.research.result) {
      const r = await researchCheck(deps, lane);
      if (r.verdict === "started" || r.verdict === "not-started") acts.push({ kind: r.verdict === "started" ? "research_started" : "research_not_started", lane: lane.key, detail: r.line.replace(/^RESEARCH_\w+ \S+ /, "") });
    }
    acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, current.rolloverDue?.pane, (pane, at, hit) => deps.registry.patch(lane.key, { rolloverDue: { pane, at, crossed: hit } }), { repeats: repeatsOf(current) })));
    const heard = lastHeard(current);
    const silentMin = Math.round((now - heard) / 60_000);
    if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      const delivered = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
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
      // the report is the lane's note to the lead; the owner gets a plain status line and the lead the note to retell
      const words = deps.config.discord;
      const text = words.postRawReports ? `Progress (from the lane's last report): ${scrubForThread(report, home)}` : words.quietText.replaceAll("{min}", String(silentMin));
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      await deps.registry.patch(lane.key, { lastAutoReplyAt: now });
      let lead = "";
      if (!words.postRawReports) {
        const pane = deps.config.leadPane;
        const note = `[DORI] ${lane.key}: ${silentMin} min without a new report, so its thread got a short status line instead of the report. Tell the owner where it stands in plain words. Last report: ${report.replace(/`/g, "'").replaceAll("$(", "$ (")}`;
        lead = !pane ? "; lead not told: leadPane is not configured" : (await sendVerified(deps.run, deps.clock, deps.config, pane, note)) ? "; lead told" : `; lead not told: the note did not reach pane ${pane}`;
      }
      acts.push({ kind: "posted", lane: lane.key, detail: `${text}${lead}` });
    }
  }
  const lead = deps.config.leadPane;
  if (lead) {
    const file = leadDueFile(deps.config.stateDir);
    const seen = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pane?: string }).pane : undefined;
    acts.push(...(await rolloverDue(deps, hooks, "lead", "lead", lead, deps.config.handover.model || deps.config.defaultModel, seen, async (pane, at, hit) => {
      mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
      writeFileSync(file, JSON.stringify({ pane, at, crossed: hit }));
    })));
  }
  return acts;
};
