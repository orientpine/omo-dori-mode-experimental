// A lane's task through its compactions (owner Q530, 2026-11-07: "추천 1 + 2: 위에 더해 레인 일찍 압축 실험(며칠 비교 후 결정)").
//
// 1. Re-anchor. The lane's first message carries its brief path, goal, Done line and the owner's words (launch.ts
//    briefAnchor), which omo's summary keeps word for word. A compaction whose summary still lost the brief path (omo's
//    deterministic fallback when the summary call fails: "Treat omitted transcript details as unknown", 3 of 5 lane
//    compactions in the week to 2026-11-07) gets one [LEAD] line typed into the lane with the same anchor.
// 2. The early-compaction trial (config compactionTrial, off by default). While it runs, every lane launched that the
//    exclude pattern does not match is put in an arm in turn (early, control, early, ...; arms.jsonl). For a lane in the
//    early arm, freshness types /compact at the lane's idle moment once its context reaches atK thousand tokens, instead of
//    omo's own point (about 80 % of the window). omo's settings stay untouched: the threshold has no per-session setting,
//    and a global one would move the lead too. dori compaction-trial prints the comparison table from the session logs.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { QUESTION_MARK } from "./aoe.ts";
import type { CompactionTrial, DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { briefAnchor } from "./launch.ts";
import { readScreen, sendVerified } from "./panes.ts";
import type { Lane } from "./registry.ts";
import { compactionScan, sessionFile } from "./rollover.ts";
import { sessionDirFor } from "./session-id.ts";
import { editorText, turnRunning } from "./submit.ts";
import { watchLog } from "./watch-log.ts";

export type TrialArm = "early" | "control";

export const trialActive = (t: CompactionTrial, now: number): boolean =>
  Boolean(t.until) && Date.parse(t.from || "1970-01-01T00:00:00Z") <= now && now < Date.parse(t.until);

const trialDir = (stateDir: string): string => join(stateDir, "compaction-trial");
export const armsFile = (stateDir: string): string => join(trialDir(stateDir), "arms.jsonl");
export type ArmRecord = { readonly at: string; readonly key: string; readonly arm: TrialArm | "excluded"; readonly tags: readonly string[] };

export const readArms = (stateDir: string): ArmRecord[] => {
  const file = armsFile(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ArmRecord);
};

// The arm of a lane launched now, recorded once (a key launched again keeps its first arm); undefined when no trial runs.
export const assignArm = (config: DoriConfig, key: string, tags: readonly string[], now: number): TrialArm | undefined => {
  const t = config.compactionTrial;
  if (!trialActive(t, now)) return undefined;
  const arms = readArms(config.stateDir);
  const had = arms.find((a) => a.key === key);
  if (had) return had.arm === "excluded" ? undefined : had.arm;
  const excluded = Boolean(t.exclude) && new RegExp(t.exclude, "i").test(`${key} ${tags.join(" ")}`);
  const early = arms.filter((a) => a.arm === "early").length;
  const control = arms.filter((a) => a.arm === "control").length;
  const arm: ArmRecord["arm"] = excluded ? "excluded" : early <= control ? "early" : "control";
  mkdirSync(trialDir(config.stateDir), { recursive: true });
  appendFileSync(armsFile(config.stateDir), `${JSON.stringify({ at: new Date(now).toISOString(), key, arm, tags } satisfies ArmRecord)}\n`);
  return arm === "excluded" ? undefined : arm;
};

// The log of session id for a lane in cwd: omo names the session dir after the cwd or, for a symlinked cwd, its real path
// (as goal.ts laneGoal reads it), and a handover opens the next session under the real path. An adopted lane's recorded
// cwd can differ from its session's directory, so the exact id is then looked for in every session directory (as
// supervision.ts laneSessionUsage does).
export const laneSessionFile = (sessionsDir: string, cwd: string, id: string): string | undefined => {
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  const near = [...new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])];
  for (const dir of near) {
    const file = sessionFile(dir, id);
    if (file) return file;
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(sessionsDir, d.name));
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (near.includes(dir)) continue;
    const file = sessionFile(dir, id);
    if (file) return file;
  }
  return undefined;
};

const laneLog = (config: DoriConfig, lane: Lane): string | undefined =>
  lane.session ? laneSessionFile(config.sessionsDir, lane.cwd ?? config.defaultCwd, lane.session) : undefined;

export type KeepAct = { readonly kind: "reanchored" | "reanchor-failed" | "trial-compact" | "trial-compact-failed"; readonly lane: string; readonly detail: string };

