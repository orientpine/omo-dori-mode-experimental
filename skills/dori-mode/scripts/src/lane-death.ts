import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { paneLife, tmuxPanePid } from "./aoe.ts";
import { pidAlive } from "./background.ts";
import { handoverRunning } from "./freshness.ts";
import { frozenPanes } from "./frozen.ts";
import { herdrAgentPid, isHerdrPane } from "./herdr.ts";
import { type Hold, holdOf, jobSignal, readStat, resumeAgent, type StatOf } from "./job-control.ts";
import { procTable, topAgent } from "./session-id.ts";
import type { FlowDeps } from "./done-flow.ts";
import { submitToPane } from "./panes.ts";
import type { Submitted } from "./submit.ts";
import { type LaneDied, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";

// 2026-10-30 02:33 UTC: a lane's omo died with its OOM-killed job (systemd stopped its aoe-session scope; the pane stayed
// dead with status 143). dead-panes read only screen words every 5 minutes and printed nothing; the lead heard of it about
// three hours later, from the owner. dori watch (every 30 s) now checks each open lane's pane:
// - LANE_DIED <key> <pane>: <why> once its tmux session is gone or its pane is dead on two checks CONFIRM_MS apart (a
//   handover or close that swaps the pane is seen live again or out of the registry by then);
// - the lead pane gets one line "[DORI] 레인 <key> 꺼짐(<이유>) — 이어서 살릴지 정해", typed once (LANE_DIED_TOLD, or
//   LANE_DIED_NOT_TOLD when the submit check could not see it taken: no retry, so the lead never gets it twice; the
//   LANE_DIED line stays in the watch log); never the owner (the lead decides);
// - the reason is 메모리 부족 when this user's journal shows an oom-kill for the lane's aoe-session scope (the lane user can
//   read its own journal, not the kernel log), else the pane's exit status or the gone session.
// A lane whose pane is live again (revived) loses its mark, so a second death is told again.

const CONFIRM_MS = 25_000;
const JOURNAL_BACK_MS = 30 * 60_000;

// first check that found each pane not live, for the second check (in memory: a restart of the watch only delays it a tick)
const notLive = new Map<string, number>();

// the journal line that says the lane's aoe-session scope (aoe-session-<first 8 of the aoe id>...) met the OOM killer
export const oomLine = async (run: Runner, pane: string, sinceMs: number): Promise<string | undefined> => {
  const id = /_([0-9a-f]{8})$/.exec(pane)?.[1];
  if (!id) return undefined;
  const r = await run(["journalctl", "--user", "--since", `@${Math.floor(sinceMs / 1000)}`, "--no-pager", "-o", "cat", "-g", `aoe-session-${id}`], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  return r.out.split("\n").find((l) => /oom-kill|killed by the OOM killer/i.test(l))?.trim().slice(0, 200);
};

export const laneDiedText = (key: string, reason: string): string => `[DORI] 레인 ${key} 꺼짐(${reason}) — 이어서 살릴지 정해`;

// 2026-11-03 15:41Z a rolled-back handover thawed handover-simplify's omo into a background job of its shell, where the
// next key stopped it again (T). Its screen kept its last "esc to interrupt", so every check reading screens took it for
// busy for 18 hours (freshness refused 54 rollovers) and nobody was told. dori watch now also reads the process of each
// open lane's agent and of the lead's:
// - LANE_SUSPENDED <key> <pane>: agent <pid> stopped|background, once seen so on two checks CONFIRM_MS apart; a pane a
//   handover froze on purpose (a frozen record, or a handover of that lane or of the lead running) is left alone;
// - it is brought back at once (job-control.ts resumeAgent: continued, or fg typed into its shell), and the lead gets one
//   line saying whether that worked (LANE_SUSPENDED_TOLD / _NOT_TOLD). A line refused before anything was typed is kept in
//   <state>/suspended/notices and sent again on later ticks until the lead takes it; one typed but not seen taken may still
//   arrive, so it is not sent again (LANE_DIED's rule). One the resume could not bring back gets a
//   mark per pane, so it is not told twice; the mark goes once that agent runs again (LANE_RUNNING_AGAIN). One brought back
//   gets none, so a later stop of it is told again.
export type SuspendIO = {
  readonly agentOf: (pane: string) => Promise<number | undefined>;
  readonly stat: StatOf;
  readonly resume: (pane: string, pid: number) => Promise<string>;
};

type SuspendMark = { readonly pane: string; readonly pid: number; readonly at: string; readonly hold: Hold };

const kill = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
};

export const suspendIO = (deps: FlowDeps): SuspendIO => ({
  agentOf: async (pane) => (isHerdrPane(pane) ? herdrAgentPid(deps.run, pane) : topAgent(await procTable(deps.run), await tmuxPanePid(deps.run, pane))?.pid),
  stat: readStat,
  resume: (pane, pid) => resumeAgent({ run: deps.run, clock: deps.clock, signal: jobSignal(kill) }, pane, pid),
});

export const laneSuspendedText = (who: string, hold: Hold, outcome: string): string => `[DORI] ${who} 멈춤(${hold === "stopped" ? "프로세스 정지" : "셸 뒤 작업으로 밀림"}) — ${outcome}`;

const markFile = (stateDir: string, pane: string): string => join(stateDir, "suspended", `${pane.replace(/[^\w.-]/g, "_")}.json`);
const readMark = (file: string): SuspendMark | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SuspendMark;
  } catch {
    return undefined;
  }
};

