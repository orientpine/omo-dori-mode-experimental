import { expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { alertReasons, guardTick, sampleHost } from "../src/host-guard.ts";
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
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 0, out: meminfo } }), "herdr");
  expect(s.memFreePct).toBe(15);
  expect(canLaunch(s, t).reasons).toContain("memory free 15% < 20%");
  expect(alertReasons(s, t)).toContain("memory free 15% < 20%");
});

test("on macOS memory_pressure still gives the free percentage", async () => {
  const s = await sampleHost(fake({ "memory_pressure -Q": { code: 0, out: "System-wide memory free percentage: 42%" } }), "herdr");
  expect(s.memFreePct).toBe(42);
});

test("memory nobody can read is unknown: no memory reason, and the guard says unknown instead of a number", async () => {
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 1, out: "" } }), "herdr");
  expect(s.memFreePct).toBeNull();
  expect(canLaunch(s, t).reasons.some((r) => r.startsWith("memory"))).toBe(false);
  expect(alertReasons(s, t).some((r) => r.startsWith("memory"))).toBe(false);
  const st = { alerting: true };
  expect(guardTick({ ...s, diskFreeGb: 200 }, t, st)[0]).toContain("memory free unknown");
});
