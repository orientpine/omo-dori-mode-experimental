import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backlogTick } from "./backlog.ts";
import { accountHome, missingWatchers, windowsDetachRefusal } from "./handover.ts";
import { paneSignals } from "./lane-handover.ts";
import { type Committed, markerFile, sendAuditSummary } from "./rollover-audit.ts";
import { AUTO_GRANT_ENV, decidedBy, mintAutoGrant, type RolloverRequest } from "./rollover.ts";
import { paneTranscriptHas } from "./panes.ts";
import { retryLaneTells } from "./lane-tells.ts";
import { autoReadyLine, freshnessTick, resumeArgs } from "./freshness.ts";
import { auditOrReport, dailyAuditHook, pushLinks } from "./directive-audit.ts";
import { realClock, run } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { closeDueFrozen } from "./frozen.ts";
import { openCardIds, QuestionStore } from "./messenger/discord-cards.ts";
import { threads } from "./messenger/thread-map.ts";
import { archiveDoneThreads } from "./messenger/thread-archive.ts";
import type { Command } from "./cli-context.ts";
import { every } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";
import { makeBacklogDeps } from "./cli-deps-backlog.ts";

const freshnessCommand: Command = async (context) => {
  const { loopMinutes, config, deps, discordToken, cliPath } = context;
  const { laneDepsFor, passEnv, freezeDeps } = makeHandoverDeps(context);
  const { auditInbox, leadMemoryRepo } = makeDirectiveDeps(context);
  const { cardDir, ownDiscord } = makeDiscordDeps(context);
  const { backlogDeps } = makeBacklogDeps(context);
  const minutes = loopMinutes();
  console.log(autoReadyLine(config.handover));
  // a handover.watchers check that fails refuses every lead handover, the automatic one too: said once at start (the
  // lanes service starts again after each update), in the watch log and to the pair channel, not first at the refusal
  if (config.leadPane && config.handover.watchers.length) {
    const down = await missingWatchers({ run }, config.handover.watchers, { pane: config.leadPane, session: "" });
    if (down.length) {
      const line = `HANDOVER_WATCHER_DOWN ${config.leadPane}: ${down.join(", ")}; every lead handover, the automatic one too, is refused until it runs or handover.watchers is fixed`;
      console.log(line);
      for (const l of (await deps.postLeadAlert?.(line).catch((e: unknown) => [`LEAD_ALERT_WARN ${String(e).slice(0, 160)}`])) ?? []) console.log(l);
    }
  }
  await every(minutes, async () => {
    const laneDeps = laneDepsFor(() => {});
    const hooks = {
      signals: (pane: string, model: string) => paneSignals(laneDeps, pane, model),
      // automatic rollover (handover.autoRolloverLanes / autoRolloverLead): a detached run, approved as auto:<key>
      auto: async (who: "lead" | "lane", k: string) => {
        const refused = windowsDetachRefusal();
        if (refused) return `could not start: ${refused}`;
        const unit = `dori-rollover-${k}-${Date.now()}`;
        const log = join(config.stateDir, "handover", "run.log");
        mkdirSync(join(config.stateDir, "handover"), { recursive: true });
        const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", `--setenv=${AUTO_GRANT_ENV}=${mintAutoGrant(config.stateDir, who, who === "lane" ? k : "lead", Date.now())}`, ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, cliPath, "handover", ...(who === "lane" ? ["--lane", k, "--wait-idle", String(config.handover.autoWaitMin)] : []), "--approved-by", `auto:handover.autoRollover${who === "lane" ? "Lanes" : "Lead"}`]);
        return r.code === 0 ? `started unit=${unit} log=${log}` : `could not start: ${(r.err || r.out).trim().slice(0, 160)}`;
      },
      // a lead's lane handover refused while the lane was busy, started again once the lane marked ready: a detached run
      // with the same approval and options that waits for the lane's idle moment like an automatic one
      resume: async (k: string, approvedBy: string, request: RolloverRequest, serves: { readonly at: string; readonly pane: string }) => {
        const refused = windowsDetachRefusal();
        if (refused) return { started: false, line: `could not start: ${refused}` };
        const unit = `dori-rollover-${k}-${Date.now()}`;
        const log = join(config.stateDir, "handover", "run.log");
        mkdirSync(join(config.stateDir, "handover"), { recursive: true });
        const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...(decidedBy(approvedBy) === "auto" ? [`--setenv=${AUTO_GRANT_ENV}=${mintAutoGrant(config.stateDir, "lane", k, Date.now())}`] : []), ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, cliPath, "handover", "--lane", k, "--wait-idle", String(config.handover.autoWaitMin), "--approved-by", approvedBy, ...resumeArgs(request), "--request-at", serves.at, "--request-pane", serves.pane]);
        return r.code === 0 ? { started: true, line: `unit=${unit} log=${log}` } : { started: false, line: `could not start: ${(r.err || r.out).trim().slice(0, 160)}` };
      },
      // the audit after a committed handover: a detached run, so its supplement round does not hold up the sweep
      audit: async (c: Committed) => {
        const refused = windowsDetachRefusal();
        if (refused) {
          rmSync(markerFile(c.note), { force: true });
          return `could not start: ${refused}`;
        }
        const unit = `dori-handover-audit-${c.key}-${Date.now()}`;
        const log = join(config.stateDir, "handover", "run.log");
        const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, cliPath, "handover", "audit", c.note]);
        if (r.code !== 0) rmSync(markerFile(c.note), { force: true });
        return r.code === 0 ? `started unit=${unit} log=${log}` : `could not start: ${(r.err || r.out).trim().slice(0, 160)}`;
      },
      auditSummary: (week: string) => sendAuditSummary(deps, laneDeps.inbox ?? join(config.stateDir, "discord", "inbox.jsonl"), week),
      // the daily directive audit on every Dori, and the owner's links pushed to the other Dori (directives.linkPeers)
      directiveAudit: dailyAuditHook(config, async (since: string) => (await auditOrReport(deps, { since, inbox: auditInbox(), owner: process.env["DORI_DISCORD_OWNER"]?.trim() ?? "", threads: threads(cardDir()), memory: leadMemoryRepo() })).lines),
      directiveLinks: async () => (await pushLinks(deps)).lines,
    };
    for (const a of await freshnessTick(deps, accountHome(), hooks)) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
    // a done thread that a post after its close opened again goes back to the archive once quiet (discord.autoArchiveMin)
    if (discordToken) {
      const statusFile = join(cardDir(), "thread-status.json");
      const store = new QuestionStore(cardDir());
      const archived = await Promise.resolve()
        .then(() =>
          archiveDoneThreads({
            dc: ownDiscord(discordToken),
            guild: process.env["DORI_DISCORD_GUILD"]?.trim() ?? "",
            channel: process.env["DORI_DISCORD_CHANNEL"]?.trim() ?? "",
            words: config.discord,
            afterMin: config.discord.autoArchiveMin,
            now: realClock.now,
            laneThreads: async () => new Set((await deps.registry.open()).flatMap((l) => (l.thread?.startsWith("discord:") ? [l.thread.slice("discord:".length)] : []))),
            openCards: (t) => openCardIds(store, t),
            pendingStatus: (t) => existsSync(statusFile) && t in (JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>),
          }),
        )
        .catch((e: unknown) => [`THREAD_AUTO_ARCHIVE_WARN ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`]);
      for (const line of archived) console.log(line);
    }
    // a lane a lead handover could not tell (told=no) is told once a turn runs there, or the lead hears of it
    for (const line of await retryLaneTells({ run, clock: realClock, config, registry: deps.registry, delivered: (pane, text, since) => paneTranscriptHas(run, config.sessionsDir, pane, text, since) })) {
      watchLog(config.watchLog, realClock, { source: "handover", line });
      console.log(line);
    }
    // a frozen old lead is closed handover.frozenCloseH hours after its handover
    for (const line of await closeDueFrozen(freezeDeps, config.stateDir, Date.now())) {
      watchLog(config.watchLog, realClock, { source: "handover", line });
      console.log(line);
    }
    // the backlog pass (dori backlog), on a Dori that turned it on: every tick, with a sweep every backlog.everyMin minutes
    if (config.backlog.enabled) {
      for (const line of await backlogTick(backlogDeps()).catch((e: unknown) => [`BACKLOG_WARN ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`])) {
        watchLog(config.watchLog, realClock, { source: "backlog", line });
        console.log(line);
      }
    }
  });
  return;
};

export const freshnessCommands: Readonly<Record<string, Command>> = {
  "freshness": freshnessCommand,
};
