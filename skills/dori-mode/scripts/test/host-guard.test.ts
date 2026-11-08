import { expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { alertReasons, guardTick, outsideLines, sampleHost, sampleOutside } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import type { Runner } from "../src/run.ts";

// https://github.com/sisyphuslabs/dori-superagent/issues/90: on Linux memory_pressure is missing, and memory read as 100% free
const t = defaultConfig("/home/test").guard;
const meminfo = "MemTotal:       1000000 kB\nMemFree:          20000 kB\nMemAvailable:     150000 kB\n";
const fake = (answers: Record<string, { code: number; out: string }>): Runner => async (argv) => {
  const a = answers[argv.join(" ")] ?? { code: 127, out: "" };
  return { ...a, err: "" };
};

test("on Linux memory is MemAvailable over MemTotal from /proc/meminfo, and low memory holds a launch", async () => {
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 0, out: meminfo } }), { backend: "herdr" });
  expect(s.memFreePct).toBe(15);
  expect(canLaunch(s, t).reasons).toContain("memory free 15% < 20%");
  expect(alertReasons(s, t)).toContain("memory free 15% < 20%");
});

test("memory just under the floor holds a launch though it would round up to the floor; at and over the floor it does not", async () => {
  const at = async (availKb: number) =>
    sampleHost(fake({ "cat /proc/meminfo": { code: 0, out: `MemTotal:       1000000 kB\nMemAvailable:     ${availKb} kB\n` } }), { backend: "herdr" });
  const under = await at(199000);
  expect(canLaunch(under, t).reasons).toContain("memory free 19% < 20%");
  expect(alertReasons(under, t)).toContain("memory free 19% < 20%");
  for (const kb of [200000, 201000]) {
    const s = await at(kb);
    expect(canLaunch(s, t).reasons.some((r) => r.startsWith("memory"))).toBe(false);
    expect(alertReasons(s, t).some((r) => r.startsWith("memory"))).toBe(false);
  }
});

test("a long heavy process outside dori heavy is named once with its account; scoped, system and short ones are not", async () => {
  // Given: ps rows (pid uid user seconds cpu% args) and each candidate's cgroup
  const ps = [
    "  101  1003 gongdori 2400 180.5 python -m pytest qa/e7_demo",
    "  102  1003 gongdori 9000 300.0 python train.py",
    "  103     0 root     9000 250.0 /usr/bin/dockerd",
    "  104  1001 oriclaw   600 400.0 bun test",
    "  105  1001 oriclaw  4000  20.0 bun omo",
  ].join("\n");
  const run = fake({
    "ps -eo pid=,uid=,user:32=,etimes=,pcpu=,args=": { code: 0, out: ps },
    "cat /proc/101/cgroup": { code: 0, out: "0::/user.slice/user-1003.slice/session-4.scope\n" },
    "cat /proc/102/cgroup": { code: 0, out: "0::/user.slice/user-1003.slice/user@1003.service/app.slice/dori-heavy-train-77-1.scope\n" },
  });
  const seen = new Set<number>();
  // When
  const running = () => true;
  const first = outsideLines(await sampleOutside(run), seen, running);
  const again = outsideLines(await sampleOutside(run), seen, running);
  // Then
  expect(first).toHaveLength(1);
  expect(first[0]).toStartWith("HOST_GUARD HEAVY_OUTSIDE gongdori pid 101: 40 min at 181% CPU outside dori heavy (python -m pytest qa/e7_demo); training, simulation and GPU tests go through dori heavy <label> --kind gpu");
  expect(again).toEqual([]);
  // a sample where it dipped under the threshold, then crossed back while still running: named no second time
  expect(outsideLines([], seen, running)).toEqual([]);
  expect(outsideLines(await sampleOutside(run), seen, running)).toEqual([]);
  // its process ended: forgotten
  expect(outsideLines([], seen, () => false)).toEqual([]);
  expect(seen.size).toBe(0);
});

test("on macOS memory_pressure still gives the free percentage", async () => {
  const s = await sampleHost(fake({ "memory_pressure -Q": { code: 0, out: "System-wide memory free percentage: 42%" } }), { backend: "herdr" });
  expect(s.memFreePct).toBe(42);
});

test("memory nobody can read is unknown: no memory reason, and the guard says unknown instead of a number", async () => {
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 1, out: "" } }), { backend: "herdr" });
  expect(s.memFreePct).toBeNull();
  expect(canLaunch(s, t).reasons.some((r) => r.startsWith("memory"))).toBe(false);
  expect(alertReasons(s, t).some((r) => r.startsWith("memory"))).toBe(false);
  const st = { alerting: true };
  // panes: 0, a counted session list: an unknown count (-1, the fake lists nothing) is its own alert since upstream #159.
  expect(guardTick({ ...s, diskFreeGb: 200, panes: 0 }, t, st)[0]).toContain("memory free unknown");
});

test("an unknown session count (-1) is an alert when a pane budget is set (upstream #159)", () => {
  const s = { load1: 1, memFreePct: 50, diskFreeGb: 300, swapFreeGb: 2, panes: -1 };
  expect(alertReasons(s, t)).toEqual(["session count unknown"]);
  expect(alertReasons(s, { ...t, panesMax: 0 })).toEqual([]);
});
