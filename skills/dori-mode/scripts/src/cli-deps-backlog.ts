import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { type FeedTodo, feedIntake, inboxReader, instanceOf, orderIntake, pairIntake, type TickDeps } from "./backlog.ts";
import { pairHandled } from "./backlog-pair.ts";
import { poolFree } from "./lead-limit.ts";
import { repliedTo } from "./send-dedupe.ts";
import { sampleHost } from "./host-guard.ts";
import { asStartFailure, laneStartText, launchLane } from "./launch.ts";
import { realClock, run } from "./run.ts";
import { canLaunch } from "./routing.ts";
import { postLaneStart } from "./messenger/discord-thread.ts";
import type { Cli } from "./cli-context.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

export const makeBacklogDeps = (cli: Pick<Cli, "config" | "deps" | "discordToken">) => {
  const { config, deps, discordToken } = cli;
  const { auditInbox } = makeDirectiveDeps(cli);
  const { ownDiscord, idList } = makeDiscordDeps(cli);
  // dori backlog: a pass starts an item through the same launch as dori launch and tells the lead in its inbox
  const backlogInbox = (kind: string, id: string, content: string): void => {
    const inbox = auditInbox();
    mkdirSync(join(inbox, ".."), { recursive: true });
    appendFileSync(inbox, `${JSON.stringify({ ts: new Date().toISOString(), id, kind, content })}\n`);
  };
  const backlogDeps = (): TickDeps => ({
    stateDir: config.stateDir,
    settings: config.backlog,
    now: realClock.now,
    lanes: () => deps.registry.list(),
    busy: async () => {
      const host = await sampleHost(run, config);
      return [...canLaunch(host, config.guard).reasons, ...(host.load1 > config.guard.loadOk ? [`load ${host.load1.toFixed(1)} > ${config.guard.loadOk}`] : [])];
    },
    launch: async (item, brief, key) => {
      const leadBrief = readFileSync(brief, "utf8");
      const input = { key, backlog: true, title: item.title, brief, done: item.done, thread: item.thread, noThread: item.noThread, whyNew: item.whyNew, cwd: item.cwd, tags: [...(item.tags ?? []), "backlog"], goal: item.goal };
      const r = await launchLane(deps, input, (line) => console.log(line)).catch((e: unknown) => {
        throw asStartFailure(e);
      });
      if (r.lane.thread.startsWith("discord:") && discordToken) {
        console.log(await Promise.resolve().then(() => postLaneStart(ownDiscord(discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief))).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`));
      }
      return { pane: r.lane.pane ?? "?", startup: r.startup };
    },
    limited: () => {
      const provider = config.defaultModel.split("/")[0];
      return poolFree(config.sessionsDir, provider, Date.now()) ? undefined : `usage limit: no ${provider} account is free in omo's credential pool`;
    },
    host: { dir: config.backlog.hostDir, user: userInfo().username, instance: instanceOf(config.stateDir), max: config.backlog.hostMaxLanes },
    intake: async (sweep) => {
      // the #dori-pair posts and the owner's orders every tick, from where the last pass stopped reading the inbox (kept once
      // both took them)
      const inbox = inboxReader(config.stateDir, auditInbox());
      const orders = [
        ...pairIntake({ stateDir: config.stateDir, settings: config.backlog, rows: inbox.rows, now: realClock.now, pairBots: idList(process.env["DORI_DISCORD_PAIR_BOT"]), guild: process.env["DORI_DISCORD_GUILD"]?.trim() ?? "" }),
        ...orderIntake({ stateDir: config.stateDir, settings: config.backlog, rows: inbox.rows, now: realClock.now }),
      ];
      inbox.commit();
      if (!sweep || !config.backlog.feedCommand.length) return orders;
      const feed = async (): Promise<{ readonly todos: readonly FeedTodo[] } | { readonly why: string }> => {
        const r = await run(config.backlog.feedCommand.map((p) => p.replace(/^~(?=\/)/, homedir())), { timeoutMs: 120_000 });
        if (r.code !== 0) return { why: (r.err || r.out).trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code}` };
        try {
          const v = JSON.parse(r.out) as unknown;
          const list = Array.isArray(v) ? v : (v as { todos?: unknown }).todos;
          return Array.isArray(list) ? { todos: list as FeedTodo[] } : { why: "the output is not a JSON list" };
        } catch {
          return { why: "the output is not JSON" };
        }
      };
      return [...orders, ...(await feedIntake({ stateDir: config.stateDir, settings: config.backlog, feed, now: realClock.now }))];
    },
    inbox: backlogInbox,
    handled: (item, lanes) => pairHandled(item, lanes, (message) => repliedTo(join(config.stateDir, "sent"), message)),
  });
  return { backlogInbox, backlogDeps };
};