// A line the submit check refused before typing anything (the lead pane gone, dead, stopped, a question open, no prompt)
// never reached the lead: it is kept and sent again on a later tick. One typed but not seen taken may still arrive, so it
// is not sent again (LANE_DIED's rule).
const notTyped = (reason: string): boolean => /nothing was typed|so it was not typed|^no ❯ prompt in the pane/.test(reason);
// one record per incident, written before its line is sent (state sending) and kept only after a refusal before typing
// (state kept). A sending record a stopped watch left behind may have reached the lead: it is dropped, never sent again.
type Notice = { readonly key: string; readonly text: string; readonly at: string; readonly state: "sending" | "kept" };
const noticeDir = (stateDir: string): string => join(stateDir, "suspended", "notices");

// first check that found each pane's agent held, for the second one (in memory, like notLive)
const seenHeld = new Map<string, number>();

export const laneSuspendTick = async (deps: FlowDeps, io: SuspendIO = suspendIO(deps), alive: (pid: number) => boolean = pidAlive): Promise<string[]> => {
  const out: string[] = [];
  const now = deps.clock.now();
  const { stateDir, leadPane: lead, ignorePanes } = deps.config;
  const frozen = new Set(frozenPanes(stateDir));
  const lanes = (await deps.registry.open()).filter((l) => l.pane && l.pane !== lead && !ignorePanes.includes(l.pane) && statusOf(l) !== "paused");
  // the lead first: a lane's line can reach it only once it runs again
  const targets = [...(lead ? [{ who: "lead" as const, key: "lead", pane: lead }] : []), ...lanes.map((l) => ({ who: "lane" as const, key: l.key, pane: l.pane as string }))];
  // the records of this tick are tried again from the next one
  const kept = new Set<string>();
  const settle = (name: string, rec: Notice, sent: Submitted): void => {
    const f = join(noticeDir(stateDir), name);
    if (sent.status !== "SUBMITTED" && notTyped(sent.reason)) writeFileSync(f, JSON.stringify({ ...rec, state: "kept" } satisfies Notice));
    else rmSync(f, { force: true });
  };
  for (const t of targets) {
    const file = markFile(stateDir, t.pane);
    if (frozen.has(t.pane) || handoverRunning(stateDir, t.who, t.key, alive)) {
      seenHeld.delete(t.pane);
      continue;
    }
    const pid = await io.agentOf(t.pane).catch(() => undefined);
    const hold = pid ? holdOf(io.stat, pid) : undefined;
    if (!pid || !hold) {
      seenHeld.delete(t.pane);
      if (existsSync(file)) {
        rmSync(file, { force: true });
        out.push(`LANE_RUNNING_AGAIN ${t.key} ${t.pane}`);
      }
      continue;
    }
    if (readMark(file)?.pid === pid) continue;
    const first = seenHeld.get(t.pane);
    if (first === undefined) {
      seenHeld.set(t.pane, now);
      continue;
    }
    if (now - first < CONFIRM_MS) continue;
    seenHeld.delete(t.pane);
    const s = io.stat(pid);
    out.push(`LANE_SUSPENDED ${t.key} ${t.pane}: agent ${pid} ${hold} (state ${s?.state ?? "?"}, tty foreground group ${s?.tpgid ?? "?"}, its group ${s?.pgrp ?? "?"}); its screen is stale, resuming it`);
    const back = await io.resume(t.pane, pid);
    out.push(back);
    const resumed = back.startsWith("AGENT_RESUMED");
    const outcome = resumed ? "스스로 되살렸어, 하던 일을 잇는지 봐" : `되살리지 못했어(${back.replace(/^AGENT_RESUME_FAIL \S+ /, "").slice(0, 160)}) — ${isHerdrPane(t.pane) ? `dori revive ${t.pane}로 다시 해 봐` : `${t.pane}에서 fg를 쳐 봐`}`;
    const text = laneSuspendedText(t.who === "lead" ? "리드 omo" : `레인 ${t.key}`, hold, outcome);
    // only an agent left held needs the mark (one brought back runs, and a later stop of it is told again); it is written
    // before the line goes, so a watch that stops while sending does not find the agent unmarked and tell it again
    if (!resumed) {
      mkdirSync(join(stateDir, "suspended"), { recursive: true });
      writeFileSync(file, JSON.stringify({ pane: t.pane, pid, at: new Date(now).toISOString(), hold } satisfies SuspendMark));
    }
    const name = `${t.pane.replace(/[^\w.-]/g, "_")}-${pid}-${now}.json`;
    const rec: Notice = { key: t.key, text, at: new Date(now).toISOString(), state: "sending" };
    if (lead) {
      mkdirSync(noticeDir(stateDir), { recursive: true });
      writeFileSync(join(noticeDir(stateDir), name), JSON.stringify(rec));
    }
    const sent: Submitted = lead ? await submitToPane(deps.run, deps.clock, deps.config, lead, text) : { status: "NOT_SUBMITTED", reason: "no leadPane" };
    const told = sent.status === "SUBMITTED";
    out.push(told ? `LANE_SUSPENDED_TOLD ${t.key} ${lead}` : `LANE_SUSPENDED_NOT_TOLD ${t.key}: ${sent.reason}`);
    if (lead) settle(name, rec, sent);
    kept.add(name);
  }
  // kept lines go again (the agent is not touched again); one still refused before typing stays, any other outcome ends it
  const dir = noticeDir(stateDir);
  for (const name of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []) {
    if (kept.has(name) || !lead) continue;
    const f = join(dir, name);
    let notice: Notice;
    try {
      notice = JSON.parse(readFileSync(f, "utf8")) as Notice;
    } catch {
      rmSync(f, { force: true });
      continue;
    }
    if (notice.state !== "kept") {
      rmSync(f, { force: true });
      out.push(`LANE_SUSPENDED_NOT_TOLD ${notice.key}: a watch stopped while sending the line of ${notice.at}; it may have arrived, so it is not sent again`);
      continue;
    }
    writeFileSync(f, JSON.stringify({ ...notice, state: "sending" } satisfies Notice));
    const again = await submitToPane(deps.run, deps.clock, deps.config, lead, notice.text);
    settle(name, notice, again);
    if (again.status !== "SUBMITTED" && notTyped(again.reason)) continue;
    out.push(again.status === "SUBMITTED" ? `LANE_SUSPENDED_TOLD ${notice.key} ${lead} (line of ${notice.at})` : `LANE_SUSPENDED_NOT_TOLD ${notice.key}: ${again.reason} (line of ${notice.at})`);
  }
  return out;
};

