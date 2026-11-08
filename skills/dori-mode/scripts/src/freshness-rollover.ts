import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { omoSession, readScreen, sendVerified } from "./panes.ts";
import { leadAlert } from "./autoturn.ts";
import { compactionStuckOn, type ReadyMark, readyFile, safePointText, statusLine } from "./lane-handover.ts";
import { COMMITTED, crossed, dueReasons, limitsFor, readRollovers, type RolloverEntry, type Signals, type Who } from "./rollover.ts";
import type { RolloverDue } from "./registry.ts";
import { handoverRunning, pidAlive, readJson, type RolloverHooks, type SweepAct } from "./freshness-handover.ts";

type Attempt = Extract<RolloverEntry, { kind: "rollover" }>;

// The record of the automatic run started at autoAt: the last automatic rollover entry of this lane (or the lead) since.
const lastAuto = (stateDir: string, who: Who, key: string, since: string): Attempt | undefined =>
  readRollovers(stateDir).findLast((e): e is Attempt => e.kind === "rollover" && e.who === who && e.key === key && (e.approvedBy ?? "").startsWith("auto:") && e.at >= since);

export const screenSignals = (deps: FlowDeps): RolloverHooks => ({
  signals: async (pane, model) => {
    const screen = await readScreen(deps.run, deps.config.backend, pane, 40);
    const blockedTurns = compactionStuckOn(screen);
    return { contextPct: statusLine(screen, model).contextPct, ...(blockedTurns ? { compactionStuck: blockedTurns } : {}) };
  },
});

