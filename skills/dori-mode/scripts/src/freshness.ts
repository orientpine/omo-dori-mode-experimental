import { repeatTick } from "./auto-signals.ts";
import { type DoriConfig, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { runOwnerCheck } from "./owner-check.ts";
import { researchCheck, stuckTop } from "./explore.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, type RolloverDue, statusOf } from "./registry.ts";
import { fixTag, recordFix } from "./same-fix.ts";
import { statusLine } from "./lane-handover.ts";
import { crossed, dueReasons, limitsFor, type Signals, type Who } from "./rollover.ts";
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

export type SweepAct = { readonly kind: "nudged" | "nudge-failed" | "posted" | "no-report" | "stuck" | "research_started" | "research_not_started" | "rollover_due" | "rollover_auto"; readonly lane: string; readonly detail: string };

export type RolloverHooks = {
  // the length signals of the session in a pane: context use, compactions, age
  readonly signals: (pane: string, model: string) => Promise<Signals>;
  // starts a rollover without asking (handover.autoRolloverLanes / autoRolloverLead on); the line says what it started
  readonly auto?: (who: Who, key: string) => Promise<string>;
};

const screenSignals = (deps: FlowDeps): RolloverHooks => ({ signals: async (pane, model) => ({ contextPct: statusLine(await readScreen(deps.run, deps.config.backend, pane, 8), model).contextPct }) });

const leadDueFile = (stateDir: string): string => join(stateDir, "handover", "lead-due.json");

// A session past a measured threshold (context, compactions, age) is due for a rollover. Freshness says so once per pane
// and only suggests: the lead decides and runs the handover with --approved-by lead:<reason and signal>, unless the owner
// turned the auto key on. A stuck lane's rollover point is rung 4 of the stuck ladder, which has its own STUCK line.
// With the auto key on, rung 4 of the stuck ladder is a reason too, and a session still in the same pane autoRetryMin minutes
// after an automatic start (the handover refused it, a turn was running, or it rolled back) gets another, up to autoMaxTries;
// then one line says it gave up. A refusal goes to the watch log only (HANDOVER_REFUSED); the owner hears of a move that happened.
const rolloverDue = async (deps: FlowDeps, hooks: RolloverHooks, who: Who, key: string, pane: string, model: string, seen: RolloverDue | undefined, stuck: Signals["stuck"], save: (due: RolloverDue) => Promise<void>): Promise<SweepAct[]> => {
  const h = deps.config.handover;
  if (deps.config.backend !== "aoe") return [];
  const auto = (who === "lane" ? h.autoRolloverLanes : h.autoRolloverLead) ? hooks.auto : undefined;
  const limits = limitsFor(who, h);
  const reasons = async (): Promise<string[]> => {
    const signals: Signals = await hooks.signals(pane, model).catch(() => ({}));
    return auto ? dueReasons({ ...signals, ...(stuck ? { stuck } : {}) }, limits) : crossed(signals, limits);
  };
  const now = deps.clock.now();
  const at = new Date(now).toISOString();
  if (seen?.pane === pane) {
    if (!auto || seen.gaveUp) return [];
    // due while the key was off (only the ROLLOVER_DUE line so far): the first automatic start, now that it is on
    if (!seen.autoAt) {
      const hit = await reasons();
      if (!hit.length) return [];
      await save({ ...seen, autoAt: at, tries: 1 });
      return [{ kind: "rollover_auto", lane: key, detail: `${hit.join(", ")}: ${await auto(who, key)}` }];
    }
    const tries = seen.tries ?? 1;
    if (tries >= h.autoMaxTries) {
      await save({ ...seen, gaveUp: true });
      return [{ kind: "rollover_auto", lane: key, detail: `gave up in ${pane} after ${tries} automatic starts (handover.autoMaxTries ${h.autoMaxTries}); why each stopped is in the watch log (HANDOVER_REFUSED, HANDOVER_VERIFY_FAIL); decide it by hand` }];
    }
    if (now - Date.parse(seen.autoAt) < h.autoRetryMin * 60_000) return [];
    const hit = await reasons();
    if (!hit.length) return [];
    await save({ ...seen, autoAt: at, tries: tries + 1 });
    return [{ kind: "rollover_auto", lane: key, detail: `retry ${tries + 1}/${h.autoMaxTries} (${hit.join(", ")}): ${await auto(who, key)}` }];
  }
  const hit = await reasons();
  if (!hit.length) return [];
  await save({ pane, at, crossed: hit, ...(auto ? { autoAt: at, tries: 1 } : {}) });
  const run = who === "lane" ? `dori handover --lane ${key} --approved-by "lead:<reason and this signal>"` : `dori handover --approved-by "lead:<reason and this signal>"`;
  const acts: SweepAct[] = [{ kind: "rollover_due", lane: key, detail: `${hit.join(", ")} in ${pane}: decide it (dori rollover-propose ${key} shows the note); to go ahead, ${who === "lane" ? `once the lane is at a safe point (dori handover ready ${key}), ` : ""}run ${run}; the owner is told afterwards` }];
  if (auto) acts.push({ kind: "rollover_auto", lane: key, detail: await auto(who, key) });
  return acts;
};

// The line freshness prints when it starts: whether rollovers start by themselves, on what, and how often they are retried.
export const autoReadyLine = (h: DoriConfig["handover"]): string => {
  const side = (who: Who, on: boolean): string => {
    const name = who === "lane" ? "lanes" : "lead";
    if (!on) return `${name} off`;
    const l = limitsFor(who, h);
    const what = [l.contextPct > 0 ? `context >= ${l.contextPct}%` : "", l.compactions > 0 ? `compactions >= ${l.compactions}` : "", (l.afterCompactK ?? 0) > 0 ? `context after compaction >= ${l.afterCompactK}k` : "", l.ageH > 0 ? `age >= ${l.ageH} h` : "", who === "lane" ? "stuck rung 4" : ""].filter(Boolean);
    return `${name} on (${what.join(", ") || "no threshold set"})`;
  };
  const sides = `${side("lane", h.autoRolloverLanes)}, ${side("lead", h.autoRolloverLead)}`;
  return h.autoRolloverLanes || h.autoRolloverLead
    ? `ROLLOVER_AUTO_READY ${sides}; retry every ${h.autoRetryMin} min, up to ${h.autoMaxTries} starts per session; the owner is told after each move`
    : `ROLLOVER_AUTO_OFF ${sides}; rollovers wait for the lead's decision`;
};

// A milestone report that announces a new stage or phase is the moment to compare the lane's direction with the owner's goal:
// that lane's owner check goes first in the sweep.
export const stageChange = (report: string, pattern: string): boolean => /\| milestone \|/.test(report) && new RegExp(pattern, "i").test(report.replace(/^\[REPORT\][^|]*\|[^|]*\|/, ""));

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

const stuckAct = (lane: string, line: string): SweepAct => ({ kind: "stuck", lane, detail: line.replace(/^STUCK \S+ /, "") });

// a lane heard from since its last owner check, past the per-lane interval: worth reading its reports again
const ownerCheckDue = (lane: Lane, now: number, minIntervalMin: number): boolean => {
  const last = lane.ownerCheck ? Date.parse(lane.ownerCheck.at) : 0;
  return (lane.lastReplyAt ?? 0) > last && now - last >= minIntervalMin * 60_000;
};

// Lanes send [REPORT] lines to the lead pane, so that is where they are read first; the lane's own screen is the fallback.
// A report not seen before counts as hearing from the lane.
export const freshnessTick = async (deps: FlowDeps, home: string, hooks: RolloverHooks = screenSignals(deps)): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  const staged = new Set<string>();
  let leadScreen: string | undefined;
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    leadScreen ??= deps.config.leadPane ? await readScreen(deps.run, deps.config.backend, deps.config.leadPane, 3000) : "";
    const report = lastReportLine(leadScreen, lane.key) ?? lastReportLine(await readScreen(deps.run, deps.config.backend, lane.pane, 200), lane.key);
    let current = lane;
    if (report && report !== lane.lastReport) {
      current = { ...current, lastReport: report, lastReplyAt: now };
      await deps.registry.patch(lane.key, { lastReport: report, lastReplyAt: now });
      // the stuck ladder, from a tagged attempt and from the untagged count (reports, commits, tree): one STUCK line per rung
      const tag = fixTag(report);
      if (tag) for (const n of (await recordFix(deps, lane.key, { at: new Date(now).toISOString(), ...tag, via: "report" })).notes) acts.push(stuckAct(lane.key, n));
      try {
        for (const line of (await repeatTick(deps, (await deps.registry.read(lane.key)) ?? current)).lines) acts.push(stuckAct(lane.key, line));
      } catch (e) {
        watchLog(deps.config.watchLog, deps.clock, { source: "auto-signals", line: `AUTO_SIGNALS_WARN ${lane.key} repeat check failed: ${String(e).slice(0, 200)}` });
      }
      current = (await deps.registry.read(lane.key)) ?? current;
      if (stageChange(report, deps.config.explore.stagePattern)) staged.add(lane.key);
    }
    // a ulw research text sent to the lane: does its session log show the skill starting (RESEARCH_STARTED / _NOT_STARTED)
    if (lane.research && !lane.research.result) {
      const r = await researchCheck(deps, lane);
      if (r.verdict === "started" || r.verdict === "not-started") acts.push({ kind: r.verdict === "started" ? "research_started" : "research_not_started", lane: lane.key, detail: r.line.replace(/^RESEARCH_\w+ \S+ /, "") });
    }
    acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, current.rolloverDue, stuckTop(current), (due) => deps.registry.patch(lane.key, { rolloverDue: due }))));
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
  // owner-instruction check: a reviewer model reads the newest reports of a lane heard from since its last check (a lane whose
  // milestone report announced a new stage first); a finding is the stuck ladder's context rung (its STUCK line)
  const oc = deps.config.autoSignals.ownerCheck;
  if (oc.enabled) {
    let budget = oc.perTick;
    const lanes = (await deps.registry.open()).sort((a, b) => Number(staged.has(b.key)) - Number(staged.has(a.key)));
    for (const lane of lanes) {
      if (budget <= 0) break;
      if (statusOf(lane) !== "working" || !ownerCheckDue(lane, now, oc.minIntervalMin)) continue;
      const r: { readonly lines: readonly string[]; readonly skipped?: string } = await runOwnerCheck(deps, lane).catch((e: unknown) => {
        watchLog(deps.config.watchLog, deps.clock, { source: "owner-check", line: `OWNER_CHECK_FAILED ${lane.key} ${String(e).slice(0, 200)}` });
        return { lines: [] };
      });
      // a check skipped before any model call (no report in the session files yet) does not use up the sweep's budget
      if (!r.skipped?.startsWith("OWNER_CHECK_SKIP")) budget--;
      for (const line of r.lines) if (line.startsWith("STUCK ")) acts.push(stuckAct(lane.key, line));
    }
  }
  const lead = deps.config.leadPane;
  if (lead) {
    const file = leadDueFile(deps.config.stateDir);
    const seen = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RolloverDue) : undefined;
    acts.push(...(await rolloverDue(deps, hooks, "lead", "lead", lead, deps.config.handover.model || deps.config.defaultModel, seen, undefined, async (due) => {
      mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
      writeFileSync(file, JSON.stringify(due));
    })));
  }
  return acts;
};
