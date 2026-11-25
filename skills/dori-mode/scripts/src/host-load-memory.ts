import { totalmem } from "node:os";
import type { DynamicHost } from "./heavy-dynamic.ts";
import { type MemInfo, parseMeminfo } from "./heavy-mem.ts";
import type { Runner } from "./run.ts";

const loadReading = async (run: Runner) => {
  const sysctl = await run(["sysctl", "-n", "vm.loadavg"]);
  const reading = sysctl.code === 0 ? sysctl : await run(["cat", "/proc/loadavg"]);
  const text = (sysctl.code === 0 ? reading.out.replace(/[{}]/g, "").trim() : reading.out).split(/\s+/)[0];
  return { text, code: reading.code };
};

const memoryReading = async (run: Runner) => {
  const mp = await run(["memory_pressure", "-Q"]);
  const macPct = mp.code === 0 ? Number(/free percentage: (\d+)%/.exec(mp.out)?.[1]) : NaN;
  if (Number.isFinite(macPct)) return { macPct, proc: undefined };
  const mi = await run(["cat", "/proc/meminfo"]);
  return { macPct: undefined, proc: mi.code === 0 ? parseMeminfo(mi.out) : undefined };
};

export const sampleGuardLoadMemory = async (run: Runner) => {
  const load = Number((await loadReading(run)).text);
  const { macPct, proc } = await memoryReading(run);
  return { load1: Number.isFinite(load) ? load : 0, memFreePct: macPct ?? (proc ? (100 * proc.availKb) / proc.totalKb : null) };
};

// https://github.com/sisyphuslabs/dori-superagent/pull/264
// Read load first and available memory last; unlike guard, an unsuccessful read is not zero load.
export const sampleHeavyHost = async (run: Runner): Promise<DynamicHost> => {
  const { text, code } = await loadReading(run);
  const load = code === 0 && /^\d+(?:\.\d+)?$/.test(text ?? "") ? Number(text) : NaN;
  const totalKb = totalmem() / 1024;
  const { macPct, proc } = await memoryReading(run);
  const memory: MemInfo | null = proc ?? (macPct !== undefined && macPct <= 100 && totalKb > 0 ? { totalKb, availKb: (macPct * totalKb) / 100 } : null);
  return { load1: Number.isFinite(load) ? load : null, memory };
};
