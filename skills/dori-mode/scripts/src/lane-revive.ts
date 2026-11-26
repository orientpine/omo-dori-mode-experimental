import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { agentPath, captureTmux, herdrAgentArgv, laneEnv, paneLife } from "./aoe.ts";
import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { argvSessionLog, omoInputBox, reviveHerdr, sessionModel } from "./herdr-sessions.ts";
import { isHerdrPane, openHerdrSession } from "./herdr.ts";
import { laneHomeEnv } from "./home-env.ts";
import { splitModel } from "./lane-handover.ts";
import { sendVerified } from "./panes.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { argvSessionId, hasSessionSelector } from "./session-id.ts";
import { TokenFileError } from "./slack-token.ts";

// 2026-11-25 23:17Z: Jjangdori's open lane h3-charsheet lost its hc terminal (hc:t27 gone from the core). dori type said
// PANE_GONE, the watch asked the lead to decide, and dori revive (reviveHerdr) starts an agent only in a pane that is still
// there. An open lane whose pane is gone is opened here in a new pane of the chosen runtime, labelled with its key in its
// cwd, running the lane's own conversation (omo --session-id <the recorded session>, the model its log ran last), with the
// same lane env a launch gives. Only the record's pane (and tab) moves, written before the agent starts so a watch tick
// in between sees the new pane; a start that fails puts the gone pane back. No prompt unless the caller gives one: the
// lane comes back where it stood, and is never told to start work again. One revive per lane at a time (a lock).
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
    // read again under the lock: another revive, a handover or a close may have moved the lane since it was read
    const now = await deps.registry.read(lane.key);
    if (!now || statusOf(now) === "closed" || now.pane !== gone) return fail(`the lane's pane is ${now?.pane ?? "none"} now, not ${gone}; nothing was opened`);
    const cwd = now.cwd ?? config.defaultCwd;
    const log = argvSessionLog(config.agentCommand, config.sessionsDir, cwd, session);
    const { base, thinking } = splitModel((log ? sessionModel(log) : undefined) || now.model || config.defaultModel);
    const argv = herdrAgentArgv(config.agentCommand, base, thinking, session);
    const env = { ...laneEnv(config.launchEnv, now.useGpu), ...home, PATH: agentPath(config.agentCommand[0] ?? "omo") };
    const opened = await openHerdrSession(deps.run, deps.clock, {
      title: now.key,
      cwd,
      argv,
      env,
      ...(config.laneWorkspace ? { workspace: config.laneWorkspace } : {}),
      beforeStart: ({ pane, tab }) => deps.registry.patch(now.key, { pane, tab }),
    }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    if (opened instanceof Error) {
      const moved = (await deps.registry.read(now.key))?.pane;
      if (moved !== gone) await deps.registry.patch(now.key, { pane: gone, tab: now.tab });
      return fail(`no new pane could be started: ${opened.message.slice(0, 160)}`);
    }
    const { pane } = opened;
    const done = `${now.key} ${pane} session ${session} (pane ${gone} was gone)`;
    for (let i = 0; i < 90; i++) {
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