// A lead whose compaction did not complete reads nothing freshness types into it, and its ROLLOVER_DUE line lands in a log
// only that lead reads: when nothing moves it (the auto key is off, or the automatic handover was refused or failed: a
// misnamed handover.watchers entry refuses every run), the pair channel hears of it once per lead pane (postLeadAlert).
const leadStuckFile = (stateDir: string): string => join(stateDir, "handover", "lead-compaction-stuck.json");
export const leadStuckAlert = async (deps: FlowDeps, hooks: RolloverHooks, pane: string, model: string, due: RolloverDue | undefined): Promise<SweepAct[]> => {
  const n = (await hooks.signals(pane, model).catch((): Signals => ({}))).compactionStuck ?? 0;
  const file = leadStuckFile(deps.config.stateDir);
  if (!n || readJson<{ pane?: string }>(file)?.pane === pane) return [];
  const last = due?.pane === pane && due.autoAt ? lastAuto(deps.config.stateDir, "lead", "lead", due.autoAt) : undefined;
  const why = !deps.config.handover.autoRolloverLead
    ? "the automatic lead rollover is off (handover.autoRolloverLead)"
    : last && last.result !== COMMITTED
      ? `the automatic handover ended ${last.result}${last.reasons[0] ? `: ${last.reasons[0].slice(0, 240)}` : ""}`
      : "";
  if (!why) return [];
  const since = due?.pane === pane ? due.at : new Date(deps.clock.now()).toISOString();
  const lines = await leadAlert(deps, { head: "LEAD_COMPACTION_STUCK", pane, turns: n, template: deps.config.discord.leadCompactionStuckText, since, reason: why });
  if (lines.some((l) => l.startsWith("LEAD_ALERT_POSTED "))) {
    mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ pane, at: new Date(deps.clock.now()).toISOString() })}\n`);
  }
  return [{ kind: "lead_compaction_stuck", lane: "lead", detail: `${pane} answers with "compaction did not complete" (${n}x on its screen) and was not moved: ${why}; ${lines.join("; ") || "no pair or owner channel to alert (postLeadAlert unset)"}` }];
};

export const leadDueFile = (stateDir: string): string => join(stateDir, "handover", "lead-due.json");

// A session past a measured threshold (context, compactions, age) is due for a rollover. Freshness says so once per pane
// and only suggests: the lead decides and runs the handover with --approved-by lead:<reason and signal>, unless the owner
// turned the auto key on. A stuck lane's rollover point is rung 4 of the stuck ladder, which has its own STUCK line.
// With the auto key on, rung 4 of the stuck ladder is a reason too, and a session still in the same pane is started again
// from what the last automatic run left in the rollover log, never on a fixed clock and never given up: a lane that stayed
// busy is asked to reach a safe point and started again at once (the run waits for its idle moment); a lane whose chain or
// eval cell would die, or whose background tasks still run, is asked, and started again when it marks ready, when those
// chains and tasks ended, or after autoRetryMin (tasks still running refuse every start; the lead hears of it once); a
// move that failed is started again after autoRetryMin, doubling while failures go on (up to 8 times). Only a training or
// eval chain stops it: the lead moves that lane (the owner's rule). A refusal goes to the watch log only
// (HANDOVER_REFUSED); the owner hears of a move that happened.
export const rolloverDue = async (deps: FlowDeps, hooks: RolloverHooks, who: Who, key: string, pane: string, model: string, seen: RolloverDue | undefined, stuck: Signals["stuck"], save: (due: RolloverDue) => Promise<void>): Promise<SweepAct[]> => {
  const h = deps.config.handover;
  if (!omoSession(deps.config)) return [];
  const auto = (who === "lane" ? h.autoRolloverLanes : h.autoRolloverLead) ? hooks.auto : undefined;
  const limits = limitsFor(who, h);
  const reasons = async (): Promise<string[]> => {
    const signals: Signals = await hooks.signals(pane, model).catch(() => ({}));
    return auto ? dueReasons({ ...signals, ...(stuck ? { stuck } : {}) }, limits) : crossed(signals, limits);
  };
  const now = deps.clock.now();
  const at = new Date(now).toISOString();
  if (seen?.pane === pane) {
    if (!auto || seen.leftToLead) return [];
    // due while the key was off (only the ROLLOVER_DUE line so far): the first automatic start, now that it is on
    if (!seen.autoAt) {
      const hit = await reasons();
      if (!hit.length) return [];
      await save({ ...seen, autoAt: at, tries: 1 });
      return [{ kind: "rollover_auto", lane: key, detail: `${hit.join(", ")}: ${await auto(who, key)}` }];
    }
    const alive = hooks.alive ?? pidAlive;
    const stateDir = deps.config.stateDir;
    if (handoverRunning(stateDir, who, key, alive)) return [];
    const retryMs = h.autoRetryMin * 60_000;
    const last = lastAuto(stateDir, who, key, seen.autoAt);
    const acts: SweepAct[] = [];
    let failures = 0;
    if (!last) {
      // started but nothing logged yet (still starting) or the run died before it logged: start again after autoRetryMin
      if (now - Date.parse(seen.autoAt) < retryMs) return [];
    } else if (last.result === "refused" && (last.blocked === "work" || last.blocked === "busy")) {
      // the lane was busy: ask it once per autoRetryMin to reach a safe point, then start again when it can move
      if (who === "lane" && (!seen.askedAt || now - Date.parse(seen.askedAt) >= retryMs)) {
        const why = (last.reasons[0] ?? "").replace(/\. Ask the lane to reach a safe point.*$/, "");
        const told = await sendVerified(deps.run, deps.clock, deps.config, pane, safePointText(key, why, "auto"));
        seen = { ...seen, askedAt: at };
        await save(seen);
        acts.push({ kind: "rollover_auto", lane: key, detail: `asked ${pane} to reach a safe point and write its summary (${why})${told ? "" : `; the request did not reach pane ${pane}`}` });
      }
      if (last.blocked === "work") {
        const mark = readJson<ReadyMark>(readyFile(stateDir, key));
        const readied = mark?.pane === pane && mark.at > last.at;
        const pids = last.pids ?? [];
        const tasks = last.tasks ?? [];
        const taskEnded = hooks.taskEnded ?? (() => false);
        // the old session's tasks still run after a start that came back (its ready mark covers none): the move waits for
        // them, and the lead hears of it once in this pane, with what it can do
        const running = tasks.filter((id) => !taskEnded(id));
        if (who === "lane" && running.length && (seen.tries ?? 1) >= 2 && !seen.tasksToldAt) {
          const lead = deps.config.leadPane;
          const text = `[DORI] ${key}: the automatic rollover is held: background task(s) ${running.join(", ")} of the old session still run, and a move would leave them editing the lane's files out of the new session's reach. It moves by itself once they end. To move it sooner, ask the lane to let them finish or end them, or run dori handover --lane ${key} --approved-by "lead:<reason and signal>" --force (their answers then go to the old session).`;
          const told = lead ? await sendVerified(deps.run, deps.clock, deps.config, lead, text) : false;
          seen = { ...seen, tasksToldAt: at };
          await save(seen);
          acts.push({ kind: "rollover_auto", lane: key, detail: `held by the old session's background tasks ${running.join(", ")}; ${!lead ? "lead not told: leadPane is not configured" : told ? "lead told" : `lead not told: the note did not reach pane ${lead}`}` });
        }
        const ended = pids.length + tasks.length > 0 && pids.every((pid) => !alive(pid)) && !running.length;
        if (!readied && !ended && now - Date.parse(last.at) < retryMs) return acts;
      }
    } else if (last.result === "refused" && last.blocked === "training") {
      return [];
    } else {
      // the move failed or rolled back, or the run was refused for another reason: back off, doubling up to 8 times
      failures = (seen.failures ?? 0) + 1;
      if (now - Date.parse(last.at) < retryMs * 2 ** Math.min(3, failures - 1)) return [];
    }
    const hit = await reasons();
    if (!hit.length) return acts;
    const tries = (seen.tries ?? 1) + 1;
    await save({ ...seen, autoAt: at, tries, failures });
    return [...acts, { kind: "rollover_auto", lane: key, detail: `start ${tries} (${hit.join(", ")}${last ? `; last: ${last.result}${last.blocked ? ` ${last.blocked}` : ""}` : ""}): ${await auto(who, key)}` }];
  }
  const hit = await reasons();
  if (!hit.length) return [];
  await save({ pane, at, crossed: hit, ...(auto ? { autoAt: at, tries: 1 } : {}) });
  const run = who === "lane" ? `dori handover --lane ${key} --approved-by "lead:<reason and this signal>"` : `dori handover --approved-by "lead:<reason and this signal>"`;
  const acts: SweepAct[] = [{ kind: "rollover_due", lane: key, detail: `${hit.join(", ")} in ${pane}: decide it (dori rollover-propose ${key} shows the note); to go ahead, ${who === "lane" ? `once the lane is at a safe point (dori handover ready ${key}), ` : ""}run ${run}; the owner is told afterwards` }];
  if (auto) acts.push({ kind: "rollover_auto", lane: key, detail: await auto(who, key) });
  return acts;
};

