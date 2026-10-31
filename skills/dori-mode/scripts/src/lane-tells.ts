// A lead handover tells each open lane where the lead moved. A lane that did not take that [LEAD] line (told=no) is not
// left there: its line waits here, and every freshness tick retries it. The text is typed again only while the lane's
// turn runs (then it steers in), since a text typed while its main turn waits on children stays in omo's input queue,
// undelivered (pingpong-analytics, 2026-10-31). A held copy that arrived later counts as told. When the lane took
// nothing for LANE_TELL_LEAD_AFTER_MS the lead is told once what to do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { captureTmux } from "./aoe.ts";
import type { DoriConfig } from "./config.ts";
import { sendVerified } from "./panes.ts";
import type { Registry } from "./registry.ts";
import type { Clock, Runner } from "./run.ts";
import { turnRunning } from "./submit.ts";

export const LANE_TELL_LEAD_AFTER_MS = 20 * 60_000;

export type LaneTell = { readonly pane: string; readonly lead: string; readonly at: string; readonly tries: number; readonly leadTold?: boolean };
type Tells = Record<string, LaneTell>;

export const laneTellsFile = (stateDir: string): string => join(stateDir, "handover", "lane-tells.json");

const readTells = (stateDir: string): Tells => {
  const file = laneTellsFile(stateDir);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Tells;
  } catch {
    return {};
  }
};

const writeTells = (stateDir: string, tells: Tells): void => {
  const file = laneTellsFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(tells, null, 1)}\n`);
};

export const leadMovedText = (lead: string): string =>
  `[LEAD] The lead moved to tmux session ${lead}. Send every [REPORT] there from now on: ["dori","type","${lead}","--text","<report line>"]. Your brief's footer says the same now.`;

// told: the lane took the line (any earlier wait for it ends); not told: it waits for the freshness retry
export const noteLaneTell = (stateDir: string, key: string, pane: string, lead: string, at: string, told: boolean): void => {
  const tells = readTells(stateDir);
  if (told) {
    if (!(key in tells)) return;
    delete tells[key];
  } else tells[key] = { pane, lead, at, tries: 1 };
  writeTells(stateDir, tells);
};

export type LaneTellDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly registry: Pick<Registry, "open">;
  // the lane's transcript holds the line since then (a copy omo held arrived late)
  readonly delivered: (pane: string, text: string, since: number) => Promise<boolean>;
};

export const retryLaneTells = async (deps: LaneTellDeps): Promise<string[]> => {
  const tells = readTells(deps.config.stateDir);
  const keys = Object.keys(tells);
  if (!keys.length) return [];
  const open = new Map((await deps.registry.open()).map((l) => [l.key, l]));
  const lead = deps.config.leadPane;
  const out: string[] = [];
  for (const key of keys) {
    const t = tells[key];
    if (!t) continue;
    const lane = open.get(key);
    // closed, or moved to a new session (a lane handover tells the new one itself): nothing left to tell
    if (!lane || lane.pane !== t.pane || !lead) {
      delete tells[key];
      continue;
    }
    const since = Date.parse(t.at);
    if (await deps.delivered(t.pane, leadMovedText(t.lead), since)) {
      delete tells[key];
      out.push(`HANDOVER_LANE_TOLD ${key} ${t.pane}: the lead notice reached the lane's transcript late (omo held it)`);
      continue;
    }
    if (turnRunning(await captureTmux(deps.run, t.pane).catch(() => ""))) {
      const ok = await sendVerified(deps.run, deps.clock, deps.config, t.pane, leadMovedText(lead));
      if (ok) {
        delete tells[key];
        out.push(`HANDOVER_LANE_TOLD ${key} ${t.pane}: told the lead is ${lead} (try ${t.tries + 1}, while its turn ran)`);
        continue;
      }
      tells[key] = { ...t, lead, tries: t.tries + 1 };
    } else if (t.lead !== lead) tells[key] = { ...t, lead };
    const waited = deps.clock.now() - since;
    if (waited >= LANE_TELL_LEAD_AFTER_MS && !t.leadTold) {
      const min = Math.round(waited / 60_000);
      const told = await sendVerified(deps.run, deps.clock, deps.config, lead, `[DORI] HANDOVER_LANE_UNTOLD ${key}: lane pane ${t.pane} has not taken the notice that the lead moved to ${lead} for ${min} min (${t.tries} tries; omo holds a text typed while the lane's main turn waits on its children). Its brief footer names you already, and a report it types into the frozen old lead is forwarded to you. To tell it sooner: read its pane and dori type it once a turn runs there.`);
      tells[key] = { ...(tells[key] ?? t), leadTold: told };
      out.push(`HANDOVER_LANE_UNTOLD ${key} ${t.pane}: ${min} min without the lead notice; ${told ? "the lead was told" : "telling the lead failed, tried again next tick"}`);
    }
  }
  writeTells(deps.config.stateDir, tells);
  return out;
};
