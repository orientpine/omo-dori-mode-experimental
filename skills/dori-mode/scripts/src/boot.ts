import type { FlowDeps } from "./done-flow.ts";
import { shellQuote } from "./herdr.ts";
import { parseRef } from "./runtime/types.ts";
import { type ChosenRuntimes, runtimesOf } from "./run.ts";
import { aoeRefForLane, listAoeSessions, listSessions, probeAoeSession, RuntimeDormant, type BootSession } from "./sessions.ts";
import { reconcilePanes } from "./reconcile.ts";
import { driftCheck, workspaceCheck } from "./boot-checks.ts";
import type { Slack } from "./messenger/slack.ts";
import { type BootLane, finished, monitorCleanup, readMonitorManifests } from "./boot-monitors.ts";
import { type Lane, statusOf } from "./registry.ts";
import { ReportError, type Reports } from "./reports.ts";
import { type Worklog, worklogLines } from "./worklog.ts";

export type SlackCheck = (signal?: AbortSignal) => Promise<{ readonly userId: string; readonly teamId: string } | null>;
export type BootDeps = Pick<FlowDeps, "run" | "registry" | "config" | "clock"> & {
  readonly reports: Reports;
  readonly worklog: Worklog;
  readonly rts: ChosenRuntimes;
  readonly hcCoreUp: () => Promise<boolean>;
  readonly slack: SlackCheck;
  readonly monitorDirs?: readonly string[];
  readonly slackDeadlineMs?: number;
};

export const slackAuthCheck = (slack: Pick<Slack, "call"> | null): SlackCheck => async (signal) => {
  if (!slack) return null;
  const auth = await slack.call("auth.test", {}, undefined, undefined, signal);
  if (typeof auth["user_id"] !== "string" || !auth["user_id"] || typeof auth["team_id"] !== "string" || !auth["team_id"]) throw new Error("auth.test returned no user_id or team_id");
  return { userId: auth["user_id"], teamId: auth["team_id"] };
};

