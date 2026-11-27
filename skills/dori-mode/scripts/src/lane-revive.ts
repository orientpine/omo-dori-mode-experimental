import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { agentPath, captureTmux, herdrAgentArgv, laneEnv, paneLife } from "./aoe.ts";
import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { HcStartupError, hcLife, isHcPane } from "./hc-pane.ts";
import { argvSessionLog, omoInputBox, reviveHerdr, sessionModel } from "./herdr-sessions.ts";
import { pidAlive } from "./background.ts";
import { handoverRunning } from "./freshness.ts";
import { frozenPanes } from "./frozen.ts";
import { closeHerdrSession, HerdrStartupError, isHerdrPane, openHerdrSession } from "./herdr.ts";
import { laneHomeEnv } from "./home-env.ts";
import { pendingFile, splitModel } from "./lane-handover.ts";
import { sendVerified } from "./panes.ts";
import { withLaneLifecycle } from "./lane-lifecycle.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { execOf, type Runner } from "./run.ts";
import { HerdrCli, reasonOf } from "./runtime/herdr/exec.ts";
import { argvSessionId, hasSessionSelector } from "./session-id.ts";
import { TokenFileError } from "./slack-token.ts";

// 2026-11-25 23:17Z: Jjangdori's open lane h3-charsheet lost its hc terminal (hc:t27 gone from the core). dori type said
// PANE_GONE, the watch asked the lead to decide, and dori revive (reviveHerdr) starts an agent only in a pane that is still
// there. An open lane whose pane is gone is opened here in a new pane of the chosen runtime, labelled with its key in its
// cwd, running the lane's own conversation (omo --session-id <the recorded session>, the model its log ran last), with the
// same lane env a launch gives. Only the record's pane (and tab) moves, with the lane's open question cards: written right
// before the agent starts, once the record still names the gone pane on the same session and is not closed, so a close or
// handover in between wins and the new pane is closed unused. A start that fails puts the gone pane back only when the new
// pane was confirmed closed; else the record keeps naming it, so nothing opens the conversation twice. No prompt unless the
// caller gives one: the lane comes back where it stood, and is never told to start work again. One revive per lane (a lock).
export const reviveGoneLane = async (deps: FlowDeps, lane: Lane, prompt: string): Promise<string> => {
  const { config } = deps;
  const gone = lane.pane ?? "";
  const fail = (why: string): string => `REVIVE_FAIL ${lane.key}: ${why}`;
  const session = lane.session ?? "";
  if (!argvSessionId(["--session-id", session])) return fail(`no omo session recorded for the lane (${deps.registry.path(lane.key)}); a new conversation is opened only by dori launch`);
  if (config.backend === "aoe") return fail("an aoe lane restarts with self-restart.sh");
  if (hasSessionSelector(config.agentCommand.slice(1))) return fail(`agentCommand picks its session itself (${config.agentCommand.join(" ")}); revive needs one without a session selector`);
  let home: Record<string, string>;
  try {
    home = laneHomeEnv(config);
  } catch (error) {
    if (error instanceof TokenFileError) return fail(`token file refused: ${error.message}`);
    throw error;
  }
  mkdirSync(join(config.stateDir, "revive"), { recursive: true });
  let release: () => void;
  try {
    release = takeLock(join(config.stateDir, "revive", `${lane.key}.lock`), deps.clock.now(), "revive", lane.key);
  } catch (error) {
    if (error instanceof CheckpointError) return fail(error.message);
    throw error;
  }
  try {
    // the lane as it stands now: another revive, a handover or a close may have moved it since it was read
    const moved = (l: Lane | null): string | undefined => (!l ? "not recorded" : statusOf(l) === "closed" || l.pane !== gone || l.session !== session ? `${statusOf(l)} in ${l.pane ?? "no pane"}` : undefined);
    // a handover of the lane (running, one that froze the gone pane, or an interrupted one whose journal is left for its
    // repair, whose owner may be dead) moves the lane itself: a revive then opens nothing, read again right before the new
    // pane is written (reviews 4 and 5 of #535)
    const handover = (): string | undefined =>
      existsSync(pendingFile(config.stateDir, lane.key)) ? `an interrupted handover of the lane is left in ${pendingFile(config.stateDir, lane.key)} for its repair` : frozenPanes(config.stateDir).includes(gone) || handoverRunning(config.stateDir, "lane", lane.key, pidAlive) ? `a handover of the lane is running or holds ${gone}` : undefined;
    const now = await deps.registry.read(lane.key);
    const moving = handover();
    if (moving) return fail(`${moving}; it moves the lane itself, so nothing was opened`);
    const off = moved(now);
    if (off || !now) return fail(`the lane is ${off} now, not open in ${gone}; nothing was opened`);
    if (!(await paneGoneForSure(deps.run, gone))) return fail(`${gone} is not known to be gone (its runtime did not answer not found); nothing was opened`);
    const cwd = now.cwd ?? config.defaultCwd;
    const log = argvSessionLog(config.agentCommand, config.sessionsDir, cwd, session);
    const { base, thinking } = splitModel((log ? sessionModel(log) : undefined) || now.model || config.defaultModel);
    const argv = herdrAgentArgv(config.agentCommand, base, thinking, session);
    const env = { ...laneEnv(config.launchEnv, now.useGpu), ...home, PATH: agentPath(config.agentCommand[0] ?? "omo") };
    let published: string | undefined;
    const opened = await openHerdrSession(deps.run, deps.clock, {
      title: now.key,
      cwd,
      argv,
      env,
      ...(config.laneWorkspace ? { workspace: config.laneWorkspace } : {}),
      beforeStart: ({ pane, tab }) =>
        withLaneLifecycle(deps, now.key, async () => {
          const later = moved(await deps.registry.read(now.key)) ?? handover();
          if (later) throw new Error(`the lane is ${later} now, so ${pane} is not used`);
          await deps.registry.patch(now.key, { pane, tab });
          published = pane;
          deps.retargetCards?.(gone, pane);
        }),
    }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    if (opened instanceof Error) {
      const why = opened.message.slice(0, 160);
      if (!published) return fail(`no new pane was started: ${why}`);
      const closed = (opened instanceof HcStartupError || opened instanceof HerdrStartupError) && opened.rollback;
      if (!closed) return fail(`the agent's start in ${published} failed and that pane is not confirmed closed (${why}); the record names ${published}, so the conversation is not opened twice`);
      const back = published;
      // under the lifecycle lock, so a close between this read and write is never undone (review 3 of #535)
      await withLaneLifecycle(deps, now.key, async () => {
        const after = await deps.registry.read(now.key);
        if (!after || statusOf(after) === "closed" || after.pane !== back) return;
        await deps.registry.patch(now.key, { pane: gone, tab: now.tab });
        deps.retargetCards?.(back, gone);
      });
      return fail(`the agent's start in ${published} failed and that pane was closed (${why}); the record names ${gone} again`);
    }
    const { pane } = opened;
    const done = `${now.key} ${pane} session ${session} (pane ${gone} was gone)`;
    for (let i = 0; i < 90; i++) {
      const latest = await deps.registry.read(now.key);
      if (!latest || statusOf(latest) === "closed") return fail(`the lane was closed while ${pane} started (the close closes ${pane})`);
      if (latest.pane !== pane) return fail(`the lane moved to ${latest.pane ?? "no pane"} while ${pane} started; ${await closeHerdrSession(deps.run, pane)}`);
      // ready once an agent runs there and shows omo's own input box (an echoed command line has no box)
      const screen = (await paneLife(deps.run, pane)).live ? await captureTmux(deps.run, pane) : "";
      if (omoInputBox(screen)) {
        if (!prompt) return `REVIVE_OK ${done}`;
        return (await sendVerified(deps.run, deps.clock, config, pane, prompt)) ? `REVIVE_OK ${done} (prompt submitted)` : `REVIVE_PROMPT_NOT_SUBMITTED ${done}`;
      }
      await deps.clock.sleep(2_000);
    }
    return fail(`no running agent with its ❯ prompt within 3 minutes in ${pane} (session ${session}); the record names ${pane}`);
  } finally {
    release();
  }
};

// herdr's pane get fails alike for a pane it does not have and for a server it cannot reach (herdrLife reads both as gone):
// only its pane_not_found counts here. hc's not_found is the only gone verdict hcLife gives (an unreadable core is live).
export const paneGoneForSure = async (run: Runner, pane: string): Promise<boolean> => {
  if (isHcPane(pane)) {
    const life = await hcLife(run, pane);
    return !life.live && life.how === "gone";
  }
  return new HerdrCli(execOf(run)).call(["pane", "get", pane]).then(() => false, (e: unknown) => /pane_not_found/.test(reasonOf(e)));
};

// dori revive <lane key | pane>: an open lane's gone pane opens again in a new one (reviveGoneLane); a pane that is still
// there but whose agent is gone starts its recorded session in place (reviveHerdr); a live agent is never touched.
export const reviveTarget = async (deps: FlowDeps, target: string, prompt: string): Promise<string> => {
  const byKey = LANE_KEY.test(target) ? await deps.registry.read(target) : null;
  const lane = byKey && statusOf(byKey) !== "closed" ? byKey : (await deps.registry.open()).find((l) => l.pane === target);
  const pane = lane?.pane ?? target;
  if (!isHerdrPane(pane)) return `REVIVE_FAIL ${target}: revive takes a herdr or hc pane, or the key of an open lane on one (an aoe session restarts with self-restart.sh)`;
  const life = await paneLife(deps.run, pane);
  if (life.live) return `REVIVE_ALREADY_RUNNING ${pane}`;
  if (lane && life.how === "gone") return reviveGoneLane(deps, lane, prompt);
  return reviveHerdr(deps.run, deps.clock, deps.config, pane, prompt, (p, t) => sendVerified(deps.run, deps.clock, deps.config, p, t));
};
