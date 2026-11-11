import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paneLife } from "./aoe.ts";
import { isHerdrPane } from "./herdr.ts";
import { reviveHerdr } from "./herdr-sessions.ts";
import { fileLog, installTaskRefusal, serve, serveLoops, spawnLoop, TASK_NAME, taskArgv } from "./serve.ts";
import { findLead } from "./lead.ts";
import { configPath } from "./config.ts";
import { sendVerified } from "./panes.ts";
import { applyUpdate } from "./update.ts";
import { announceChange } from "./update-announce.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { watchTick } from "./done-flow.ts";
import { guardTick, outsideLines, sampleHost, sampleOutside } from "./host-guard.ts";
import { areaLabel, type AreaQuery, areaSignals, formatSignals } from "./lane-signals.ts";
import { statusOf } from "./registry.ts";
import { bootCheck, slackAuthCheck } from "./boot.ts";
import { Reports } from "./reports.ts";
import { Worklog } from "./worklog.ts";
import { Slack } from "./messenger/slack.ts";
import { fetchHttp } from "./messenger/http.ts";
import { hcCoreRunning, realClock, run, runtimesOf } from "./run.ts";
import { canLaunch } from "./routing.ts";
import { computeScorecard, dayWindow, formatScorecard, saveScorecard } from "./scorecard.ts";
import { eyesOff } from "./messenger/discord-listener.ts";
import { transcribe } from "./messenger/voice.ts";
import type { Command } from "./cli-context.ts";
import { die, every } from "./cli-context.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

