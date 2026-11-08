import { Checkpoints } from "./checkpoints.ts";
import { laneLimits } from "./supervision.ts";
import { appendRollover, holdTyped, outcomeLine, pendingStuck, readRollovers } from "./rollover.ts";
import { claimDone, closeLane, closeLessons, GoalUnverifiedError, objectDone, pauseLane, resumeLane, typeIntoPane } from "./done-flow.ts";
import { plainSummaryProblem } from "./close-summary.ts";
import { challengeMissing } from "./challenge.ts";
import { gateMissing } from "./merge-gate.ts";
import { realClock } from "./run.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";

const typeCommand: Command = async (context) => {
  const { key, opt, need, deps, config } = context;
  const pane = key ?? die("type needs a pane (a tmux session name or a herdr pane id)");
  const file = opt("text-file");
  const text = file ? (await Bun.file(file).text()).trim() : need("text");
  if (!text) die("type needs non-empty text");
  const r = await typeIntoPane(deps, pane, text);
  for (const note of r.notes) console.error(note);
  if (r.pane !== pane) console.error(`FORWARDED ${pane} -> ${r.pane}: ${pane} was frozen by a handover, so the text went to the session that replaced it`);
  console.log(r.status === "SUBMITTED" ? `SUBMITTED ${r.pane}` : `NOT_SUBMITTED ${r.pane} ${r.reason}`);
  // a pane a handover is moving: the text is kept for the new session too (lane-handover hands it over at the commit)
  if (holdTyped(config.stateDir, pane, Date.now(), text)) console.error(`HANDOVER_HELD ${pane}: a handover is moving this session; the text is also kept for the new session and handed to it when the move commits`);
  process.exitCode = r.status === "SUBMITTED" ? 0 : 1;
  return;
};

const claimDoneCommand: Command = async (context) => {
  const { lane, key, deps, opt, postable, config, flags, evidence, postedId } = context;
  const l = await lane(key);
  const missing = challengeMissing(l);
  if (missing) die(missing, 5);
  const ungated = await gateMissing(deps, l.done);
  if (ungated.length) die(ungated.join("\n"), 5);
  const summary = opt("summary");
  if (summary !== undefined) postable(summary, `claim-done --summary ${l.key}`);
  const bad = summary === undefined ? undefined : plainSummaryProblem(summary, config.discord.locale, config.discord.ownerSpeech);
  if (bad) die(`SUMMARY_REFUSED ${l.key}: ${bad}; write it for the owner in plain words`, 2);
  const outcome = opt("rollover-outcome");
  if (flags.values["rollover-unresolved"] && outcome === undefined) die("--rollover-unresolved goes with --rollover-outcome \"<one line>\"", 2);
  const claimed = await claimDone(deps, l, evidence(), summary, { posted: postedId(), postSummary: Boolean(flags.values["post-summary"]), ...(outcome !== undefined ? { rolloverOutcome: { line: outcome, resolved: !flags.values["rollover-unresolved"] } } : {}) });
  if (claimed.startsWith("ROLLOVER_OUTCOME_MISSING ")) die(claimed, 2);
  console.log(claimed);
  return;
};

const objectDoneCommand: Command = async (context) => {
  const { flags, deps, lane, key } = context;
  const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
  if (!reasons.length) die("--reason is required");
  console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  return;
};

const pauseCommand: Command = async (context) => {
  const { flags, deps, lane, key } = context;
  const reason = flags.positionals.slice(1).join(" ").trim() || die("usage: dori pause <key> <reason>");
  try {
    for (const line of await pauseLane(deps, await lane(key ?? die("pause needs a lane key")), reason)) console.log(line);
  } catch (e) {
    if (!(e instanceof GoalUnverifiedError)) throw e;
    console.log(e.message);
    process.exit(3);
  }
  return;
};

const resumeCommand: Command = async (context) => {
  const { deps, lane, key } = context;
  try {
    for (const line of await resumeLane(deps, await lane(key ?? die("resume needs a lane key")))) console.log(line);
  } catch (e) {
    if (!(e instanceof GoalUnverifiedError)) throw e;
    console.log(e.message);
    process.exit(3);
  }
  return;
};