// The line freshness prints when it starts: whether rollovers start by themselves, on what, and how often they are retried.
export const autoReadyLine = (h: DoriConfig["handover"]): string => {
  const side = (who: Who, on: boolean): string => {
    const name = who === "lane" ? "lanes" : "lead";
    if (!on) return `${name} off`;
    const l = limitsFor(who, h);
    const what = [l.contextPct > 0 ? `context >= ${l.contextPct}%` : "", l.compactions > 0 ? `compactions >= ${l.compactions}` : "", (l.afterCompactK ?? 0) > 0 ? `context after compaction >= ${l.afterCompactK}k` : "", l.ageH > 0 ? `age >= ${l.ageH} h` : "", who === "lane" ? "stuck rung 4" : ""].filter(Boolean);
    return `${name} on (${what.join(", ") || "no threshold set"})`;
  };
  const sides = `${side("lane", h.autoRolloverLanes)}, ${side("lead", h.autoRolloverLead)}`;
  return h.autoRolloverLanes || h.autoRolloverLead
    ? `ROLLOVER_AUTO_READY ${sides}; a lane moves at its idle moment (waits up to ${h.autoWaitMin} min), a busy lane is asked for a safe point first, a failed move is retried after ${h.autoRetryMin} min (doubling), with no last try; the owner is told after each move`
    : `ROLLOVER_AUTO_OFF ${sides}; rollovers wait for the lead's decision`;
};
