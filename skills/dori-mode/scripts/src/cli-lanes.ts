import { fill } from "./config.ts";
import { adoptLane, DirectiveMissingError, doneWeakWarning, goalWarning, laneStartText, launchEnvArgs, launchLane, launchLedger, relatedGate, renderBrief, reopenLaneThread, setDone, setGpu, setThread, threadGate, ThreadMissingError, validateLaunch } from "./launch.ts";
import { realClock } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { syncRegistry } from "./sync.ts";
import { postInThread, postLaneStart } from "./messenger/discord-thread.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

const launchCommand: Command = async (context) => {
  const { key, need, threadOpt, noThreadOpt, whyNewOpt, opt, tags, flags, many, waive, budgetOpts, deps, config, discordToken } = context;
  const { ownDiscord, discordClient, env } = makeDiscordDeps(context);
  const input = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), noThread: noThreadOpt(), whyNew: whyNewOpt(), model: opt("model"), cwd: opt("cwd"), tags: tags(), doneWeakOk: Boolean(flags.values["done-weak-ok"]), goal: opt("goal"), challengeBefore: many("challenge-before"), useGpu: Boolean(flags.values["use-gpu"]), ui: Boolean(flags.values.ui), waive, budget: budgetOpts(), activityPaths: many("activity-path") };
  const noGoal = goalWarning(input);
  if (noGoal) console.log(noGoal);
  // LAUNCH_NO_THREAD / LAUNCH_THREAD_IS_CHANNEL / LAUNCH_RELATED_THREAD: nothing opened, exit 4 like a missing directive
  const threadMissing = (e: unknown): never => {
    if (e instanceof ThreadMissingError) die(e.message, 4);
    throw e;
  };
  if (flags.values["dry-run"]) {
    await validateLaunch(deps, input);
    try {
      threadGate(deps, input);
      for (const line of await relatedGate(deps, input)) console.log(line);
    } catch (e) {
      threadMissing(e);
    }
    const weak = await doneWeakWarning(input, input.cwd ?? config.defaultCwd);
    if (weak) console.log(weak);
    const rendered = await renderBrief(deps, input);
    for (const line of [...rendered.lines, ...(rendered.steps ? [rendered.steps] : []), ...rendered.missing]) console.log(line);
    console.log(rendered.text);
    console.log(`DRY_RUN ${input.key}: brief not written, no pane opened, nothing registered${rendered.missing.length ? "; a real launch stops here (LAUNCH_DIRECTIVE_MISSING)" : ""}`);
    if (rendered.missing.length) process.exit(4);
    return;
  }
  const leadBrief = await Bun.file(input.brief).text().catch(() => "");
  const r = await launchLane(deps, input, (line) => console.log(line)).catch((e: unknown) => {
    // the LAUNCH_DIRECTIVE_MISSING lines are printed and logged already
    if (e instanceof DirectiveMissingError) process.exit(4);
    return threadMissing(e);
  });
  console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
  for (const w of r.lane.directives?.waived ?? []) {
    const name = launchLedger(deps).entries.find((e) => e.id === w.id)?.name ?? w.id;
    const text = fill([config.discord.waiveText], { key: r.lane.key, id: w.id, name, reason: w.reason })[0] ?? "";
    const line = !discordToken
      ? `DIRECTIVE_WAIVE_NOT_SENT ${r.lane.key} ${w.id}: DORI_DISCORD_TOKEN is not set, so the owner was not told`
      : await Promise.resolve()
          .then((): Promise<unknown> => (r.lane.thread.startsWith("discord:") ? postInThread(ownDiscord(discordToken), r.lane.thread, text) : discordClient().send(env("DORI_DISCORD_CHANNEL"), text)))
          .then(() => `DIRECTIVE_WAIVE_SENT ${r.lane.key} ${w.id}: the owner was told`)
          .catch((e: unknown) => `DIRECTIVE_WAIVE_NOT_SENT ${r.lane.key} ${w.id}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(line);
    watchLog(config.watchLog, realClock, { source: "launch", line });
  }
  if (r.lane.thread.startsWith("discord:")) {
    if (!discordToken) console.log(`THREAD_START_NO_TOKEN ${r.lane.thread}: DORI_DISCORD_TOKEN is not set, so no first message was posted`);
    else {
      const started = await Promise.resolve().then(() => postLaneStart(ownDiscord(discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief))).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`);
      console.log(started);
    }
  }
  console.log(r.startup);
  process.exit(/^STARTUP_(OK|PENDING_GOAL|DONE) /.test(r.startup) ? 0 : 3);
};

const adoptCommand: Command = async (context) => {
  const { deps, key, need, threadOpt, tags, opt, many, flags, config } = context;
  const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), pane: need("pane"), tags: tags(), goal: opt("goal"), challengeBefore: many("challenge-before"), useGpu: Boolean(flags.values["use-gpu"]) });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
  const reopened = await reopenLaneThread(deps, l);
  if (reopened) console.log(reopened);
  if (config.backend === "aoe" && Object.keys(config.launchEnv).length) console.log(`ADOPT_ENV ${l.key}: the running session keeps the environment it started with; ${l.useGpu ? "no launchEnv" : "launchEnv"} applies from its next handover or restart`);
  return;
};

const syncCommand: Command = async (context) => {
  const { deps, flags, openSignals } = context;
  const r = await syncRegistry(deps, Boolean(flags.values.write));
  console.log("key | thread | pane | session | status");
  for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
  for (const s of await openSignals()) console.log(s);
  console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
  console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
  return;
};

const setThreadCommand: Command = async (context) => {
  const { flags, deps, lane, key } = context;
  const ref = flags.positionals[1]?.trim() ?? die("usage: dori set-thread <key> <adapter>:<id>");
  console.log(await setThread(deps, await lane(key ?? die("set-thread needs a lane key")), ref));
  return;
};

const doneSetCommand: Command = async (context) => {
  const { lane, key, deps, need, many } = context;
  const l = await lane(key ?? die("done-set needs a lane key"));
  for (const line of await setDone(deps, l, need("done"), many("reason").join("; "))) console.log(line);
  return;
};

const setGpuCommand: Command = async (context) => {
  const { flags, deps, lane, key } = context;
  const on = flags.positionals[1]?.trim();
  if (on !== "on" && on !== "off") die("usage: dori set-gpu <key> on|off");
  console.log(await setGpu(deps, await lane(key ?? die("set-gpu needs a lane key")), on === "on"));
  return;
};

const launchEnvCommand: Command = async (context) => {
  const { deps, key } = context;
  for (const arg of await launchEnvArgs(deps, key ?? die("usage: dori launch-env <tmux-session>"))) console.log(arg);
  return;
};

export const lanesCommands: Readonly<Record<string, Command>> = {
  "launch": launchCommand,
  "adopt": adoptCommand,
  "sync": syncCommand,
  "set-thread": setThreadCommand,
  "done-set": doneSetCommand,
  "set-gpu": setGpuCommand,
  "launch-env": launchEnvCommand,
};
