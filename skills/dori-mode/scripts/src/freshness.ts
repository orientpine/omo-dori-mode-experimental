import { repeatTick } from "./auto-signals.ts";
import type { FlowDeps } from "./done-flow.ts";
import { researchCheck, stuckTop } from "./explore.ts";
import { omoPane, paneTranscript, readScreen, sendVerified } from "./panes.ts";
import { dailyFile, dailySnapshot } from "./compaction-keep.ts";
import { type Lane, type RolloverDue, statusOf } from "./registry.ts";
import { fixTag, recordFix } from "./same-fix.ts";
import { taskOpen, taskRecord } from "./background.ts";
import { waitingRequest } from "./lane-handover.ts";
import { readRollovers } from "./rollover.ts";
import { auditDue, weeklyDue, writeMarker } from "./rollover-audit.ts";
import { dailyAuditSince, linksDue } from "./directive-audit.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchLog } from "./watch-log.ts";
import { readJson, readyResume, type RolloverHooks, type SweepAct } from "./freshness-handover.ts";
import { leadDueFile, leadStuckAlert, rolloverDue, screenSignals } from "./freshness-rollover.ts";
import type { DoriConfig } from "./config.ts";
import { keepTick } from "./compaction-keep.ts";
import { HUNG_MESSAGE, laneSessionUsage, Supervision } from "./supervision.ts";
import { lastReportLine, transcriptReport } from "./freshness-reports.ts";
import { type Progress, ReportError, reportLine, Reports } from "./reports.ts";

export type { SweepAct, RolloverHooks } from "./freshness-handover.ts";
export { pidAlive, handoverRunning, resumeArgs } from "./freshness-handover.ts";
export { autoReadyLine } from "./freshness-rollover.ts";
export * from "./freshness-reports.ts";

// What the lead reads when a lane reaches a cap, looks hung, or has a cap that cannot be checked. The lane itself is never
// stopped, closed or typed into: the lead decides (the owner's rule that a running lane never stops without him knowing).
export const supervisionNote = (lane: Lane, message: string, settings: DoriConfig["supervision"]): string =>
  message === HUNG_MESSAGE
    ? `[DORI] ${lane.key}: a Working/Running call on its screen has gone on ${settings.hungAfterMinutes}+ min with no new report, checkpoint or file change for ${settings.staleAfterMinutes} min, so it may be hung. Nothing was sent to the lane; look at pane ${lane.pane ?? "?"}.`
    : / ceiling reached /.test(message)
      ? `[DORI] ${lane.key}: ${message} (dori caps ${lane.key} shows its caps). The lane was not stopped or told. Decide: let it go on (raise or clear the cap: dori caps ${lane.key} --wall-minutes N|none --token-limit N|none --cost-limit N|none), tell it to wrap up, or close it.`
      : `[DORI] ${lane.key}: ${message} (no omo transcript for pane ${lane.pane ?? "?"} and supervision.usageArgv is unset), so that cap is not checked.`;

// Lane caps and hung calls (src/supervision.ts) for one working lane: each new alert goes to the lead once; one that did
// not arrive is sent again on the next sweep. A supervision failure skips only this lane's check and prints once per reason.
const superviseLane = async (deps: FlowDeps, lane: Lane): Promise<SweepAct[]> => {
  const settings = deps.config.supervision;
  const lead = deps.config.leadPane;
  const told = new Map<string, string>();
  const supervision = new Supervision({
    stateDir: deps.config.stateDir, run: deps.run, clock: deps.clock, sessionUsage: laneSessionUsage(deps.run, deps.config.sessionsDir),
    alert: async (l, message) => {
      if (!lead) {
        told.set(message, "lead not told: leadPane is not configured; sent again next sweep");
        return false;
      }
      const ok = await sendVerified(deps.run, deps.clock, deps.config, lead, supervisionNote(l, message, settings));
      told.set(message, ok ? "lead told" : `lead not told: the note did not reach pane ${lead}; sent again next sweep`);
      return ok;
    },
  }, settings);
  try {
    const screen = settings.hungAfterMinutes > 0 && lane.pane ? await readScreen(deps.run, deps.config.backend, lane.pane, 40) : "";
    const r = await supervision.sweep(lane, screen);
    if (lane.supervisionError) await deps.registry.patch(lane.key, { supervisionError: undefined });
    return [...(r.reset ? [{ kind: "supervision_error" as const, lane: lane.key, detail: r.reset }] : []), ...r.alerts.map((message): SweepAct => ({
      kind: message === HUNG_MESSAGE ? "stalled" : r.capped.includes(message) ? "lane_cap" : "usage_unknown",
      lane: lane.key,
      detail: `${message}; ${told.get(message) ?? "lead not told"}`,
    }))];
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (detail === lane.supervisionError) return [];
    await deps.registry.patch(lane.key, { supervisionError: detail });
    return [{ kind: "supervision_error", lane: lane.key, detail }];
  }
};