const closeCommand: Command = async (context) => {
  const { opt, postable, key, config, lane, flags, evidences, deps, postedId } = context;
  const summary = opt("summary");
  if (summary !== undefined) postable(summary, `close --summary ${key ?? ""}`);
  const bad = summary === undefined ? undefined : plainSummaryProblem(summary, config.discord.locale, config.discord.ownerSpeech);
  if (bad) die(`SUMMARY_REFUSED ${key ?? ""}: ${bad}; write it for the owner in plain words`, 2);
  const target = await lane(key ?? die("close needs a lane key"));
  // --lesson, any number of times: kept after a successful close, each with the --evidence in its place, one --evidence
  // for all, or the Done line; never blocks the close. Evidence that pairs with no lesson is refused before anything.
  const paired = closeLessons(((flags.values.lesson as string[] | undefined) ?? []).map((t) => t.trim()), evidences(), target.done);
  const lessons = typeof paired === "string" ? die(`LESSON_EVIDENCE_MISMATCH ${target.key}: ${paired}; nothing was closed`, 2) : paired;
  const note = opt("note") ?? "closed by the lead";
  const r = await closeLane(deps, target, note, summary, postedId(), lessons);
  for (const line of r.lines) console.log(line);
  // a lane moved for being stuck that closes without its outcome line: the lead's note stands in, counted unknown (the
  // owner may have dropped or changed the work), so rollover-stats still lists it
  const stuck = r.closed ? pendingStuck(readRollovers(config.stateDir), target.key) : undefined;
  if (stuck) {
    const line = outcomeLine(note);
    appendRollover(config.stateDir, { kind: "outcome", at: new Date().toISOString(), key: target.key, rolloverAt: stuck.at, line, by: "close" });
    console.log(`ROLLOVER_OUTCOME ${target.key} unknown (rollover ${stuck.at}): ${line}`);
  }
  process.exit(r.closed ? 0 : 2);
};

const capsCommand: Command = async (context) => {
  const { key, deps, budgetOpts, config } = context;
  const l = (key ? await deps.registry.read(key) : undefined) ?? die(`usage: dori caps <key> [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none]; no registered lane ${JSON.stringify(key ?? "")}`, 2);
  const set = budgetOpts();
  if (Object.keys(set).length) await deps.registry.patch(l.key, { budget: { ...l.budget, ...set } });
  const now = (await deps.registry.read(l.key)) ?? l;
  const caps = laneLimits(config.supervision, now);
  const show = (v: number | null): string => (v === null ? "off" : String(v));
  console.log(`CAPS ${l.key} wallMinutes=${show(caps.wallMinutes)} tokens=${show(caps.tokens)} costUsd=${show(caps.costUsd)} (its own: ${JSON.stringify(now.budget ?? {})})`);
  if (Object.keys(set).length) console.log(`CAPS_SET ${l.key}: the next freshness sweep reads them; a cap reached tells the lead once, again only after the cap changes`);
  return;
};

const checkpointCommand: Command = async (context) => {
  const { lane, key, flags, config, need, evidence, many } = context;
  const target = await lane(key ?? die("checkpoint needs a lane key"));
  // parseArgs takes one value per flag; a second bare receipt would otherwise be dropped and its effect repeated later.
  const stray = flags.positionals.slice(1);
  if (stray.length) die(`checkpoint: unexpected argument ${stray[0]}; give each receipt its own --remote-effect`);
  const result = new Checkpoints(config.stateDir).write(target.key, {
    step: need("step"), result: need("result"), evidence: [evidence()], remoteEffects: many("remote-effect"),
  }, realClock.now());
  console.log(JSON.stringify(result));
  return;
};

const checkpointsCommand: Command = async (context) => {
  const { key, deps, config } = context;
  if (!key || !(await deps.registry.read(key))) die("checkpoints needs a registered lane key");
  console.log(JSON.stringify(new Checkpoints(config.stateDir).read(key ?? ""), null, 2));
  return;
};

export const laneStateCommands: Readonly<Record<string, Command>> = {
  "type": typeCommand,
  "claim-done": claimDoneCommand,
  "object-done": objectDoneCommand,
  "pause": pauseCommand,
  "resume": resumeCommand,
  "close": closeCommand,
  "caps": capsCommand,
  "checkpoint": checkpointCommand,
  "checkpoints": checkpointsCommand,
};
