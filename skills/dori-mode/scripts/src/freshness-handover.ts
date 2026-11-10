import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "./done-flow.ts";
import type { KeepAct } from "./compaction-keep.ts";
import { pendingFile, type ReadyMark, readyFile, safePointFile, safePointText, waitingRequest } from "./lane-handover.ts";
import { sendVerified } from "./panes.ts";
import { readRollovers, type RolloverRequest, type Signals, type Who } from "./rollover.ts";
import type { Committed } from "./rollover-audit.ts";
import { watchLog } from "./watch-log.ts";

export type SweepAct = { readonly kind: "nudged" | "nudge-failed" | "lead-told" | "lead-tell-failed" | "no-report" | "journal-error" | "stuck" | "research_started" | "research_not_started" | "rollover_due" | "rollover_auto" | "rollover_audit" | "audit_summary" | "lead_compaction_stuck" | "directive_audit" | "directive_links" | "lane_cap" | "stalled" | "usage_unknown" | "supervision_error" | "ready_resume" | KeepAct["kind"] | "trial_daily"; readonly lane: string; readonly detail: string };

export type RolloverHooks = {
  // the length signals of the session in a pane: context use, compactions, age
  readonly signals: (pane: string, model: string) => Promise<Signals>;
  // starts a rollover without asking (handover.autoRolloverLanes / autoRolloverLead on); the line says what it started
  readonly auto?: (who: Who, key: string) => Promise<string>;
  // starts again, detached, a lane handover the lead (or the owner) approved that was refused while the lane was busy,
  // with the same approval and the options that run was given, once the lane marked ready (readyResume); started false
  // when it could not be started
  readonly resume?: (key: string, approvedBy: string, request: RolloverRequest, serves: { readonly at: string; readonly pane: string }) => Promise<{ readonly started: boolean; readonly line: string }>;
  // whether a process still runs (a handover's lock holder, the chain pids a refusal named); process.kill(pid, 0) by default
  readonly alive?: (pid: number) => boolean;
  // whether a background task (st_...) a refusal named has ended: its senpi record under home has a final status (a task
  // without a record has not ended)
  readonly taskEnded?: (id: string) => boolean;
  // starts the audit of a committed handover (dori handover audit, detached); the line says what it started
  readonly audit?: (c: Committed) => Promise<string>;
  // puts the week's audit summary in the lead's inbox; the line says what it wrote
  readonly auditSummary?: (week: string) => string;
  // the daily directive audit (dori directive-audit from `since`), so it runs on every Dori with no timer of its own
  readonly directiveAudit?: ((since: string) => Promise<readonly string[]>) | undefined;
  // pushes the owner's message links of the local ledger to the other Dori (directives.linkPeers)
  readonly directiveLinks?: () => Promise<readonly string[]>;
  // the lead's omo transcript, where each report a lane typed into the lead sits (read first, before the screens);
  // undefined when there is none (backend herdr, no leadPane, no session file)
  readonly leadTranscript?: () => Promise<string | undefined>;
};

// A zombie (it ended, its parent has not collected it: an eval kernel's Popen child) answers kill 0 but runs nothing: a
// waiting handover whose chain ended as one never started again (QA lane qa-hsa, 2026-11-03 13:28Z).
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
};

export const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

// A handover of this lane (or of the lead) runs now: its lock or its journal names a live process.
export const handoverRunning = (stateDir: string, who: Who, key: string, alive: (pid: number) => boolean): boolean =>
  (who === "lane" ? [join(stateDir, "handover", "lanes", `${key}.lock`), pendingFile(stateDir, key)] : [join(stateDir, "handover", "lock")]).some((f) => {
    const pid = readJson<{ pid?: number }>(f)?.pid;
    return typeof pid === "number" && pid !== process.pid && alive(pid);
  });

