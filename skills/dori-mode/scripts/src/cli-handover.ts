import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentTmuxSession } from "./aoe.ts";
import { resumeAfterThaw } from "./job-control.ts";
import { ackHandover, handover, LEAD_SUMMARY_TEMPLATE, windowsDetachRefusal } from "./handover.ts";
import { laneHandover, markReady, paneSignals, SUMMARY_TEMPLATE } from "./lane-handover.ts";
import { auditHandover, auditSummary, findCommitted, reportGap, sendAuditSummary, summaryWeek } from "./rollover-audit.ts";
import { appendRollover, AUTO_GRANT_ENV, dueReasons, LEAD_PREFIX, limitsFor, peerStuckLines, readRollovers, rolloverStats, stuckOutcomeLines } from "./rollover.ts";
import { stuckTop } from "./explore.ts";
import { realClock, run } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { closeDueFrozen, closeFrozen, frozenLine, readFrozen, thawFrozen } from "./frozen.ts";
import { trialActive, trialRows, trialTable } from "./compaction-keep.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";

const handoverCommand: Command = async (context) => {
  const { key, opt, config, flags, lane, deps, rest, cliPath } = context;
  const { freezeDeps, sendSignal, laneDepsFor, leadDepsFor, passEnv } = makeHandoverDeps(context);
  const here = await currentTmuxSession(run);
  // the one-use grant of a run freshness started (auto hook); kept from the sessions and processes this run starts
  const autoGrant = process.env[AUTO_GRANT_ENV];
  delete process.env[AUTO_GRANT_ENV];
  if (key === "ack") {
    console.log(ackHandover(opt("state") ? resolve(opt("state") ?? "") : config.stateDir, flags.positionals[1]?.trim() || die("usage: dori handover ack <id> [--state DIR]"), here, new Date().toISOString()));
    return;
  }
  // the old lead frozen at a committed handover: list, resume one frozen by mistake, close one (or every due one)
  if (key === "frozen") {
    const recs = readFrozen(config.stateDir);
    console.log(recs.length ? recs.map(frozenLine).join("\n") : "FROZEN none");
    return;
  }
  if (key === "thaw") {
    const pane = flags.positionals[1]?.trim() || die("usage: dori handover thaw <pane>");
    const agent = readFrozen(config.stateDir).find((r) => r.pane === pane)?.agentPid;
    const thawed = thawFrozen(freezeDeps, config.stateDir, pane);
    // checked once resumed: the agent is again its tty's running foreground job, or is brought back to it
    const fg = agent && !thawed.startsWith("FROZEN_NONE") ? await resumeAfterThaw({ run, clock: realClock, signal: sendSignal }, pane, agent) : "";
    const line = fg ? `${thawed}; ${fg}` : thawed;
    watchLog(config.watchLog, realClock, { source: "handover", line });
    console.log(line);
    if (line.startsWith("FROZEN_NONE")) process.exit(1);
    return;
  }
  if (key === "close-frozen") {
    const pane = flags.positionals[1]?.trim();
    const rec = pane ? readFrozen(config.stateDir).find((r) => r.pane === pane) : undefined;
    if (pane && !rec) die(`FROZEN_NONE ${pane}: no frozen session recorded for this pane (dori handover frozen lists them)`);
    const lines = rec ? [await closeFrozen(freezeDeps, config.stateDir, rec)] : await closeDueFrozen(freezeDeps, config.stateDir, Date.now());
    for (const line of lines) watchLog(config.watchLog, realClock, { source: "handover", line });
    console.log(lines.join("\n") || "FROZEN_NONE_DUE");
    return;
  }
  // the audit after a committed handover, what a session reports it did not know, and the weekly summary (rollover-audit.ts)
  if (key === "audit") {
    const ref = flags.positionals[1]?.trim() || die("usage: dori handover audit <note.md|key|lead> [--dry-run] [--no-send] [--force]");
    const c = findCommitted(config.stateDir, ref.endsWith(".md") ? resolve(ref) : ref) ?? die(`HANDOVER_AUDIT_NONE ${ref}: no committed handover on record (a result.json with done, done-frozen, done-kept-old or kept-new-old-gone)`);
    const r = await auditHandover(laneDepsFor(), c, { dryRun: Boolean(flags.values["dry-run"]), noSend: Boolean(flags.values["no-send"]), force: Boolean(flags.values.force) });
    process.exit(r.code);
  }
  if (key === "gap") {
    const k = flags.positionals[1]?.trim() || die("usage: dori handover gap <key|lead> --kind KIND --text \"what the new session did not know\" [--fixed]");
    if (k !== "lead") await lane(k);
    const kind = opt("kind")?.trim() || die("--kind is needed: owner's words, decision, lead instruction, todo, goal, monitor, tried fix or other");
    const text = opt("text")?.trim() || die("--text is needed: one line on what was not known (a summary, no secret values)");
    const by = k !== "lead" && here && here === (await deps.registry.read(k))?.pane ? "lane" : "lead";
    console.log(reportGap(deps, k, kind, text, by, Boolean(flags.values["fixed"])).line);
    return;
  }
  if (key === "audit-summary") {
    const days = opt("days") ? Number(opt("days")) : 7;
    if (!(days > 0)) die("--days must be a positive number");
    if (flags.values.send) {
      const week = summaryWeek(Date.now(), config.scorecard.timeZone || "UTC", config.handover.auditSummaryAt || "Mon 08:30") ?? die(`handover.auditSummaryAt "${config.handover.auditSummaryAt}" is not like "Mon 08:30"`);
      console.log(sendAuditSummary(deps, laneDepsFor().inbox ?? join(config.stateDir, "discord", "inbox.jsonl"), week));
    } else console.log(auditSummary(config.stateDir, Date.now(), days));
    return;
  }
  if (key === "ready" || opt("lane")) {
    const laneDeps = laneDepsFor();
    if (key === "ready") {
      if (flags.values.template) {
        console.log(SUMMARY_TEMPLATE);
        return;
      }
      const r = await markReady(laneDeps, await lane(flags.positionals[1]), here, process.pid, opt("note"));
      console.log(r.line);
      process.exit(r.code);
    }
    const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
    if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
    const waitIdle = opt("wait-idle") ? Number(opt("wait-idle")) : undefined;
    if (waitIdle !== undefined && !(waitIdle > 0)) die("--wait-idle must be a positive number of minutes");
    const r = await laneHandover(laneDeps, opt("lane") ?? "", here, { approvedBy: opt("approved-by"), ...(autoGrant ? { autoGrant } : {}), note: opt("note"), model: opt("model"), thinking: opt("thinking"), force: Boolean(flags.values.force), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), verifyMin: minutes, ...(waitIdle ? { waitIdleMin: waitIdle } : {}), ...(opt("request-at") && opt("request-pane") ? { serves: { at: opt("request-at") ?? "", pane: opt("request-pane") ?? "" } } : {}) });
    process.exit(r.code);
  }
  if (flags.values.template) {
    console.log(LEAD_SUMMARY_TEMPLATE);
    return;
  }
  // closing the old lead ends every process in its tmux session, so a handover started there continues as a user unit
  // and since the old lead is frozen at the commit (--keep-old too), it must not run under the agent it stops
  if (here && here === config.leadPane && !flags.values["dry-run"] && !process.env["DORI_HANDOVER_DETACHED"]) {
    const refused = windowsDetachRefusal();
    if (refused) die(refused);
    const unit = `dori-handover-${Date.now()}`;
    const log = join(config.stateDir, "handover", "run.log");
    mkdirSync(join(config.stateDir, "handover"), { recursive: true });
    const pass = passEnv();
    const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...pass, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, cliPath, "handover", ...rest]);
    if (r.code !== 0) die(`HANDOVER_DETACH_FAIL ${r.err || r.out}`);
    console.log(`HANDOVER_DETACHED unit=${unit} log=${log}; progress also goes to ${config.watchLog}`);
    return;
  }
  const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
  if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
  const r = await handover(leadDepsFor((line) => console.log(line)), { approvedBy: opt("approved-by"), ...(autoGrant ? { autoGrant } : {}), note: opt("note"), title: opt("title"), model: opt("model"), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), noMonitors: Boolean(flags.values["no-monitors"]), verifyMin: minutes });
  process.exit(r.code);
};

