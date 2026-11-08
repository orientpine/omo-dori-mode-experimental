import { addItem, BacklogError, backlogTick, byTurn, decideItem, dropItem, itemLine, laneKeyOf, lastRun, listItems, readItem, withBacklogLock } from "./backlog.ts";
import { configPath } from "./config.ts";
import { realClock } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";
import { makeBacklogDeps } from "./cli-deps-backlog.ts";

const backlogCommand: Command = async (context) => {
  const { key, flags, config, opt, deps, need, threadOpt, noThreadOpt, whyNewOpt, tags, many } = context;
  const { ownerLinkProblem } = makeDirectiveDeps(context);
  const { backlogDeps } = makeBacklogDeps(context);
  const sub = key ?? "list";
  const id = flags.positionals[1];
  const at = new Date().toISOString();
  const state = config.backlog.enabled ? `BACKLOG_ON one pass every ${config.backlog.everyMin} min, at most ${config.backlog.maxStarts} start(s) a pass while fewer than ${config.backlog.maxLanes} lanes are open` : `BACKLOG_OFF backlog.enabled is false in ${configPath()}: items wait until this Dori turns it on`;
  try {
    if (sub === "list") {
      const items = listItems(config.stateDir).filter((i) => flags.values.all || i.status === "open" || i.status === "running").sort(byTurn);
      console.log(items.length ? items.map(itemLine).join("\n") : "BACKLOG_EMPTY");
      const last = lastRun(config.stateDir);
      console.log(`${state}${last ? `; last pass ${last.at}` : ""}`);
    } else if (sub === "add") {
      const itemId = id ?? die("usage: dori backlog add <id> --title T --brief FILE --done \"...\"");
      const ownerLink = opt("owner-link");
      const ownerProblem = ownerLink ? await ownerLinkProblem(ownerLink) : undefined;
      if (ownerLink && ownerProblem && !config.backlog.writeNeedsOwnerLink) die(`BACKLOG_REFUSED --owner-link ${ownerLink}: ${ownerProblem}`, 2);
      const registered = Boolean(await deps.registry.read(laneKeyOf(itemId)));
      const r = await withBacklogLock(config.stateDir, 120, () => addItem(config.stateDir, { id: itemId, title: need("title"), brief: need("brief"), done: need("done"), priority: opt("priority"), cwd: opt("cwd"), thread: threadOpt(), noThread: noThreadOpt(), whyNew: whyNewOpt(), goal: opt("goal"), tags: tags(), ask: flags.values.ask === true ? "" : opt("ask"), by: opt("by"), readOnly: Boolean(flags.values["read-only"]), ownerLink }, { registered, at, needOwnerLink: config.backlog.writeNeedsOwnerLink, ownerProblem }));
      console.log(`${r.replaced ? "BACKLOG_REPLACED" : "BACKLOG_ADDED"} ${itemLine(r.item)}`);
      if (!config.backlog.enabled) console.log(state);
    } else if (sub === "drop") {
      const dropId = id ?? die("usage: dori backlog drop <id> [--reason R]");
      const dropped = await withBacklogLock(config.stateDir, 120, () => dropItem(config.stateDir, dropId, many("reason").join("; ") || "by the lead", at));
      console.log(`BACKLOG_DROPPED ${id}${dropped.log[0]?.what.startsWith("dropped before intake") ? " before intake: the #dori-pair intake skips it when the post comes" : ""}`);
    } else if (sub === "decide") {
      const kst = `${new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} KST`;
      const decideId = id ?? die("usage: dori backlog decide <id> --text \"<the owner's answer>\"");
      const item = await withBacklogLock(config.stateDir, 120, () => decideItem(config.stateDir, decideId, opt("text") ?? "", at, kst, opt("question"), flags.values.hash === undefined ? undefined : String(flags.values.hash)));
      console.log(`BACKLOG_DECIDED ${item.id}: the answer is in its brief; it starts at a pass when its turn comes`);
    } else if (sub === "tick") {
      if (!config.backlog.enabled && !flags.values.force) die(state, 4);
      const lines = await backlogTick(backlogDeps(), { force: Boolean(flags.values.force) });
      for (const line of lines) {
        watchLog(config.watchLog, realClock, { source: "backlog", line });
        console.log(line);
      }
      if (!lines.length) console.log(`BACKLOG_QUIET nothing new since the last pass; the next sweep is ${config.backlog.everyMin} min after ${lastRun(config.stateDir)?.at ?? "?"} (--force: now)`);
    } else if (sub === "show") {
      const item = readItem(config.stateDir, id ?? die("usage: dori backlog show <id>")) ?? die(`no backlog item ${id}`);
      console.log(JSON.stringify(item, null, 1));
    } else die(`backlog: unknown step ${sub} (list, add, drop, decide, tick, show)`);
  } catch (e) {
    if (e instanceof BacklogError) die(`BACKLOG_REFUSED ${e.message}`, 2);
    throw e;
  }
  return;
};

export const backlogCommands: Readonly<Record<string, Command>> = {
  "backlog": backlogCommand,
};