// Read-only recovery after a restart or compaction. Every finding is printed; no lane, registry or watch is changed.
export const bootCheck = async (deps: BootDeps): Promise<{ exitCode: number; lines: string[] }> => {
  const lines: string[] = [];
  const rts = deps.rts ?? runtimesOf(deps.run, { runtime: deps.config.runtime });
  const choice = rts.choice;
  lines.push(choice ? `RUNTIME ${choice.kind} (from ${choice.source})` : `RUNTIME unavailable: ${rts.failure?.message ?? "unknown"}`);
  if (rts.failure) {
    lines.push("BOOT incomplete read-only; nothing restarted, written or stopped");
    return { exitCode: 1, lines };
  }
  let failed = false;
  const lanes: BootLane[] = [];
  const journals: string[] = [];
  let registered: Lane[] = [];
  try {
    const scanned = await deps.registry.scan();
    registered = scanned.lanes;
    for (const path of scanned.unreadable) {
      failed = true;
      lines.push(`REGISTRY unreadable ${shellQuote(path)}`);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push(`REGISTRY unreadable ${shellQuote(deps.registry.dir)}`);
  }
  for (const lane of registered.sort((a, b) => a.key.localeCompare(b.key))) {
    if (lane.reportProtocol !== "jsonl-v1") {
      lanes.push(lane);
      continue;
    }
    try {
      const progress = deps.reports.read(lane.key);
      lanes.push({ ...lane, reportState: progress?.state });
      const report = progress?.lastReport;
      if (report) journals.push(`REPORT ${lane.key} kind=${report.kind} at=${report.at} state=${progress?.state} registryStatus=${statusOf(lane)}`);
      else if (progress) journals.push(`NO-REPORT ${lane.key} state=${progress.state} registryStatus=${statusOf(lane)} (journal holds harness activity only)`);
      else journals.push(`NO-REPORT ${lane.key} registryStatus=${statusOf(lane)} (no journal)`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
      journals.push(`JOURNAL-ERROR ${lane.key} kind=${"code" in error && typeof error.code === "string" ? error.code : error instanceof ReportError || error instanceof SyntaxError ? "invalid-journal" : "unreadable"}`);
      lanes.push(lane);
    }
  }
  const leadRef = parseRef(deps.config.leadPane);
  let panes: BootSession[] | null = null;
  try {
    const listed: BootSession[] = await listSessions(rts, { lanes: registered.filter((lane) => statusOf(lane) !== "closed"), hcCoreUp: deps.hcCoreUp, groups: deps.config.workspaces, selected: deps.config.backend !== "aoe", ...(leadRef ? { lead: leadRef } : {}) });
    const needsAoe = deps.config.backend === "aoe" || aoeRefForLane(deps.config.leadPane) !== undefined || registered.some((lane) => statusOf(lane) !== "closed" && aoeRefForLane(lane.pane));
    if (needsAoe) listed.push(...await listAoeSessions(deps.run));
    panes = listed;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push(error instanceof RuntimeDormant ? `PANES unavailable (${error.message})` : "PANES unavailable (session list failed)");
  }
  if (panes) {
    const result = reconcilePanes(lanes, panes);
    const lead = deps.config.leadPane;
    const done = new Set(lanes.filter(finished).map((lane) => lane.key));
    const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && !done.has(lane.key));
    const leadLive = leadRef ? panes.some((pane) => pane.ref.runtime === leadRef.runtime && pane.ref.id === leadRef.id) : panes.some((pane) => pane.ref.id === lead);
    lines.push(`PANES lead=${lead || "unconfigured"} leadState=${leadLive ? "live" : "missing"} registeredLive=${result.lanes.filter((l) => l.paneState === "live" && l.status !== "closed").length} vanished=${vanished.length} unregistered=${result.unregistered.length}`);
    for (const lane of vanished) lines.push(`VANISHED ${lane.key} pane=${lane.pane} status=${lane.status}; registry and worktrees preserved; no relaunch`);
    if (result.unregistered.length) lines.push(`UNREGISTERED ${result.unregistered.join(" ")}`);
    const drift = await driftCheck(rts, registered, { sessions: panes, probeAoe: (pane) => probeAoeSession(deps.run, pane) });
    lines.push(...drift.lines);
    if (drift.failed) failed = true;
  }
  const warnings = workspaceCheck(deps.config, rts.choice?.kind, panes);
  if (warnings.length) failed = true;
  lines.push(...warnings);
  lines.push(...journals);
  try {
    const read = deps.worklog.read();
    for (const problem of read.problems) {
      failed = true;
      lines.push(`WORKLOG damaged ${problem}`);
    }
    const [, ...open] = worklogLines(read.items);
    lines.push(`WORKLOG open=${open.length}`, ...open);
    for (const warning of read.warnings) lines.push(`WORKLOG warning ${warning}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push(`WORKLOG unreadable ${error.message}`);
  }
  const { manifests, errors } = readMonitorManifests(deps.config.sessionsDir, deps.monitorDirs);
  for (const path of errors) {
    failed = true;
    lines.push(`MONITORS unreadable ${shellQuote(path)}`);
  }
  const cleanup = monitorCleanup(lanes, manifests);
  const now = deps.clock.now();
  const expired = cleanup.filter((item) => item.expiresAt !== undefined && item.expiresAt <= now);
  const running = cleanup.filter((item) => !expired.includes(item));
  const ordered = [...running.filter((item) => !item.deliveryPaused), ...running.filter((item) => item.deliveryPaused)];
  lines.push(`MONITORS cleanupCandidates=${running.length} deliveryPaused=${running.filter((item) => item.deliveryPaused).length} expired=${expired.length} (from metadata; liveness unverified)`);
  for (const item of ordered) {
    lines.push(`CLEANUP ${item.lanes.join(",")} match=${item.match.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)}${item.suspended ? " suspended=true" : ""}${item.deliveryPaused ? " deliveryPaused=true" : ""}`);
    lines.push(`STOP in the owner session only: ${item.stop}`);
  }
  for (const item of expired) lines.push(`EXPIRED ${item.lanes.join(",")} match=${item.match.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)} expiresAt=${new Date(item.expiresAt ?? 0).toISOString()}; nothing to stop`);
  const deadlineMs = deps.slackDeadlineMs ?? 10_000;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const auth = await Promise.race([
      deps.slack(stop.signal),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          stop.abort();
          resolve("timeout");
        }, deadlineMs);
      }),
    ]);
    if (auth === "timeout") {
      failed = true;
      lines.push(`SLACK auth.test timed out after ${deadlineMs} ms`);
    } else lines.push(auth ? `SLACK authenticated user=${auth.userId} team=${auth.teamId} (auth.test only; inbox delivery unverified)` : "SLACK skipped (DORI_SLACK_TOKEN not set)");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push(stop.signal.aborted ? `SLACK auth.test timed out after ${deadlineMs} ms` : "SLACK auth failed");
  } finally {
    clearTimeout(timer);
  }
  lines.push(`BOOT ${failed ? "incomplete" : "checked"} read-only; nothing restarted, written or stopped`);
  return { exitCode: failed ? 1 : 0, lines };
};