const rolloverProposeCommand: Command = async (context) => {
  const { key, lane, config, flags } = context;
  const { laneDepsFor, leadDepsFor } = makeHandoverDeps(context);
  const who = key === "lead" ? "lead" : "lane";
  const l = who === "lane" ? await lane(key) : undefined;
  const pane = l ? (l.pane ?? die(`lane ${l.key} has no pane`)) : config.leadPane || die("leadPane is not set");
  const model = l ? (l.model ?? config.defaultModel) : config.handover.model || config.defaultModel;
  const stuck = l ? stuckTop(l) : undefined;
  const signals = { ...(await paneSignals(laneDepsFor(() => {}), pane, model)), ...(stuck ? { stuck } : {}) };
  const h = config.handover;
  const hit = dueReasons(signals, limitsFor(who, h));
  const lines: string[] = [];
  const preview = l ? await laneHandover(laneDepsFor((line) => lines.push(line)), l.key, "", { dryRun: true }) : await handover(leadDepsFor((line) => lines.push(line)), { dryRun: true });
  const blockers = lines.filter((x) => x.startsWith("HANDOVER_REFUSED")).map((x) => x.replace(/^HANDOVER_REFUSED\s*/, "")).join("; ");
  const shown = [signals.contextPct !== undefined ? `context ${signals.contextPct}%` : "", signals.compactions !== undefined ? `${signals.compactions} compactions` : "", signals.afterCompactK !== undefined ? `${signals.afterCompactK}k after the last compaction` : "", signals.ageH !== undefined ? `${signals.ageH} h old` : "", stuck ? `stuck rung ${stuck.rung} on "${stuck.metric}" (${stuck.n} attempts)` : ""].filter(Boolean).join(", ");
  const text = h.proposalText.replaceAll("{who}", l ? `lane ${l.key} (${l.title})` : "the lead").replaceAll("{signals}", hit.length ? `${shown} (${hit.join(", ")})` : `${shown || "no signals"} (no threshold crossed)`).replaceAll("{note}", preview.note ?? "(no note)").replaceAll("{blockers}", blockers ? `. Blocked now: ${blockers}` : "");
  const run = `dori handover ${l ? `--lane ${l.key} ` : ""}--approved-by "${LEAD_PREFIX}<your reason>, ${(hit[0] ?? "<the signal>").replaceAll('"', "'")}"`;
  if (flags.values["dry-run"]) {
    console.log(`ROLLOVER_PROPOSAL_DRY_RUN ${who} ${l?.key ?? "lead"}: ${text}; to go ahead: ${run}`);
    return;
  }
  appendRollover(config.stateDir, { kind: "proposal", who, at: new Date().toISOString(), key: l?.key ?? "lead", pane, signals, crossed: hit, ...(preview.note ? { note: preview.note } : {}), blockers });
  console.log(`ROLLOVER_PROPOSAL ${who} ${l?.key ?? "lead"}: ${text}; logged. Your decision: to go ahead, ${run} (the owner is told afterwards)`);
  return;
};

