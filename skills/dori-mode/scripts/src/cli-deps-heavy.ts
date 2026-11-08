import { appendFileSync, mkdirSync } from "node:fs";
import { sampleUsage } from "./heavy-headroom.ts";
import { pidAlive, type SlotDeps } from "./heavy-slot.ts";
import { realClock, run } from "./run.ts";
import type { Cli } from "./cli-context.ts";


export const makeHeavyDeps = (cli: Pick<Cli, "config">) => {
  const { config } = cli;

  const heavyDeps = (load: () => Promise<number>): SlotDeps => ({
    dir: `${config.stateDir}/heavy`,
    slots: config.heavySlots,
    maxLoad: config.heavyMaxLoad,
    clock: realClock,
    load,
    alive: pidAlive,
    pid: process.pid,
    headroom: { maxSlots: config.heavyMaxSlots, free: config.heavyHeadroomPct, settleSec: config.heavySettleSec, usage: (pids) => sampleUsage(run, pids), gpuFreeKb: config.heavyGpuFreeGb * 1024 ** 2 },
    log: (line) => {
      console.error(line);
      // a refusal comes before any slot work made the folder
      mkdirSync(`${config.stateDir}/heavy`, { recursive: true });
      appendFileSync(`${config.stateDir}/heavy/heavy.log`, `${new Date().toISOString()} ${line}\n`);
    },
  });
  return { heavyDeps };
};
