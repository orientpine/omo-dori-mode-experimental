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
// - what can be done without typing is done at once (job-control.ts resumeAgent: a stopped foreground job or shell is
//   continued); one its shell holds as a background job is never typed into, and the lead gets one line saying whether it
//   came back or the exact fg to type by hand (once typed, the next check gives the tty bash cooked its raw mode back) (LANE_SUSPENDED_TOLD / _NOT_TOLD). A line refused before anything was typed is kept in
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
// never reached the lead: it waits and is sent on a later tick. One typed but not seen taken may still arrive, so it is
// not sent again (LANE_DIED's rule).
const notTyped = (reason: string): boolean => /nothing was typed|so it was not typed|^no ❯ prompt in the pane/.test(reason);
// One line per incident waits in its pane's pending file until the lead takes it, and is sent only from that pane's check
// below: after the pane passed the frozen and handover exclusions, while it still runs the agent the line is about, and a
// line with fg advice only while that agent is still held. A pane frozen, excluded or unreadable keeps its lines unsent; a
// pane no longer watched, or running another agent, drops them. Each line is marked sending before it goes, so a watch
// that stops mid-send does not send it twice (it may have arrived).
type Pending = { readonly key: string; readonly pane?: string; readonly pid: number; readonly kind: Hold | "recovered"; readonly text: string; readonly at: string; readonly state: "sending" | "kept" };
const pendingDir = (stateDir: string): string => join(stateDir, "suspended", "pending");
const paneName = (pane: string): string => pane.replace(/[^\w.-]/g, "_");
const readPending = (file: string): Pending[] => {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(v) ? (v as Pending[]) : [];
  } catch {
    return [];
  }
};
const writePending = (file: string, list: readonly Pending[]): void => {
  if (!list.length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(list));
};
const mayHaveArrived = (p: Pending): string => `LANE_SUSPENDED_NOT_TOLD ${p.key}: a watch stopped while sending the line of ${p.at}; it may have arrived, so it is not sent again`;

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
  const pendingFile = (pane: string): string => join(pendingDir(stateDir), `${paneName(pane)}.json`);
  // one line goes: written as sending first, then kept only after a refusal before typing
  const send = async (t: (typeof targets)[number], file: string, p: Pending, fresh: boolean): Promise<void> => {
    writePending(file, [...readPending(file).filter((q) => q.at !== p.at || q.pid !== p.pid), { ...p, state: "sending" }]);
    const sent: Submitted = await submitToPane(deps.run, deps.clock, deps.config, lead as string, p.text);
    const rest = readPending(file).filter((q) => q.at !== p.at || q.pid !== p.pid);
    const keep = sent.status !== "SUBMITTED" && notTyped(sent.reason);
    writePending(file, keep ? [...rest, { ...p, state: "kept" }] : rest);
    const of = fresh ? "" : ` (line of ${p.at})`;
    if (sent.status === "SUBMITTED") out.push(`LANE_SUSPENDED_TOLD ${p.key} ${lead}${of}`);
    else if (fresh || !keep) out.push(`LANE_SUSPENDED_NOT_TOLD ${p.key}: ${sent.reason}${of}`);
  };
  // the waiting lines of a pane that passed the exclusions and reads as running agent pid
  const sendPending = async (t: (typeof targets)[number], pid: number, hold: Hold | undefined): Promise<void> => {
    if (!lead) return;
    const file = pendingFile(t.pane);
    for (const p of readPending(file)) {
      const drop = (line: string): void => {
        writePending(file, readPending(file).filter((q) => q.at !== p.at || q.pid !== p.pid));
        out.push(line);
      };
      if (p.state === "sending") drop(mayHaveArrived(p));
      else if (p.pid !== pid) drop(`LANE_SUSPENDED_NOT_TOLD ${p.key}: ${t.pane} now runs agent ${pid}, so the line about agent ${p.pid} (line of ${p.at}) is not sent`);
      else if (p.kind !== "recovered" && !hold) drop(`LANE_SUSPENDED_NOT_TOLD ${p.key}: agent ${p.pid} runs again, so its fg advice (line of ${p.at}) is not sent`);
      else await send(t, file, p, false);
    }
  };
  for (const t of targets) {
    const file = markFile(stateDir, t.pane);
    if (frozen.has(t.pane) || handoverRunning(stateDir, t.who, t.key, alive)) {
      seenHeld.delete(t.pane);
      continue;
    }
    const pid = await io.agentOf(t.pane).catch(() => undefined);
    // no agent found or its process unreadable is no news: a mark stays until the agent is seen running
    if (!pid || !io.stat(pid)) {
      seenHeld.delete(t.pane);
      continue;
    }
    const hold = holdOf(io.stat, pid);
    await sendPending(t, pid, hold);
    const marked = readMark(file);
    if (!hold) {
      seenHeld.delete(t.pane);
      if (marked) {
        // the agent it was left on runs again (someone typed fg): the tty bash cooked gets omo's raw mode back, which
        // types nothing (resumeAgent); a new agent in the pane just ends the mark
        if (marked.pid === pid) {
          const back = await io.resume(t.pane, pid);
          if (back.startsWith("AGENT_RESUMED")) out.push(back);
        }
        rmSync(file, { force: true });
        out.push(`LANE_RUNNING_AGAIN ${t.key} ${t.pane}`);
      }
      continue;
    }
    if (marked?.pid === pid) continue;
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
    // the shell line may hold text typed for omo, mouse reports and CSI-u keys the stopped omo's terminal modes still
    // produce (herdr QA 2026-11-04): an enter would run it. A literal ^C byte (send-text, not a key name, which comes as
    // CSI-u text) makes the tty send the shell SIGINT, which drops the line unrun, an open quote included (H68). The fg goes
    // 0.3 s later in a write of its own: mouse reports keep landing on that line in bursts, so a fg sent apart from the ^C
    // lands on new junk, and one in the same write is flushed with the line (herdr QA round 9, F77)
    const [look, chain] = isHerdrPane(t.pane)
      ? [`herdr pane read ${t.pane}`, `herdr pane send-text ${t.pane} $'\\x03' && sleep 0.3 && herdr pane send-text ${t.pane} $'fg\\r'`]
      : [`tmux capture-pane -p -t ${t.pane}`, `tmux send-keys -t ${t.pane} -H 03 && sleep 0.3 && tmux send-keys -t ${t.pane} fg Enter`];
    const outcome = resumed ? "스스로 되살렸어, 하던 일을 잇는지 봐" : `셸이 tty를 쥐고 있어 손으로 fg를 한 번 쳐야 돌아와: ${look} 로 그 셸 줄을 본 뒤 ${chain} 를 그대로 쳐(문자 ^C 한 바이트가 줄에 남은 글자와 마우스 찌꺼기를 실행하지 않고 버리고, 열린 따옴표도; 0.3초 뒤 빈 줄에 fg. 엔터를 먼저 치면 그 줄이 실행되고, ^C와 fg를 한 번에 보내면 ^C가 fg까지 지워). ctrl 키 이름(send-keys ctrl+c)은 멈춘 omo가 켜 둔 키 모드 때문에 글자로 찍혀. 친 뒤 tty가 cooked로 남아 키를 안 받으면 다음 dori watch 확인(30초 안)이 raw 모드로 돌려놓아(아무것도 치지 않음)`;
    const text = laneSuspendedText(t.who === "lead" ? "리드 omo" : `레인 ${t.key}`, hold, outcome);
    // only an agent left held needs the mark (one brought back runs, and a later stop of it is told again); it is written
    // before the line goes, so a watch that stops while sending does not find the agent unmarked and tell it again
    if (!resumed) {
      mkdirSync(join(stateDir, "suspended"), { recursive: true });
      writeFileSync(file, JSON.stringify({ pane: t.pane, pid, at: new Date(now).toISOString(), hold } satisfies SuspendMark));
    }
    if (!lead) {
      out.push(`LANE_SUSPENDED_NOT_TOLD ${t.key}: no leadPane`);
      continue;
    }
    await send(t, pendingFile(t.pane), { key: t.key, pane: t.pane, pid, kind: resumed ? "recovered" : hold, text, at: new Date(now).toISOString(), state: "sending" }, true);
  }
  // lines of a pane no longer watched (the lane closed, paused or moved to another pane) are dropped, never sent
  const watched = new Set(targets.map((t) => paneName(t.pane)));
  const dir = pendingDir(stateDir);
  for (const name of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []) {
    if (watched.has(name.slice(0, -5))) continue;
    const f = join(dir, name);
    for (const p of readPending(f)) out.push(p.state === "sending" ? mayHaveArrived(p) : `LANE_SUSPENDED_NOT_TOLD ${p.key}: ${p.pane ?? name.slice(0, -5)} is no longer watched, so the line about agent ${p.pid} (line of ${p.at}) is not sent`);
    rmSync(f, { force: true });
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
