import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FlowDeps } from "./done-flow.ts";
import { paneLife } from "./aoe.ts";
import { frozenPanes } from "./frozen.ts";
import { isHerdrPane } from "./herdr.ts";
import { hcStaleBlock, isHcPane } from "./hc-pane.ts";
import { herdrLeadSession, readHerdrSessions, reviveHerdr } from "./herdr-sessions.ts";
import { sendVerified } from "./panes.ts";
import { findLead } from "./lead.ts";
import { clock, ownerRows, placeOf, tailOf } from "./lead-limit.ts";
import { waitingOwnerRows } from "./owner-waiting.ts";
import type { Runner } from "./run.ts";

// The lead died and nothing started it again (2026-10-22 18:23-18:50 KST): a lane's QA cleanup ran
// `TMUX_TMPDIR=<tmp> tmux kill-server` inside its own aoe pane, where $TMUX names the default socket, so tmux killed the
// default server and every session on it, the lead included. dori watch runs in its own systemd unit and kept running, but
// every lead check reads the lead's transcript through its live process and found nothing, so it said nothing for 27 minutes
// until the owner started the lead again from the aoe web dashboard.
// - LEAD_DOWN once when the lead's tmux session is gone or its pane is dead.
// - LEAD_REVIVE_STARTED after it stayed down leadReviveMin minutes: self-restart.sh --start in its own transient user unit
//   (KillMode=none, so a tmux server it starts outlives the unit and a restart of dori-lanes), which resumes the same
//   conversation through aoe and types revivedText; again every REVIVE_EVERY_MS while still down, at most REVIVE_MAX times.
//   The first one also posts discord.leadDownText as this Dori's bot where the owner last wrote (no model).
// - LEAD_UP when the session is back.
// Only the lead now is checked: watchTick hands every check the leadPane the config names on that pass (2026-11-11:
// LEAD_REVIVE_WARN w1:p37 ... herdr has no such pane every ten minutes after ZzangDori's handover w1:p37 -> w1:p4C, from a
// watch started before it), and a frozen pane is no lead to check or revive.

const REVIVE_EVERY_MS = 10 * 60_000;
const RECORD_EVERY_MS = 10 * 60_000;
const REVIVE_MAX = 3;
const DAY_MS = 24 * 60 * 60_000;
const INBOX_TAIL_BYTES = 512 * 1024;

export const REVIVE_SCRIPT = fileURLToPath(new URL("../../setups/discord-aoe/self-restart.sh", import.meta.url));

type DownMark = { readonly pane: string; readonly since: string; readonly revives: number; readonly lastReviveAt?: string; readonly notice?: string; readonly gaveUp?: boolean };

const markPath = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-down.json");
const readMark = (deps: FlowDeps, pane: string): DownMark | undefined => {
  try {
    const m = JSON.parse(readFileSync(markPath(deps), "utf8")) as DownMark;
    return m.pane === pane ? m : undefined;
  } catch {
    return undefined;
  }
};

// alive: its tmux session exists and its pane has not exited (a dead pane stays only with remain-on-exit); a herdr lead's
// pane exists and an agent runs in it (aoe.ts paneLife)
export const leadAlive = async (run: Runner, pane: string): Promise<boolean> => (await paneLife(run, pane)).live;

// An hc lead whose status stayed blocked with no dialog on its screen (hc-pane.ts hcStaleBlock; 2026-11-12 hc:t2r, Needs
// you on the owner's phone for hours with nothing to answer): told once per block, keyed by the time hc's status was set,
// so a lead going from working back to idle under the same block is not told again and a new block is.
const stalePath = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-stale-blocked.json");
const staleBlockNotice = async (deps: FlowDeps, pane: string, now: number): Promise<string[]> => {
  const since = await hcStaleBlock(deps.run, pane, now);
  if (since === undefined) return [];
  try {
    const told = JSON.parse(readFileSync(stalePath(deps), "utf8")) as { pane?: string; since?: number };
    if (told.pane === pane && told.since === since) return [];
  } catch {
    // not told yet
  }
  writeFileSync(stalePath(deps), `${JSON.stringify({ pane, since })}\n`);
  return [`LEAD_STALE_BLOCKED ${pane} hc has said blocked since ${new Date(since).toISOString()} but omo's idle input box is on screen and no dialog: the owner's phone shows Needs you with nothing to answer. dori type still gets through; the status clears only when the lead restarts in the same conversation while idle (ask Soodori in #dori-pair)`];
};

export const revivedText = (since: string, what = "tmux session"): string =>
  `[DORI] LEAD_REVIVED: your session was down since ${since} (its ${what} was gone) and dori watch started it again in the same conversation. Read the owner's messages in the inbox since then and answer him.`;

// the unit outlives this sweep: a tmux server that `aoe session start` starts stays in the unit's cgroup
export const reviveArgv = (unit: string, id: string, tmux: string, prompt: string, env: Readonly<Record<string, string | undefined>>): string[] => [
  "systemd-run",
  "--user",
  "--collect",
  "--quiet",
  "--unit",
  unit,
  "-p",
  "KillMode=none",
  "-p",
  "RemainAfterExit=yes",
  ...["DORI_CONFIG", "DORI_ENV_FILE", "DORI_STATE_DIR"].flatMap((k) => (env[k] ? [`--setenv=${k}=${env[k]}`] : [])),
  "/bin/bash",
  REVIVE_SCRIPT,
  "--start",
  id,
  tmux,
  prompt,
];