// the re-anchor and the early-compaction trial (compaction-keep.ts), for working and not-done lanes alike; a failure is
// one watch-log line, never the end of the sweep
const keepLane = async (deps: FlowDeps, key: string, fallback: Lane): Promise<SweepAct[]> => {
  try {
    return await keepTick(deps, (await deps.registry.read(key)) ?? fallback);
  } catch (e) {
    watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `COMPACTION_KEEP_WARN ${key}: ${String(e).slice(0, 200)}` });
    return [];
  }
};

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

const stuckAct = (lane: string, line: string): SweepAct => ({ kind: "stuck", lane, detail: line.replace(/^STUCK \S+ /, "") });

// Lanes send [REPORT] lines to the lead pane, so that is where they are read first; the lane's own screen is the fallback.
// A report not seen before counts as hearing from the lane.
export const freshnessTick = async (deps: FlowDeps, home: string, given: RolloverHooks = screenSignals(deps)): Promise<SweepAct[]> => {
  const hooks: RolloverHooks = { taskEnded: (id) => {
    const r = taskRecord(home, id);
    return r !== undefined && !taskOpen(r);
  }, leadTranscript: async () => {
    const pane = deps.config.leadPane;
    if (!pane || !omoPane(deps.config, pane)) return undefined;
    const path = await paneTranscript(deps.run, deps.config.sessionsDir, pane);
    return path ? readFileSync(path, "utf8") : undefined;
  }, ...given };
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  let leadScreen: string | undefined;
  let leadLines: readonly string[] | undefined;
  // a lane's newest report: in the lead's transcript first, then the lead's screen, then the lane's own screen
  const lastReport = async (lane: Lane): Promise<string | null> => {
    leadScreen ??= deps.config.leadPane ? await readScreen(deps.run, deps.config.backend, deps.config.leadPane, 3000) : "";
    leadLines ??= await (hooks.leadTranscript?.() ?? Promise.resolve(undefined)).then((t) => t?.split("\n") ?? [], (e: unknown) => {
      watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `FRESHNESS_WARN lead transcript not read: ${String(e).slice(0, 200)}` });
      return [];
    });
    return transcriptReport(leadLines, lane.key) ?? lastReportLine(leadScreen, lane.key) ?? lastReportLine(await readScreen(deps.run, deps.config.backend, lane.pane ?? "", 200), lane.key);
  };
  const reports = new Reports(deps.config.stateDir);
  const readProgress = async (lane: Lane): Promise<{ readonly previous: Progress | null; readonly progress: Progress | null; readonly report: string | null; readonly error: ReportError | null }> => {
    if (lane.reportProtocol !== "jsonl-v1") return { previous: null, progress: null, report: await lastReport(lane), error: null };
    try {
      const previous = reports.read(lane.key);
      const progress = previous ? reports.observe(lane.key, await readScreen(deps.run, deps.config.backend, lane.pane ?? ""), now, deps.config.nudgeAfterMin * 60_000) : null;
      return { previous, progress, report: progress?.lastReport ? reportLine(progress.lastReport) : null, error: null };
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      return { previous: null, progress: null, report: null, error };
    }
  };
  for (const lane of await deps.registry.open()) {
    if (!lane.pane) continue;
    const state = await readProgress(lane);
    if (state.error) {
      if (lane.lastJournalError !== state.error.message) {
        acts.push({ kind: "journal-error", lane: lane.key, detail: state.error.message });
        await deps.registry.patch(lane.key, { lastJournalError: state.error.message });
      }
      continue;
    }
    const { previous, progress, report } = state;
    if (progress?.state === "stalled" && previous?.state !== "stalled") acts.push({ kind: "stalled", lane: lane.key, detail: progress.lastEvent.text });
    // a lane told "not done" keeps working: it is moved to a new session like a working one (cyto-p2-timers carried 306k
    // after its 13th compaction on 10-19 and was never started); its reports, nudges and posts stay as they were
    if (statusOf(lane) === "not-done") {
      // its newest report still counts as progress for the hung check (its nudges and posts stay off)
      const reported = report;
      const seen = reported && reported !== lane.lastReport
        ? { ...lane, lastReport: reported, ...(lane.reportProtocol === "jsonl-v1" ? {} : { lastReplyAt: now }) }
        : lane;
      if (seen !== lane) await deps.registry.patch(lane.key, { lastReport: seen.lastReport, ...(lane.reportProtocol === "jsonl-v1" ? {} : { lastReplyAt: now }) });
      acts.push(...(await superviseLane(deps, seen)));
      acts.push(...(await keepLane(deps, lane.key, seen)));
      const resumed = await readyResume(deps, hooks, lane.key, lane.pane);
      acts.push(...resumed);
      // a lead's request still waiting holds the lane too: no automatic start beside it (review 320 round 13)
      if (resumed.some((a) => a.detail.startsWith("started")) || waitingRequest(readRollovers(deps.config.stateDir), lane.key, lane.pane)) continue;
      acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, lane.rolloverDue, stuckTop(lane), (due) => deps.registry.patch(lane.key, { rolloverDue: due }))));
      continue;
    }
    if (statusOf(lane) !== "working") continue;
    if (progress?.state === "stalled") continue;
    let current = lane;
    if (report && report !== lane.lastReport) {
      current = lane.reportProtocol === "jsonl-v1" ? { ...current, lastReport: report } : { ...current, lastReport: report, lastReplyAt: now };
      await deps.registry.patch(lane.key, lane.reportProtocol === "jsonl-v1" ? { lastReport: report } : { lastReport: report, lastReplyAt: now });
      // the stuck ladder, from a tagged attempt and from the untagged count (reports, commits, tree): one STUCK line per rung
      const tag = fixTag(report);
      if (tag) for (const n of (await recordFix(deps, lane.key, { at: new Date(now).toISOString(), ...tag, via: "report" })).notes) acts.push(stuckAct(lane.key, n));
      try {
        for (const line of (await repeatTick(deps, (await deps.registry.read(lane.key)) ?? current)).lines) acts.push(stuckAct(lane.key, line));
      } catch (e) {
        watchLog(deps.config.watchLog, deps.clock, { source: "auto-signals", line: `AUTO_SIGNALS_WARN ${lane.key} repeat check failed: ${String(e).slice(0, 200)}` });
      }
      current = (await deps.registry.read(lane.key)) ?? current;
    }
    // a ulw research text sent to the lane: does its session log show the skill starting (RESEARCH_STARTED / _NOT_STARTED)
    if (lane.research && !lane.research.result) {
      const r = await researchCheck(deps, lane);
      if (r.verdict === "started" || r.verdict === "not-started") acts.push({ kind: r.verdict === "started" ? "research_started" : "research_not_started", lane: lane.key, detail: r.line.replace(/^RESEARCH_\w+ \S+ /, "") });
    }
    acts.push(...(await superviseLane(deps, current)));
    acts.push(...(await keepLane(deps, lane.key, current)));
    const resumed = await readyResume(deps, hooks, lane.key, lane.pane);
    acts.push(...resumed);
    // the start just made holds the lane: no automatic start beside it in this sweep
    // a lead's request still waiting holds the lane too: no automatic start beside it (review 320 round 13)
    if (!resumed.some((a) => a.detail.startsWith("started")) && !waitingRequest(readRollovers(deps.config.stateDir), lane.key, lane.pane)) acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, current.rolloverDue, stuckTop(current), (due) => deps.registry.patch(lane.key, { rolloverDue: due }))));
    const heard = lane.reportProtocol === "jsonl-v1" ? Math.max(lastHeard(lane), progress?.lastReport ? Date.parse(progress.lastReport.at) : 0) : lastHeard(current);
    const silentMin = Math.round((now - heard) / 60_000);
    const threadQuietMin = lane.reportProtocol === "jsonl-v1" ? Math.round((now - Math.max(lastHeard(lane), lane.lastAutoReplyAt ?? 0)) / 60_000) : silentMin;
    const running = !progress || progress.state === "running";
    if (running && silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      const delivered = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
      current = { ...current, lastNudgeAt: now };
      await deps.registry.patch(lane.key, { lastNudgeAt: now });
      acts.push({ kind: delivered ? "nudged" : "nudge-failed", lane: lane.key, detail: delivered ? `${silentMin} min silent` : `${silentMin} min silent; the nudge did not reach pane ${lane.pane}` });
    }
    // nothing goes to the owner's thread on its own: a line counted from the lane's last report, blind to what the lead
    // wrote since, told him nothing (owner, 2026-11-04: "시간도 안맞고 말이야 도움도 안돼"); the lead is told, once per silence
    // (lastAutoReplyAt), with or without hooks.threadReply
    const due = lane.reportProtocol === "jsonl-v1" ? (current.lastAutoReplyAt ?? 0) <= heard : (current.lastAutoReplyAt ?? 0) < heard;
    if (threadQuietMin >= deps.config.postAfterMin && lane.thread !== "none" && due) {
      // a report seen before still stands once it left the screens; only a lane never heard from is NO-REPORT
      const known = lane.reportProtocol === "jsonl-v1" ? report : report ?? current.lastReport;
      if (!known) {
        acts.push({ kind: "no-report", lane: lane.key, detail: lane.reportProtocol === "jsonl-v1" ? "report journal has no report" : "pane has no [REPORT] line" });
        continue;
      }
      const pane = deps.config.leadPane;
      // a lead not told leaves the lane due, so a lead configured later or a note that arrives on the next sweep still counts
      if (!pane) {
        acts.push({ kind: "lead-tell-failed", lane: lane.key, detail: `${silentMin} min silent; leadPane is not configured` });
        continue;
      }
      const note = `[DORI] ${lane.key}: ${silentMin} min without a new report. Nothing was posted in its thread. If the owner needs to know where it stands, tell him in one plain line. Last report: ${known.replace(/`/g, "'").replaceAll("$(", "$ (")}`;
      if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, note))) {
        acts.push({ kind: "lead-tell-failed", lane: lane.key, detail: `${silentMin} min silent; the note did not reach pane ${pane}` });
        continue;
      }
      await deps.registry.patch(lane.key, { lastAutoReplyAt: now });
      acts.push({ kind: "lead-told", lane: lane.key, detail: `${silentMin} min silent; nothing posted in its thread` });
    }
  }
  if (dailySnapshot(deps.config, await deps.registry.list(), now)) acts.push({ kind: "trial_daily", lane: "lead", detail: `compaction trial day written to ${dailyFile(deps.config.stateDir)}` });
  const lead = deps.config.leadPane;
  if (lead) {
    const file = leadDueFile(deps.config.stateDir);
    const seen = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RolloverDue) : undefined;
    const model = deps.config.handover.model || deps.config.defaultModel;
    acts.push(...(await rolloverDue(deps, hooks, "lead", "lead", lead, model, seen, undefined, async (due) => {
      mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
      writeFileSync(file, JSON.stringify(due));
    })));
    acts.push(...(await leadStuckAlert(deps, hooks, lead, model, readJson<RolloverDue>(file))));
  }
  // the audit after each committed handover, once (queued before it starts, so the next sweep does not start a second one),
  // and the week's summary for the lead
  if (hooks.audit) {
    for (const c of auditDue(deps.config.stateDir, now, deps.config.handover)) {
      writeMarker(c.note, { at: new Date(now).toISOString(), status: "queued" });
      acts.push({ kind: "rollover_audit", lane: c.key, detail: `${c.stamp}: ${await hooks.audit(c)}` });
    }
  }
  const week = hooks.auditSummary ? weeklyDue(deps.config.stateDir, now, deps.config.scorecard.timeZone, deps.config.handover.auditSummaryAt) : undefined;
  if (week && hooks.auditSummary) acts.push({ kind: "audit_summary", lane: "lead", detail: hooks.auditSummary(week) });
  // links first, so a peer's audit later reads what this Dori's ledger holds now
  if (hooks.directiveLinks && linksDue(deps.config, now)) for (const detail of await hooks.directiveLinks()) acts.push({ kind: "directive_links", lane: "lead", detail });
  const since = hooks.directiveAudit ? dailyAuditSince(deps.config.stateDir, now) : undefined;
  if (since && hooks.directiveAudit) for (const detail of await hooks.directiveAudit(since)) acts.push({ kind: "directive_audit", lane: "lead", detail });
  return acts;
};
