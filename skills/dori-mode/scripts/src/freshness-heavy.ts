import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmuxPanePid } from "./aoe.ts";
import { holdLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { treeOf } from "./heavy-headroom.ts";
import { NESTED_ENV } from "./heavy-here.ts";
import { holders, pidAlive } from "./heavy-slot-store.ts";
import { watchLog } from "./watch-log.ts";

// Observe only: a failed probe never changes freshness's actions or a job's life. The bounded receipt survives loop restarts.
export const heavyBypassTick = async (deps: FlowDeps): Promise<void> => {
  try {
    await checkBypass(deps);
  } catch (e) {
    const line = `FRESHNESS_WARN heavy bypass check: ${String(e).replace(/[\r\n]+/g, " ").slice(0, 160)}`;
    // the watch log itself may be what failed: the tick's other work goes on either way
    try {
      watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line });
    } catch {
      console.error(line);
    }
  }
};

const checkBypass = async (deps: FlowDeps): Promise<void> => {
  const lanes = (await deps.registry.open()).filter((lane) => lane.pane);
  if (!lanes.length) return;
  const gpu = await deps.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader"], { timeoutMs: 20_000 });
  if (gpu.code !== 0) return; // no nvidia-smi, no supported query, or no accessible GPU: no check
  // Compute membership counts even on unified-memory GPUs whose used_memory is [N/A].
  const pids = [...new Set(gpu.out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s*,/.exec(line);
    const pid = Number(match?.[1]);
    return Number.isSafeInteger(pid) && pid > 1 ? [pid] : [];
  }))];
  if (!pids.length) return;
  const ps = await deps.run(["ps", "-eo", "pid=,ppid=,rss=,pcpu="]);
  if (ps.code !== 0) return;
  const parents = new Map(ps.out.split("\n").flatMap((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return pid && parent !== undefined ? [[pid, parent] as const] : [];
  }));
  const lineage = (pid: number): number[] => {
    const chain: number[] = [];
    while (pid > 1 && parents.has(pid) && !chain.includes(pid)) {
      chain.push(pid);
      pid = parents.get(pid)!;
    }
    return chain;
  };
  const config = deps.config;
  const roots = holders({ dir: join(config.stateDir, "heavy"), alive: pidAlive }, Math.max(config.heavySlots, config.heavyMaxSlots)).map((h) => h.tree);
  const file = join(config.stateDir, "heavy-bypass-seen.json");
  // One process owns the read/check/write interval: overlapping ticks cannot warn twice or lose another tick's receipts.
  await holdLock(`${file}.lock`, "heavy bypass", "freshness", async () => {
    const seen = new Set<string>(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as string[] : []);
    const marked = new Map<number, boolean>();
    const underHeavy = async (pid: number): Promise<boolean> => {
      const cached = marked.get(pid);
      if (cached !== undefined) return cached;
      const [cg, env] = await Promise.all([
        deps.run(["cat", `/proc/${pid}/cgroup`]),
        deps.run(["cat", `/proc/${pid}/environ`], { preserveOutput: true }),
      ]);
      const yes = (cg.code === 0 && /(?:^|\/)dori-heavy-[^/\n]+\.(?:scope|service)(?:\/|$)/m.test(cg.out))
        || (env.code === 0 && env.out.split("\0").some((entry) => entry.startsWith(`${NESTED_ENV}=`) && entry.length > NESTED_ENV.length + 1));
      marked.set(pid, yes);
      return yes;
    };
    let changed = false;
    for (const lane of lanes) {
      const shell = await tmuxPanePid(deps.run, lane.pane!);
      if (!shell || !parents.has(shell)) continue;
      const tree = new Set(treeOf(ps.out, shell).pids);
      for (const pid of pids) {
        const key = `${lane.key}:${pid}`;
        if (!tree.has(pid) || seen.has(key)) continue;
        const chain = lineage(pid);
        if (roots.some((root) => chain.includes(root))) continue;
        let heavy = false;
        for (const parent of chain) if (await underHeavy(parent)) { heavy = true; break; }
        if (heavy) continue;
        const line = `HEAVY_BYPASS ${lane.key}: pid ${pid} uses GPU compute outside dori heavy (directive spread-load; a warning for now, refusal to be reviewed on 2026-12-01)`;
        console.error(line);
        watchLog(config.watchLog, deps.clock, { source: "freshness", line });
        seen.add(key);
        changed = true;
      }
    }
    if (changed) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...seen].slice(-512)));
      renameSync(tmp, file);
    }
  });
};