// A lead's handover of a busy lane is refused (HANDOVER_REFUSED, blocked work or busy) and the lane is asked to mark a
// safe point with dori handover ready; that mark alone moved nothing until someone ran the handover again by hand (the
// lane tournament-public marked ready at 05:57Z on 2026-11-03 and waited until a hand-run at 06:12Z). So the first sweep
// that sees a mark written after such a refused request, in the same pane, starts that request again with the same
// approval, detached and waiting for the lane's idle moment; a mark with no refused request before it starts nothing.
// One start per mark: the mark's time is claimed in <key>.ready-resume.json before the start (a start that could not be
// launched gives the claim back). A mark older than handover.readyMin starts nothing either: the lead hears of it once.
// the dori handover --lane options that give a run started again what the refused run was given
export const resumeArgs = (r: RolloverRequest): string[] => [...(r.note ? ["--note", r.note] : []), ...(r.model ? ["--model", r.model] : []), ...(r.thinking ? ["--thinking", r.thinking] : []), ...(r.keepOld ? ["--keep-old"] : []), ...(r.verifyMin ? ["--minutes", String(r.verifyMin)] : [])];
const resumeFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.ready-resume.json`);
// The one waiting handover of a lane (Q475): the lead's request refused busy or work is started again by itself, once per
// refusal (the claim names the refusal), never given up: refused while a turn ran, at the next sweep (the started run waits
// for the idle moment); refused for work, when the lane marks ready after it or every chain and task it named ended. A
// request still waiting handover.readyMin after it was first asked is told to the lead once, and goes on waiting.
const STARTED_GRACE_MS = 2 * 60_000;

export const readyResume = async (deps: FlowDeps, hooks: RolloverHooks, key: string, pane: string): Promise<SweepAct[]> => {
  if (!hooks.resume) return [];
  const stateDir = deps.config.stateDir;
  const asked = waitingRequest(readRollovers(stateDir), key, pane);
  if (!asked) return [];
  // the safe-point ask the pane did not take (a herdr question open, a pane gone for a moment) is typed again each sweep
  // until it is, once per request: without it the lane never learns it should mark ready (review 320 round 8)
  const askFile = safePointFile(stateDir, key);
  if (asked.safePoint && !asked.safePoint.told && readJson<{ request?: string }>(askFile)?.request !== asked.at && !handoverRunning(stateDir, "lane", key, hooks.alive ?? pidAlive)) {
    // a text the pane refuses outright (an unsafe character) is a failed delivery, tried again next sweep, never a throw that
    // ends the sweep for every lane after this one (review 320 round 9)
    if (await sendVerified(deps.run, deps.clock, deps.config, pane, safePointText(key, asked.safePoint.why, "lead")).catch(() => false)) {
      mkdirSync(join(stateDir, "handover", "lanes"), { recursive: true });
      writeFileSync(askFile, `${JSON.stringify({ request: asked.at, at: new Date(deps.clock.now()).toISOString() })}\n`);
      watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `HANDOVER_SAFE_POINT_ASKED ${key} asked: the safe-point request of the handover asked at ${asked.at} reached ${pane} now` });
    }
  }
  const claimed = resumeFile(stateDir, key);
  const claim = readJson<{ request?: string; since?: string; approvedBy?: string; result?: string; toldAt?: string; readyAt?: string; at?: string }>(claimed);
  const by = (asked.approvedBy ?? "").trim();
  // the first ask of this waiting request: a run started again for it and refused again carries it on (its row names the
  // request it was started for); a new request with the same approval starts its own wait (review 320 round 15)
  const since = claim?.since && asked.resumes && claim.request === asked.resumes ? claim.since : claim?.request === asked.at && claim.since ? claim.since : asked.at;
  // a refusal started once (or skipped for good) is done; one still waiting, or skipped for a stale ready mark, is looked at
  // again: a fresh mark or its work ending still starts it (review 320)
  // a started run that died before it wrote another row (no live run holds the lane, checked below) is started again once
  // its startup grace has passed, with no new event needed: the request stays decided (review 320, plan challenge 14:48Z)
  const abandoned = claim?.result === "started" && deps.clock.now() - Date.parse(claim.at ?? "") > STARTED_GRACE_MS;
  if (claim?.request === asked.at && claim.result !== "waiting" && claim.result !== "stale-mark" && claim.result !== "launch-failed" && !abandoned) return [];
  const alive = hooks.alive ?? pidAlive;
  if (handoverRunning(stateDir, "lane", key, alive)) return [];
  const now = deps.clock.now();
  const min = deps.config.handover.readyMin;
  const mark = readJson<ReadyMark>(readyFile(stateDir, key));
  const markAt = Date.parse(mark?.at ?? "");
  const readied = !!mark && !Number.isNaN(markAt) && mark.pane === pane && markAt > Date.parse(asked.at);
  const taskEnded = hooks.taskEnded ?? (() => false);
  const named = [...(asked.pids ?? []), ...(asked.tasks ?? [])];
  const ended = named.length > 0 && (asked.pids ?? []).every((pid) => !alive(pid)) && (asked.tasks ?? []).every((id) => taskEnded(id));
  const log = (line: string): SweepAct[] => {
    watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line });
    return [{ kind: "ready_resume", lane: key, detail: line.slice(line.indexOf(" ", line.indexOf(" ") + 1) + 1) }];
  };
  mkdirSync(join(stateDir, "handover", "lanes"), { recursive: true });
  if (asked.blocked === "work" && !readied && !ended) {
    if (now - Date.parse(since) <= min * 60_000 || (claim?.request === asked.at && claim.toldAt)) return [];
    const lead = deps.config.leadPane;
    const text = `[DORI] ${key}: the handover you asked for at ${since} still waits: the lane has not marked ready and the work it named still runs (${named.join(", ")}). It starts by itself once either happens; to move it now, run dori handover --lane ${key} --approved-by "<the same approval>" --force (that work then ends).`;
    const told = lead ? await sendVerified(deps.run, deps.clock, deps.config, lead, text) : false;
    writeFileSync(claimed, `${JSON.stringify({ request: asked.at, since, approvedBy: by, result: "waiting", ...(told || !lead ? { toldAt: new Date(now).toISOString() } : {}) })}\n`);
    return log(`HANDOVER_PENDING_STALE ${key} waiting: the request of ${since} (refused ${asked.blocked}) still waits after ${min} min; ${!lead ? "lead not told: leadPane is not configured" : told ? "lead told" : `lead not told: the note did not reach pane ${lead}`}`);
  }
  // a refusal logged before its options were kept (no request) is not started again: it could drop --keep-old and close
  // the old session; the lead runs it again. A ready mark past readyMin is ignored by the run, so it starts nothing.
  const stale = asked.blocked === "work" && readied && !ended && now - markAt > min * 60_000;
  const why = !asked.request ? "the request was logged before its options were kept, so a start now could drop them (--keep-old, --note, --model)" : stale ? `the ready mark is older than ${min} min` : "";
  // the lead hears of one stale mark once
  if (stale && claim?.request === asked.at && claim.result === "stale-mark" && claim.readyAt === mark?.at) return [];
  writeFileSync(claimed, `${JSON.stringify({ request: asked.at, since, approvedBy: by, at: new Date(now).toISOString(), ...(readied ? { readyAt: mark?.at } : {}), ...(claim?.toldAt && claim.since === since ? { toldAt: claim.toldAt } : {}), result: stale ? "stale-mark" : why ? "skipped" : "started" })}\n`);
  const cause = asked.blocked === "busy" ? "the lane was busy; the run waits for its idle moment" : readied ? `the ready mark of ${mark?.at} in ${pane} follows it` : `the work it named ended (${named.join(", ")})`;
  if (why) {
    const lead = deps.config.leadPane;
    const text = asked.request
      ? `[DORI] ${key}: the handover you asked for at ${asked.at} was not started again: the lane marked ready at ${mark?.at}, more than handover.readyMin (${min} min) ago. Ask the lane to run dori handover ready ${key} --note <file> again (the handover then starts by itself), or run it again yourself.`
      : `[DORI] ${key}: the handover you asked for at ${asked.at} was refused (${asked.blocked}), but that request was logged before its options were kept, so it was not started again. Run dori handover --lane ${key} again with the same approval and options now.`;
    const told = lead ? await sendVerified(deps.run, deps.clock, deps.config, lead, text) : false;
    return log(`HANDOVER_READY_RESUME_SKIPPED ${key} skipped: ${readied ? `the ready mark of ${mark?.at} in ${pane} follows the request of ${asked.at}` : `the request of ${asked.at}`} (refused ${asked.blocked}), not started again: ${why}; ${!lead ? "lead not told: leadPane is not configured" : told ? "lead told" : `lead not told: the note did not reach pane ${lead}`}`);
  }
  // a request still waiting readyMin after it was first asked is told to the lead once, a busy one too (review 320)
  const toldAt = claim?.toldAt && (claim.request === asked.at || claim.since === since) ? claim.toldAt : undefined;
  if (!toldAt && now - Date.parse(since) > min * 60_000) {
    const lead = deps.config.leadPane;
    const told = lead ? await sendVerified(deps.run, deps.clock, deps.config, lead, `[DORI] ${key}: the handover you asked for at ${since} still waits: the lane stayed busy (${asked.blocked}). It goes on starting by itself at the lane's idle moment; to move it now, run dori handover --lane ${key} --approved-by "<the same approval>" --force.`) : false;
    watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `HANDOVER_PENDING_STALE ${key} waiting: the request of ${since} (refused ${asked.blocked}) still waits after ${min} min; ${!lead ? "lead not told: leadPane is not configured" : told ? "lead told" : "lead not told"}` });
    // kept only once the lead got it (or there is no lead to tell): a note that did not arrive goes again next sweep
    if (told || !lead) writeFileSync(claimed, `${JSON.stringify({ ...readJson<object>(claimed), toldAt: new Date(now).toISOString() })}\n`);
  }
  // the run checks under the lane's lock that this request still waits in this pane (review 320 round 14)
  const r = await hooks.resume(key, by, asked.request ?? {}, { at: asked.at, pane });
  // the claim is given back for the next sweep; a stale note already delivered stays delivered (review 320)
  // it keeps the request it was for, so the wait keeps its age and its told note (review 320 round 16)
  if (!r.started) writeFileSync(claimed, `${JSON.stringify({ request: asked.at, since, approvedBy: by, result: "launch-failed", ...(readJson<{ toldAt?: string }>(claimed)?.toldAt ? { toldAt: readJson<{ toldAt?: string }>(claimed)?.toldAt } : {}) })}\n`);
  return log(r.started
    ? `HANDOVER_READY_RESUMED ${key} started: ${readied ? `the ready mark of ${mark?.at} in ${pane} follows the request of ${asked.at}` : `${cause}; the request of ${asked.at}`} (refused ${asked.blocked}); started again with the same approval ${JSON.stringify(by)}: ${r.line}`
    : `HANDOVER_READY_RESUME_FAILED ${key} failed: the request of ${asked.at} could not be started again (${r.line}); the next sweep tries again`);
};
