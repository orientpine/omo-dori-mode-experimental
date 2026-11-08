import { resolve } from "node:path";
import { currentTmuxSession } from "./aoe.ts";
import { sessionStart } from "./rollover.ts";
import { acquireSlot, releaseSlot } from "./heavy-slot.ts";
import { sampleHost } from "./host-guard.ts";
import { type AreaQuery, areaSignals, priorFixLines, tagsOf } from "./lane-signals.ts";
import { addNode, formatIntent, formatTree, gateFix, intentView, laneArea, loadTree, NODE_KINDS, type NodeKind, recordBranch, recordOverride, recordRefusal, requiredMessage, researchCheck, researchFacts, researchHint, sendResearch, setStatus, stuckView, type TreeArea, updateTree } from "./explore.ts";
import { checkReviewers, familyOf, reviewers, runChallenge } from "./challenge.ts";
import { mergePr, parsePr, reviewPr } from "./merge-gate.ts";
import { canonical, evidenceLines, inferredLine, inferRepeats, laneEvents, type MetricRepeat, suspects } from "./auto-signals.ts";
import { runIntentCheck, sendReread } from "./intent-check.ts";
import { branchesFrom, forkExplore, type Mode } from "./fork-explore.ts";
import { realClock, run } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { normFix, recordFix } from "./same-fix.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHeavyDeps } from "./cli-deps-heavy.ts";

const fixAttemptCommand: Command = async (context) => {
  const { lane, key, need, config, deps, flags, many, opt } = context;
  const l = await lane(key ?? die("fix-attempt needs a lane key"));
  const metric = normFix(need("metric"));
  // the name the stuck count uses (autoSignals.aliases), so PRIOR_FIX and the gate lines name what STUCK counts
  const shown = canonical(metric, config.autoSignals.aliases);
  const area: AreaQuery = { lane: l.key, ...(l.cwd && l.cwd !== config.defaultCwd ? { cwd: l.cwd } : {}), tags: tagsOf(l) };
  for (const line of priorFixLines(await areaSignals(await deps.registry.list(), area, config), l.key, metric, config.autoSignals.aliases)) console.log(line);
  const attempt = { at: new Date().toISOString(), metric, hypothesis: normFix(need("hypothesis")), via: "lead" as const, ...(flags.values.improved ? { improved: true } : {}) };
  const branch = { hypotheses: many("hypotheses"), tests: many("test"), override: opt("no-hypotheses") };
  const gate = gateFix(l, attempt, branch, config);
  if (gate.verdict === "required") {
    const msg = requiredMessage(l.key, shown, gate, config.explore);
    recordRefusal(deps, msg);
    die(msg, 5);
  }
  if (gate.verdict === "override") console.log(recordOverride(deps, l.key, shown, gate, branch.override ?? ""));
  if (gate.verdict === "branch") console.log(await recordBranch(deps, l, shown, branch, gate));
  const r = await recordFix(deps, l.key, attempt);
  const v = stuckView((await deps.registry.read(l.key)) ?? l, metric, config);
  console.log(`FIX_RECORDED ${l.key} attempt=${r.count} on-metric=${gate.attempt} stuck=${v.n} (tagged ${v.tagged}, inferred ${v.inferred})`);
  for (const n of r.notes) console.log(n);
  return;
};

const treeCommand: Command = async (context) => {
  const { key, deps, opt, config, tags, flags, need } = context;
  const verb = key ?? "show";
  const anyLane = async (k: string) => (await deps.registry.read(k)) ?? die(`no registered lane "${k}"`);
  const here = await currentTmuxSession(run).catch(() => "");
  const paneLane = here ? await deps.registry.byPane(here) : null;
  const laneKey = opt("lane");
  const area: TreeArea = laneKey ? laneArea(await anyLane(laneKey), config) : opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : tags()[0] ? { tag: tags()[0] } : paneLane ? laneArea(paneLane, config) : { cwd: resolve(process.cwd()) };
  const at = new Date().toISOString();
  const id = flags.positionals[1] ?? "";
  if (verb === "show") console.log(formatTree(await loadTree(config.stateDir, area)));
  else if (verb === "add") {
    const kind = (opt("kind") ?? "hypothesis") as NodeKind;
    if (!NODE_KINDS.includes(kind)) die(`--kind is one of ${NODE_KINDS.join(", ")}`);
    let added: { id: string; isNew: boolean } = { id: "", isNew: false };
    await updateTree(config.stateDir, area, (t) => {
      const r = addNode(t, { kind, text: need("text"), test: opt("test"), metric: opt("metric") ? normFix(opt("metric") ?? "") : undefined, lane: laneKey ?? paneLane?.key, source: "dori tree add", result: opt("result") }, at);
      added = { id: r.node.id, isNew: r.added };
      return r.tree;
    });
    console.log(`TREE_${added.isNew ? "ADDED" : "EXISTS"} ${added.id} in ${area.cwd ? `cwd ${area.cwd}` : `tag ${area.tag}`}`);
  } else if (verb === "falsify" || verb === "support" || verb === "close" || verb === "reopen") {
    if (!id) die(`usage: dori tree ${verb} <ID> [--result TEXT]`);
    const status = verb === "falsify" ? "falsified" : verb === "support" ? "supported" : verb === "close" ? "closed" : "open";
    let shown = "";
    await updateTree(config.stateDir, area, (t) => {
      const r = setStatus(t, id, status, opt("result"), at);
      shown = `${r.node.id} ${r.node.status}${r.node.result ? ` -> ${r.node.result}` : ""}`;
      return r.tree;
    });
    console.log(`TREE_SET ${shown}`);
  } else die("usage: dori tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T]");
  return;
};