export const reanchorText = (lane: Lane, briefText: string): string =>
  `[LEAD] Your context was just compacted and the summary lost your task. Before your next step re-read the brief at ${lane.brief} and your notepad. ${briefAnchor(lane, briefText)}`;

// RETRY_MS: a /compact that did not bring a new compaction is typed again after this long at the next idle moment.
const RETRY_MS = 30 * 60_000;

// One sweep for one working lane: the re-anchor after a compaction that lost the brief, then the trial's early /compact.
export const keepTick = async (deps: FlowDeps, lane: Lane): Promise<KeepAct[]> => {
  const file = laneLog(deps.config, lane);
  if (!file || !lane.pane) return [];
  const scan = compactionScan(file);
  const acts: KeepAct[] = [];
  // the first sweep that reads a lane only takes its count: compactions before it are not re-anchored now. The count moves
  // on only once the lane was told (or the summary kept the brief), so a pane that took no text is tried on the next sweep;
  // a draft in its input box waits, since typing would send the draft with the text
  if (lane.compactionsSeen === undefined || scan.count < lane.compactionsSeen) {
    await deps.registry.patch(lane.key, { compactionsSeen: scan.count });
  } else if (scan.count > lane.compactionsSeen) {
    if ((scan.summary ?? "").includes(lane.brief)) {
      await deps.registry.patch(lane.key, { compactionsSeen: scan.count });
    } else if (!editorText(await readScreen(deps.run, deps.config.backend, lane.pane, 40))) {
      const text = reanchorText(lane, existsSync(lane.brief) ? readFileSync(lane.brief, "utf8") : "");
      const ok = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, text);
      if (ok) await deps.registry.patch(lane.key, { compactionsSeen: scan.count });
      const detail = `compaction ${scan.count} kept no brief path${ok ? "; the lane was told to re-read its brief" : `; the re-anchor did not reach pane ${lane.pane}, tried again next sweep`}`;
      watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `${ok ? "COMPACTION_REANCHOR" : "COMPACTION_REANCHOR_FAIL"} ${lane.key} ${detail}` });
      acts.push({ kind: ok ? "reanchored" : "reanchor-failed", lane: lane.key, detail });
    }
  }
  const trial = deps.config.compactionTrial;
  const now = deps.clock.now();
  if (lane.trialArm !== "early" || !trialActive(trial, now) || (scan.lastK ?? 0) < trial.atK) return acts;
  const last = lane.trialCompact;
  if (last && last.count === scan.count && now - last.at < RETRY_MS) return acts;
  // only at the idle moment: /compact while a turn runs would be queued as a message, omo's manual compaction stops the
  // running turn, and a draft in the input box would be sent with it
  const screen = await readScreen(deps.run, deps.config.backend, lane.pane, 40);
  if (turnRunning(screen) || QUESTION_MARK.test(screen) || editorText(screen)) return acts;
  const ok = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, "/compact");
  await deps.registry.patch(lane.key, { trialCompact: { count: scan.count, at: now } });
  const detail = `context ${scan.lastK}k >= ${trial.atK}k at an idle moment${ok ? "; /compact typed" : `; /compact did not reach pane ${lane.pane}`}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `${ok ? "TRIAL_COMPACT" : "TRIAL_COMPACT_FAIL"} ${lane.key} ${detail}` });
  acts.push({ kind: ok ? "trial-compact" : "trial-compact-failed", lane: lane.key, detail });
  return acts;
};

export type SessionUsage = { calls: number; ctxSum: number; over300: number; tokens: number; cost: number; compactions: number; fallbacks: number; rereads: number };

const emptyUsage = (): SessionUsage => ({ calls: 0, ctxSum: 0, over300: 0, tokens: 0, cost: 0, compactions: 0, fallbacks: 0, rereads: 0 });

// rereads: read tool calls, after a compaction, of a path the session had read before it (the re-exploration a summary
// that kept its context would spare).
export const sessionUsage = (text: string): SessionUsage => {
  const u = emptyUsage();
  const before = new Set<string>();
  const since = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; details?: { schema?: string }; message?: { role?: string; usage?: Record<string, unknown>; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "compaction") {
      u.compactions++;
      if (String(e.details?.schema ?? "").includes("fallback")) u.fallbacks++;
      for (const p of since) before.add(p);
      since.clear();
      continue;
    }
    const m = e.message;
    if (m?.role !== "assistant") continue;
    const us = m.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
    if (us) {
      const ctx = (us.input ?? 0) + (us.cacheRead ?? 0) + (us.cacheWrite ?? 0);
      if (ctx > 0) {
        u.calls++;
        u.ctxSum += ctx;
        if (ctx >= 300_000) u.over300++;
        u.tokens += ctx + (us.output ?? 0);
        u.cost += us.cost?.total ?? 0;
      }
    }
    if (Array.isArray(m.content))
      for (const c of m.content as { type?: string; name?: string; arguments?: { path?: unknown } }[]) {
        if (c.type !== "toolCall" || c.name !== "read" || typeof c.arguments?.path !== "string") continue;
        const p = c.arguments.path;
        if (u.compactions > 0 && before.has(p) && !since.has(p)) u.rereads++;
        since.add(p);
      }
  }
  return u;
};

// missing: sessions the registry names whose log was not found. complete: lanes whose every session log was found; the
// usage columns sum only those lanes and divide by complete, so a lane with an unknown part never reads as cheap.
export type ArmRow = { arm: TrialArm; lanes: number; closed: number; notDone: number; fixes: number; sessions: number; missing: number; complete: number } & SessionUsage;

export const trialRows = (config: DoriConfig, lanes: readonly Lane[], read: (file: string) => string = (f) => readFileSync(f, "utf8")): ArmRow[] => {
  const arms = readArms(config.stateDir);
  return (["early", "control"] as const).map((arm) => {
    const row: ArmRow = { arm, lanes: 0, closed: 0, notDone: 0, fixes: 0, sessions: 0, missing: 0, complete: 0, ...emptyUsage() };
    for (const rec of arms.filter((a) => a.arm === arm)) {
      const lane = lanes.find((l) => l.key === rec.key);
      if (!lane) continue;
      row.lanes++;
      if (lane.closedAt) row.closed++;
      row.notDone += (lane.history ?? []).filter((h) => h.status === "not-done").length;
      row.fixes += lane.fixes?.length ?? 0;
      const ids = [...(lane.priorSessions ?? []), ...(lane.session ? [lane.session] : [])];
      const files = ids.map((s) => laneSessionFile(config.sessionsDir, lane.cwd ?? config.defaultCwd, s));
      // a lane whose current session is not known (a handover that could not name it clears it) is incomplete as well
      const lost = files.filter((f) => !f).length + (lane.session ? 0 : 1);
      row.sessions += ids.length + (lane.session ? 0 : 1);
      row.missing += lost;
      if (lost) continue;
      row.complete++;
      for (const file of files as string[]) {
        const u = sessionUsage(read(file));
        for (const k of Object.keys(u) as (keyof SessionUsage)[]) row[k] += u[k];
      }
    }
    return row;
  });
};

const k = (n: number): string => (n >= 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const per = (n: number, d: number, f: (x: number) => string): string => (d > 0 ? f(n / d) : "-");

export const trialTable = (rows: readonly ArmRow[]): string[] => [
  "| arm | lanes (closed) | lanes with every log (sessions not found) | context per call | calls >= 300k | tokens per lane | usage $ per lane | compactions (fallback) | re-reads per compaction | lead not-done | fix attempts |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| ${r.arm} | ${r.lanes} (${r.closed}) | ${r.complete} (${r.missing}) | ${per(r.ctxSum, r.calls, k)} | ${per(r.over300 * 100, r.calls, (x) => `${x.toFixed(0)}%`)} | ${per(r.tokens, r.complete, k)} | ${per(r.cost, r.complete, (x) => x.toFixed(2))} | ${r.compactions} (${r.fallbacks}) | ${per(r.rereads, r.compactions, (x) => x.toFixed(1))} | ${r.notDone} | ${r.fixes} |`),
];

export const dailyFile = (stateDir: string): string => join(trialDir(stateDir), "daily.jsonl");

// One row per arm per day in daily.jsonl, written by the first sweep of each day (in the scorecard's time zone) while the
// trial runs and on the day it ended.
export const dailySnapshot = (config: DoriConfig, lanes: readonly Lane[], now: number): boolean => {
  const t = config.compactionTrial;
  if (!t.until || now < Date.parse(t.from || "1970-01-01T00:00:00Z") || now > Date.parse(t.until) + 86_400_000) return false;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.scorecard.timeZone || "UTC" }).format(new Date(now));
  const file = dailyFile(config.stateDir);
  if (existsSync(file) && readFileSync(file, "utf8").includes(`"day":"${day}"`)) return false;
  mkdirSync(trialDir(config.stateDir), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ day, at: new Date(now).toISOString(), rows: trialRows(config, lanes) })}\n`);
  return true;
};
