import type { UsageSample } from "./heavy-headroom.ts";
import type { Clock } from "./run.ts";

// More jobs beside the first `slots`: up to maxSlots at once, each only when every resource keeps `free` percent free with
// it added, and not while a job taken less than settleSec ago has not shown its load yet.
export type Headroom = {
  readonly maxSlots: number;
  readonly free: number;
  readonly settleSec: number;
  readonly usage: (jobPids: readonly number[]) => Promise<UsageSample>;
  // free memory a GPU job gets made before it starts (heavyGpuFreeGb in kB, heavy-mem.ts gpuRoom; 0: none)
  readonly gpuFreeKb?: number;
};

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  // `since`: the slot was claimed then, so only a process started by then can be its holder (a pid reused later is not)
  readonly alive: (pid: number, since?: number) => boolean;
  readonly pid: number;
  readonly headroom?: Headroom;
  // one line per job when it is taken (HEAVY_ADMIT) and when it starts or changes why it waits (HEAVY_WAIT)
  readonly log?: (line: string) => void;
};