const challengeCommand: Command = async (context) => {
  const { flags, key, lane, config, deps, need, opt } = context;
  if (flags.values.check) {
    const own = key ? ((await lane(key)).model ?? config.defaultModel) : undefined;
    const listed = own ? reviewers(own, config.reviewers.models, config.reviewers.allowSameFamily === true) : [...config.reviewers.models];
    const checks = await checkReviewers(deps, listed);
    for (const c of checks) console.log(c.call ? `REVIEWER_OK ${c.listed}${c.call !== c.listed ? ` -> ${c.call}` : ""} (${familyOf(c.listed)}): ${c.note}` : `REVIEWER_SKIP ${c.listed} (${familyOf(c.listed)}): ${c.note}`);
    if (!checks.some((c) => c.call)) die("no reviewer in reviewers.models can be called on this host");
    return;
  }
  const l = await lane(key ?? die("challenge needs a lane key"));
  const r = await runChallenge(deps, l, resolve(need("plan")), { model: opt("model"), all: Boolean(flags.values.all) });
  for (const f of r.failures) console.log(`CHALLENGE_SKIP ${f}`);
  for (const v of r.reviews) {
    console.log(v.text);
    console.log(`CHALLENGE_SAVED ${v.record.file} reviewer=${v.record.model}`);
  }
  return;
};

const reviewCommand: Command = async (context) => {
  const { key, flags, opt, lane, deps, many } = context;
  const pr = parsePr(key ?? die('usage: dori review <owner/repo#N> [--dir CHECKOUT] [--model M] [--lane K] [--no-test "<reason>"]'));
  const noTest = flags.values["no-test"] === undefined ? undefined : opt("no-test") || die('--no-test needs a reason: --no-test "<why this fix has no test>"');
  const laneKey = opt("lane");
  const here = laneKey ? "" : await currentTmuxSession(run).catch(() => "");
  const owner = laneKey ? await lane(laneKey) : here ? await deps.registry.byPane(here) : null;
  const out = await reviewPr(deps, pr, { dir: resolve(many("dir")[0] ?? process.cwd()), model: opt("model"), lane: owner, ...(noTest ? { noTest } : {}) });
  for (const line of out) console.log(line);
  if (/ verdict=BLOCK /.test(out.at(-1) ?? "")) process.exit(1);
  return;
};

const mergeCommand: Command = async (context) => {
  const { key, deps, flags } = context;
  const pr = parsePr(key ?? die("usage: dori merge <owner/repo#N> [--dry-run] [--delete-branch]"));
  console.log(await mergePr(deps, pr, { dryRun: Boolean(flags.values["dry-run"]), deleteBranch: Boolean(flags.values["delete-branch"]) }));
  return;
};

const forkExploreCommand: Command = async (context) => {
  const { lane, key, opt, config, many, flags, need, deps } = context;
  const { heavyDeps } = makeHeavyDeps(context);
  const l = await lane(key ?? die("fork-explore needs a lane key"));
  const mode = (opt("mode") ?? "agent") as Mode;
  if (mode !== "agent" && mode !== "cmd") die("--mode is agent or cmd");
  const minutes = Number(opt("minutes") ?? config.explore.branchMinutes);
  if (!(minutes > 0)) die("--minutes must be a positive number");
  const branches = branchesFrom(many("hypotheses"), many("test"), many("gpu").map(Number), Boolean(flags.values["gpu-all"]));
  const load = async () => (await sampleHost(run, config)).load1;
  const takeSlot = async (label: string) => {
    const slot = await acquireSlot(heavyDeps(load), label);
    return () => releaseSlot(slot);
  };
  console.log(`FORK_START ${l.key} ${branches.length} branches on "${need("metric")}" (${branches.filter((b) => b.gpu).length} gpu, queued on the heavy slot), ${minutes} min each, mode ${mode}`);
  const r = await forkExplore(deps, l, { metric: normFix(need("metric")), branches, mode, minutes, model: opt("model") }, takeSlot);
  console.log(r.table);
  console.log(`FORK_SAVED ${r.file}; tree updated (dori tree --lane ${l.key})`);
  return;
};