const compactionTrialCommand: Command = async (context) => {
  const { config, deps, flags } = context;
  const t = config.compactionTrial;
  const rows = trialRows(config, await deps.registry.list());
  if (flags.values["json"]) {
    console.log(JSON.stringify({ trial: t, rows }));
    return;
  }
  console.log(`COMPACTION_TRIAL ${t.until ? `${t.from || "-"} .. ${t.until}, early arm at ${t.atK}k, exclude /${t.exclude}/` : "off (compactionTrial.until is empty)"}; ${trialActive(t, Date.now()) ? "running" : "not running"}`);
  for (const line of trialTable(rows)) console.log(line);
  return;
};

const rolloverStatsCommand: Command = async (context) => {
  const { opt, flags, config } = context;
  const window = opt("window") ? Number(opt("window")) : 24;
  if (!(window > 0)) die("--window must be a positive number of hours");
  if (flags.values.stuck) {
    for (const line of [...stuckOutcomeLines(readRollovers(config.stateDir)), ...(await peerStuckLines(run, config.handover.statsPeers))]) console.log(line);
    return;
  }
  const watch = existsSync(config.watchLog) ? readFileSync(config.watchLog, "utf8").split("\n") : [];
  for (const line of rolloverStats(readRollovers(config.stateDir), watch, Date.now(), window)) console.log(line);
  return;
};

export const handoverCommands: Readonly<Record<string, Command>> = {
  "handover": handoverCommand,
  "rollover-propose": rolloverProposeCommand,
  "compaction-trial": compactionTrialCommand,
  "rollover-stats": rolloverStatsCommand,
};