export const laneDeathTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  const now = deps.clock.now();
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  for (const lane of await deps.registry.open()) {
    const pane = lane.pane;
    if (!pane || skip.has(pane) || statusOf(lane) === "paused") continue;
    const life = await paneLife(deps.run, pane);
    if (life.live) {
      notLive.delete(pane);
      if (lane.died) await deps.registry.patch(lane.key, { died: undefined });
      continue;
    }
    if (lane.died?.pane === pane) continue;
    const first = notLive.get(pane);
    if (first === undefined) {
      notLive.set(pane, now);
      continue;
    }
    if (now - first < CONFIRM_MS) continue;
    const oom = await oomLine(deps.run, pane, first - JOURNAL_BACK_MS).catch(() => undefined);
    // a herdr pane keeps no exit status (herdr.ts herdrLife: status -1)
    const herdr = isHerdrPane(pane);
    const reason = oom ? "메모리 부족" : life.how === "dead" ? (life.status < 0 ? "에이전트 꺼짐" : `종료 코드 ${life.status}`) : herdr ? "herdr pane 없음" : "tmux 세션 없음";
    const why = oom ? `oom-kill (journal: ${oom})` : life.how === "dead" ? (life.status < 0 ? "pane dead, no agent runs in it" : `pane dead, status ${life.status}`) : herdr ? "herdr pane gone" : "tmux session gone";
    out.push(`LANE_DIED ${lane.key} ${pane}: ${why}`);
    const lead = deps.config.leadPane;
    const sent: Submitted = lead ? await submitToPane(deps.run, deps.clock, deps.config, lead, laneDiedText(lane.key, reason)) : { status: "NOT_SUBMITTED", reason: "no leadPane" };
    const told = sent.status === "SUBMITTED";
    out.push(told ? `LANE_DIED_TOLD ${lane.key} ${lead}` : `LANE_DIED_NOT_TOLD ${lane.key}: ${sent.reason}`);
    const died: LaneDied = { pane, at: new Date(now).toISOString(), reason, why, told };
    await deps.registry.patch(lane.key, { died });
  }
  return out;
};
