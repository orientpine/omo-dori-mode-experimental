import type { FlowDeps } from "./done-flow.ts";
import { shellQuote } from "./herdr.ts";
import { listPanes, type Pane } from "./panes.ts";
import type { Slack } from "./messenger/slack.ts";
import { type BootLane, finished, monitorCleanup, readMonitorManifests } from "./boot-monitors.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Reports } from "./reports.ts";

export type PaneState = "live" | "vanished" | "unassigned";
export type SlackCheck = () => Promise<{ readonly userId: string; readonly teamId: string } | null>;
export type BootDeps = Pick<FlowDeps, "run" | "registry" | "config" | "clock"> & {
  readonly reports: Reports;
  readonly slack: SlackCheck;
  readonly monitorDirs?: readonly string[];
  readonly slackDeadlineMs?: number;
};

export const slackAuthCheck = (slack: Pick<Slack, "call"> | null): SlackCheck => async () => {
  if (!slack) return null;
  const auth = await slack.call("auth.test", {});
  if (typeof auth["user_id"] !== "string" || !auth["user_id"] || typeof auth["team_id"] !== "string" || !auth["team_id"]) throw new Error("auth.test returned no user_id or team_id");
  return { userId: auth["user_id"], teamId: auth["team_id"] };
};

export const reconcilePanes = (lanes: readonly Lane[], panes: readonly Pane[]): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(panes.map((pane) => pane.pane_id));
  const registered = new Set(lanes.flatMap((lane) => (lane.pane && statusOf(lane) !== "closed" ? [lane.pane] : [])));
  return {
    lanes: lanes.map((lane) => ({
      key: lane.key,
      status: statusOf(lane),
      pane: lane.pane ?? null,
      paneState: !lane.pane ? "unassigned" : live.has(lane.pane) ? "live" : "vanished",
    })),
    unregistered: panes.filter((pane) => !registered.has(pane.pane_id)).map((pane) => pane.pane_id),
  };
};

// Read-only recovery after a restart or compaction. Every finding is printed; no lane, registry or watch is changed.
export const bootCheck = async (deps: BootDeps): Promise<{ exitCode: number; lines: string[] }> => {
  const lines: string[] = [];
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
      journals.push(`JOURNAL-ERROR ${lane.key}: ${error.message}`);
      lanes.push(lane);
    }
  }
  let panes: Pane[] | null = null;
  try {
    panes = await listPanes(deps.run, deps.config);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push("PANES unavailable (herdr pane list failed)");
  }
  if (panes) {
    const result = reconcilePanes(lanes, panes);
    const lead = deps.config.leadPane;
    const done = new Set(lanes.filter(finished).map((lane) => lane.key));
    const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && !done.has(lane.key));
    lines.push(`PANES lead=${lead || "unconfigured"} leadState=${panes.some((p) => p.pane_id === lead) ? "live" : "missing"} registeredLive=${result.lanes.filter((l) => l.paneState === "live" && l.status !== "closed").length} vanished=${vanished.length} unregistered=${result.unregistered.length}`);
    for (const lane of vanished) lines.push(`VANISHED ${lane.key} pane=${lane.pane} status=${lane.status}; registry and worktrees preserved; no relaunch`);
    if (result.unregistered.length) lines.push(`UNREGISTERED ${result.unregistered.join(" ")}`);
  }
  lines.push(...journals);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const auth = await Promise.race([
      deps.slack(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
      }),
    ]);
    if (auth === "timeout") {
      failed = true;
      lines.push(`SLACK auth.test timed out after ${deadlineMs} ms`);
    } else lines.push(auth ? `SLACK authenticated user=${auth.userId} team=${auth.teamId} (auth.test only; inbox delivery unverified)` : "SLACK skipped (DORI_SLACK_TOKEN not set)");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failed = true;
    lines.push("SLACK auth failed");
  } finally {
    clearTimeout(timer);
  }
  lines.push(`BOOT ${failed ? "incomplete" : "checked"} read-only; nothing restarted, written or stopped`);
  return { exitCode: failed ? 1 : 0, lines };
};
