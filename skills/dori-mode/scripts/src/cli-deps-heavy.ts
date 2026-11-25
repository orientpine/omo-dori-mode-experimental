import { appendFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { sampleUsage } from "./heavy-headroom.ts";
import { holdNote } from "./heavy-hold.ts";
import { ownerAlive, pidAlive } from "./heavy-pid.ts";
import type { SlotDeps } from "./heavy-slot-types.ts";
import { sampleHeavyHost } from "./host-load-memory.ts";
import { realClock, run } from "./run.ts";
import type { Cli } from "./cli-context.ts";


export const makeHeavyDeps = (cli: Pick<Cli, "config">) => {
  const { config } = cli;
  // https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/264
  const dynamic = config.heavyJobMemGb === null ? undefined : {
    minSlots: config.heavyMinSlots,
    maxSlots: config.heavyMaxSlots,
    jobMemKb: config.heavyJobMemGb * 1024 ** 2,
    memFreeMinPct: config.guard.memFreeMinPct,
    sample: () => sampleHeavyHost(run),
  };

  const heavyDeps = (load: () => Promise<number>): SlotDeps => ({
    dir: `${config.stateDir}/heavy`,
    slots: config.heavySlots,
    maxLoad: config.heavyMaxLoad,
    clock: realClock,
    load,
    alive: dynamic ? ownerAlive : pidAlive,
    ...(dynamic ? { dynamic } : {}),
    pid: process.pid,
    hold: () => holdNote(config.heavyHoldDir, realClock.now(), userInfo().username),
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