const notifyChangeCommand: Command = async (context) => {
  const { flags, config, need } = context;
  const files = flags.values.file;
  process.exitCode = await announceChange({ config, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { summary: need("summary"), files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [] }) ? 0 : 1;
  return;
};

const eyesCommand: Command = async (context) => {
  const { key, onlyOptions, flags, config } = context;
  const { discordClient } = makeDiscordDeps(context);
  if (key !== "off") die("usage: dori eyes off <message id | link>", 2);
  onlyOptions("eyes off", [], 2);
  const ref = flags.positionals[1] ?? die("usage: dori eyes off <message id | link>", 2);
  const inbox = process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
  console.log(await eyesOff(discordClient(), join(dirname(inbox), "eyes.json"), ref, process.env["DORI_DISCORD_PAIR_CHANNEL"]?.trim() ?? "").catch((e: unknown) => die(`EYES_OFF_FAIL ${ref} ${e instanceof Error ? e.message : String(e)}`)));
  return;
};

const updateCommand: Command = async (context) => {
  const { config, flags } = context;
  process.exitCode = await applyUpdate({ config, configPath: configPath(), git: run, systemctl: run, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { pull: Boolean(flags.values.pull), dryRun: Boolean(flags.values["dry-run"]) }) ? 0 : 1;
  return;
};

const bootCommand: Command = async (context) => {
  const { deps } = context;
  const token = process.env["DORI_SLACK_TOKEN"];
  const slack = token ? new Slack(fetchHttp, realClock, { token, cookie: process.env["DORI_SLACK_COOKIE"] }, process.env["DORI_SLACK_API"]?.trim() || undefined) : null;
  const sessionDirs = [process.env["PI_SESSION_DIR"], process.env["PI_SESSION_FILE"] && dirname(process.env["PI_SESSION_FILE"])];
  const result = await bootCheck({
    ...deps,
    reports: new Reports(deps.config.stateDir),
    worklog: new Worklog(deps.config.stateDir),
    rts: runtimesOf(deps.run, { runtime: deps.config.runtime }),
    hcCoreUp: () => hcCoreRunning(),
    slack: slackAuthCheck(slack),
    monitorDirs: sessionDirs.flatMap((dir) => (dir ? [join(dir, "extensions", "terminal")] : [])),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
  return;
};

const watchCommand: Command = async (context) => {
  const { deps } = context;
  console.log("LANE_WATCH_READY");
  for (;;) {
    for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
    await Bun.sleep(30_000);
  }
};

const scorecardCommand: Command = async (context) => {
  const { opt, config, deps, flags } = context;
  const { env, discordClient } = makeDiscordDeps(context);
  const window = dayWindow(opt("date") ?? "today", config.scorecard.timeZone, Date.now());
  const data = await computeScorecard({
    stateDir: config.stateDir,
    sessionsDir: config.scorecard.sessions,
    lanes: await deps.registry.list(),
    settings: config.scorecard,
    inbox: config.scorecard.inbox || process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
    owner: process.env["DORI_DISCORD_OWNER"]?.trim() ?? "",
  }, window);
  const text = formatScorecard(data, config.scorecard.language, Date.now());
  console.log(text);
  console.log(`SAVED ${await saveScorecard(join(config.stateDir, "scorecard"), data, text, config.scorecard.keepDays)}`);
  if (flags.values.post) {
    const ref = opt("to") || config.scorecard.postTo || `discord:${env("DORI_DISCORD_CHANNEL")}`;
    const id = /^discord:(\d{5,25})$/.exec(ref)?.[1] ?? die(`scorecard posts to discord:<channel or thread id>, not ${ref}`);
    console.log(`SENT ${await discordClient().send(id, text)}`);
  }
  return;
};

const signalsCommand: Command = async (context) => {
  const { opt, tags, openSignals, deps, config } = context;
  const q: AreaQuery = { ...(opt("lane") ? { lane: opt("lane") } : {}), ...(opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : {}), ...(tags().length ? { tags: tags() } : {}) };
  if (!q.lane && !q.cwd && !q.tags) {
    const lines = await openSignals();
    console.log(lines.length ? lines.join("\n") : "SIGNALS none for open lanes");
    return;
  }
  const list = await areaSignals(await deps.registry.list(), q, config);
  console.log(list.length ? formatSignals(areaLabel(q), list) : `SIGNALS no lane in ${areaLabel(q)}`);
  return;
};

const deadPanesCommand: Command = async (context) => {
  const { loopMinutes, deps, config } = context;
  const seen = new Set<string>();
  const panes = newDeadPaneState();
  await every(loopMinutes(), async () => {
    const paused = (await deps.registry.open()).flatMap((l) => (statusOf(l) === "paused" && l.pane ? [l.pane] : []));
    for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paused, panes)) console.log(line);
  });
  return;
};

const guardCommand: Command = async (context) => {
  const { loopMinutes, config } = context;
  const state = { alerting: false, outside: new Set<number>() };
  const minutes = loopMinutes();
  console.log("HOST_GUARD_READY");
  await every(minutes, async () => {
    for (const line of [...guardTick(await sampleHost(run, config), config.guard, state), ...outsideLines(await sampleOutside(run), state.outside)]) console.log(line);
  });
  return;
};

const canLaunchCommand: Command = async (context) => {
  const { config } = context;
  const v = canLaunch(await sampleHost(run, config), config.guard);
  console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
  process.exit(v.ok ? 0 : 4);
};

const leadCommand: Command = async (context) => {
  const { config } = context;
  console.log(await findLead(run, config));
  return;
};

const serveCommand: Command = async (context) => {
  const { flags, opt, config, cliUrl } = context;
  const cli = fileURLToPath(cliUrl);
  const sessionWatch = fileURLToPath(new URL("../../setups/discord-aoe/session-watch.ts", cliUrl));
  if (flags.values["install-task"]) {
    const refused = installTaskRefusal((Array.isArray(flags.values.only) ? flags.values.only : []).map(String), opt("log"));
    if (refused) die(refused);
    const argv = taskArgv(process.execPath, cli, config.stateDir);
    const r = await run(argv);
    console.log(r.code === 0 ? `SERVE_TASK_INSTALLED "${TASK_NAME}" at logon` : `SERVE_TASK_FAIL ${(r.err || r.out).slice(0, 200)}`);
    if (r.code !== 0) process.exitCode = 1;
    return;
  }
  const only = new Set(Array.isArray(flags.values.only) ? flags.values.only : []);
  const loops = serveLoops(process.execPath, cli, sessionWatch).filter((l) => !only.size || only.has(l.tag));
  const log = opt("log") ?? join(config.stateDir, "serve.log");
  console.log(`SERVE_READY ${loops.map((l) => l.tag).join(",")} log ${log}`);
  await serve(loops, { start: spawnLoop, log: fileLog(log, realClock), clock: realClock });
  return;
};

const reviveCommand: Command = async (context) => {
  const { key, config, opt } = context;
  const pane = key ?? die("usage: dori revive <herdr pane> [--text TEXT]");
  if (!isHerdrPane(pane)) die("revive takes a herdr pane id (an aoe session restarts with self-restart.sh)");
  // dori never ends a live herdr agent: only a pane whose agent is gone is started again
  if ((await paneLife(run, pane)).live) {
    console.log(`REVIVE_ALREADY_RUNNING ${pane}`);
    return;
  }
  const line = await reviveHerdr(run, realClock, config, pane, opt("text") ?? "", (p, t) => sendVerified(run, realClock, config, p, t));
  console.log(line);
  if (!line.startsWith("REVIVE_OK")) process.exitCode = 1;
  return;
};

const transcribeCommand: Command = async (context) => {
  const { config, key } = context;
  console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
  return;
};

export const opsCommands: Readonly<Record<string, Command>> = {
  "boot": bootCommand,
  "notify-change": notifyChangeCommand,
  "eyes": eyesCommand,
  "update": updateCommand,
  "watch": watchCommand,
  "scorecard": scorecardCommand,
  "signals": signalsCommand,
  "dead-panes": deadPanesCommand,
  "guard": guardCommand,
  "can-launch": canLaunchCommand,
  "lead": leadCommand,
  "serve": serveCommand,
  "revive": reviveCommand,
  "transcribe": transcribeCommand,
};