const researchHintCommand: Command = async (context) => {
  const { deps, key, config, flags } = context;
  const l = (await deps.registry.read(key ?? die("research-hint needs a lane key"))) ?? die(`no registered lane "${key}"`);
  const tree = await loadTree(config.stateDir, laneArea(l, config));
  for (const line of researchHint(l, tree)) console.log(line);
  if (flags.values.send) {
    if (!l.pane) die(`lane ${l.key} has no pane to send the ulw research text to`);
    const { metric } = researchFacts(l, tree);
    const delivered = await sendResearch(deps, l, tree, stuckView(l, metric, config).n, metric);
    const line = delivered ? `RESEARCH_SENT ${l.key}: ulw research text typed into pane ${l.pane}; dori research-check ${l.key} (or freshness) confirms the skill started` : `RESEARCH_SEND_FAILED ${l.key}: the text did not reach pane ${l.pane}`;
    watchLog(config.watchLog, realClock, { source: "research", line });
    console.log(line);
    if (!delivered) process.exit(1);
  }
  return;
};

const researchCheckCommand: Command = async (context) => {
  const { deps, key } = context;
  const l = (await deps.registry.read(key ?? die("research-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
  const r = await researchCheck(deps, l);
  console.log(r.line);
  if (r.verdict === "not-started") process.exit(6);
  return;
};

const intentCheckCommand: Command = async (context) => {
  const { lane, key, flags, deps, opt, config } = context;
  let l = await lane(key ?? die("intent-check needs a lane key"));
  if (flags.values.reread) {
    const sent = await sendReread(deps, l);
    console.log(sent.line);
    if (!sent.ok) process.exit(1);
    return;
  }
  const at = new Date().toISOString();
  const patch = {
    ...(opt("goal") ? { goal: opt("goal") } : {}),
    ...(opt("direction") || opt("next") ? { direction: { at, text: opt("direction") ?? l.direction?.text ?? "", ...(opt("next") ? { next: opt("next") } : {}) } } : {}),
  };
  if (Object.keys(patch).length) {
    await deps.registry.patch(l.key, patch);
    l = { ...l, ...patch };
  }
  for (const line of formatIntent(l, intentView(l, await loadTree(config.stateDir, laneArea(l, config))))) console.log(line);
  // the verdict: a reviewer of another family reads the direction just stated
  const r = await runIntentCheck(deps, l);
  if (r.skipped) {
    console.log(r.skipped);
    if (r.skipped.startsWith("INTENT_CHECK_FAILED")) process.exit(1);
    return;
  }
  for (const line of r.lines) console.log(line);
  return;
};

const repeatCheckCommand: Command = async (context) => {
  const { deps, key, opt, many, config, flags } = context;
  const l = (await deps.registry.read(key ?? die("repeat-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
  const ago = /^(\d+(?:\.\d+)?)([dh])$/.exec(opt("since") ?? "");
  const since = ago ? new Date(Date.now() - Number(ago[1]) * (ago[2] === "d" ? 86_400_000 : 3_600_000)).toISOString() : (opt("since") ?? sessionStart(l));
  if (Number.isNaN(Date.parse(since))) die(`--since takes an ISO time or Nd / Nh, not ${opt("since")}`);
  const scan = await laneEvents(deps, l, { since, ...(opt("until") ? { until: opt("until") } : {}), repos: many("repo") });
  const cfg = config.autoSignals;
  const after = config.stuck.researchAt;
  console.log(`REPEAT_SCAN ${l.key} since ${since}${opt("until") ? ` until ${opt("until")}` : ""}: ${scan.reports} reports, ${scan.commits} commits, ${scan.tree} tree entries; scope ${cfg.targetScope}, aliases ${Object.keys(cfg.aliases).length}, after ${after} (stuck.researchAt)`);
  const tagged = (metric: string): number => stuckView(l, metric, config).tagged;
  if (flags.values.backtest) {
    // each time a metric's inferred count reached stuck.researchAt or grew past it, report by report
    const fired: { at: string; r: MetricRepeat }[] = [];
    inferRepeats(scan.events, cfg, (r, e) => r.n >= after && fired.push({ at: e.at, r }));
    for (const f of fired) {
      console.log(`${f.at} ${inferredLine(l.key, f.r, tagged(f.r.metric))}`);
      for (const line of evidenceLines(f.r).slice(-4)) console.log(line);
    }
    console.log(`REPEAT_BACKTEST ${l.key} ${fired.length} alerts on ${new Set(fired.map((f) => f.r.metric)).size} metrics`);
    return;
  }
  const state = inferRepeats(scan.events, cfg);
  const hits = suspects(state, after);
  for (const r of hits) {
    console.log(inferredLine(l.key, r, tagged(r.metric)));
    for (const line of evidenceLines(r)) console.log(line);
  }
  if (!hits.length) console.log(`REPEAT_NONE ${l.key} no metric re-targeted ${after}+ times after failing (counts: ${[...state.counts.values()].map((r) => `${r.metric} ${r.n}`).join(", ") || "none"})`);
  return;
};

export const reviewCommands: Readonly<Record<string, Command>> = {
  "fix-attempt": fixAttemptCommand,
  "tree": treeCommand,
  "challenge": challengeCommand,
  "review": reviewCommand,
  "merge": mergeCommand,
  "fork-explore": forkExploreCommand,
  "research-hint": researchHintCommand,
  "research-check": researchCheckCommand,
  "intent-check": intentCheckCommand,
  "repeat-check": repeatCheckCommand,
};