export const leadDownTick = async (deps: FlowDeps, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> => {
  const pane = deps.config.leadPane;
  if (!pane || deps.config.leadReviveMin <= 0 || frozenPanes(deps.config.stateDir).includes(pane)) return [];
  const mark = readMark(deps, pane);
  const now = deps.clock.now();
  if (await leadAlive(deps.run, pane)) {
    // a herdr lead's conversation and model are kept for its revive and its lanes (herdr-sessions.ts), read again at most
    // every RECORD_EVERY_MS since the model was last read (modelAt: reads that only see the session, as an owner row's
    // lead-limit check, move at but not the model; no record yet, as after a handover moved the lead: read it now)
    const recordedAt = Date.parse(readHerdrSessions(deps.config.stateDir)[pane]?.modelAt ?? "");
    if (isHerdrPane(pane) && !(now - recordedAt < RECORD_EVERY_MS)) await herdrLeadSession(deps.run, deps.config, pane, true).catch(() => "");
    const stale = isHcPane(pane) ? await staleBlockNotice(deps, pane, now) : [];
    if (!mark) return stale;
    rmSync(markPath(deps), { force: true });
    return [...stale, `LEAD_UP ${pane} down since ${mark.since} (${Math.round((now - Date.parse(mark.since)) / 60_000)} min, ${mark.revives} revive(s))`];
  }
  const out: string[] = [];
  let next: DownMark = mark ?? { pane, since: new Date(now).toISOString(), revives: 0 };
  const save = (m: DownMark): void => {
    next = m;
    writeFileSync(markPath(deps), `${JSON.stringify(m)}\n`);
  };
  if (!mark) {
    save(next);
    out.push(`LEAD_DOWN ${pane} no live ${isHerdrPane(pane) ? "herdr agent" : "tmux session"} or pane; revive after ${deps.config.leadReviveMin} min`);
  }
  const since = Date.parse(next.since);
  if (now - since < deps.config.leadReviveMin * 60_000) return out;
  if (next.revives >= REVIVE_MAX) {
    if (!next.gaveUp) {
      save({ ...next, gaveUp: true });
      out.push(`LEAD_REVIVE_GAVE_UP ${pane} still down after ${REVIVE_MAX} revives since ${next.since}; ~/.dori/self-restart.log`);
    }
    return out;
  }
  if (next.lastReviveAt && now - Date.parse(next.lastReviveAt) < REVIVE_EVERY_MS) return out;
  let lead: string;
  try {
    // the pane checked above, not a DORI_LEAD_TMUX the watch was started with
    lead = await findLead(deps.run, { ...deps.config, leadPane: pane }, { ...env, DORI_LEAD_TMUX: pane });
  } catch (e) {
    out.push(`LEAD_REVIVE_WARN ${pane} ${String(e).slice(0, 200)}`);
    return out;
  }
  const [id = "", tmux = pane] = lead.split(" ");
  if (isHerdrPane(tmux)) {
    // the herdr server owns the agent it starts, so no unit of its own is needed (a restart of dori-lanes leaves it)
    // next itself, so the notice saved below keeps the count
    next = { ...next, revives: next.revives + 1, lastReviveAt: new Date(now).toISOString() };
    save(next);
    const line = await reviveHerdr(deps.run, deps.clock, deps.config, tmux, revivedText(clock(deps, since), "herdr agent"), (p, t) => sendVerified(deps.run, deps.clock, deps.config, p, t));
    if (!line.startsWith("REVIVE_OK")) {
      out.push(`LEAD_REVIVE_WARN ${pane} ${line}`);
      return out;
    }
    out.push(`LEAD_REVIVE_STARTED ${pane} down since ${next.since}; ${line} (${next.revives}/${REVIVE_MAX})`);
  } else {
    const unit = `dori-lead-revive-${now}`;
    const started = await deps.run(reviveArgv(unit, id, tmux, revivedText(clock(deps, since)), env));
    // next itself, so the notice saved below keeps the count
    next = { ...next, revives: next.revives + 1, lastReviveAt: new Date(now).toISOString() };
    save(next);
    if (started.code !== 0) {
      out.push(`LEAD_REVIVE_WARN ${pane} systemd-run failed (code ${started.code}): ${(started.err || started.out).trim().slice(0, 200)}`);
      return out;
    }
    out.push(`LEAD_REVIVE_STARTED ${pane} down since ${next.since}; ${unit} runs self-restart.sh --start ${id} (${next.revives}/${REVIVE_MAX})`);
  }
  if (next.notice) return out;
  const inbox = deps.ownerInbox;
  // where his newest message still waiting on this lead is, as LEAD_OWNER_WAITING picks it (owner-waiting.ts)
  const tail = inbox && existsSync(inbox.path) ? tailOf(inbox.path, INBOX_TAIL_BYTES) : "";
  const rows = inbox && tail ? waitingOwnerRows(ownerRows(tail, inbox.ownerId).filter((r) => now - r.at < DAY_MS), tail, inbox.path) : [];
  const channel = placeOf(rows, inbox?.ownerChannel ?? "");
  const cannot = !deps.postOwner ? "no bot token" : !channel ? "no owner channel" : "";
  const text = deps.config.discord.leadDownText.replaceAll("{since}", clock(deps, since));
  const posted = cannot ? `NOT_POSTED ${cannot}` : await deps.postOwner!(channel, text).then((m) => `POSTED ${channel} ${m}`, (e: unknown) => `NOT_POSTED ${String(e).slice(0, 160)}`);
  save({ ...next, notice: posted });
  out.push(`LEAD_DOWN_NOTICE ${pane} ${posted}`);
  return out;
};
