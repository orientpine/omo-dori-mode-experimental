import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { heavyBypassTick } from "../src/freshness-heavy.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const fixture = async () => {
  const state = withState();
  const world = newWorld();
  const deps = depsFor(world, fakeClock(Date.now()), state.dir);
  const lane: Lane = { key: "training", title: "training", pane: "w:p7", thread: "none", brief: "/b.md", done: "manual", openedAt: new Date().toISOString(), status: "paused" };
  await deps.registry.write(lane);
  const probe = { gpu: "4200, 100 MiB\n4200, [N/A]", code: 0, ps: "4000 1 0 0\n4100 4000 0 0\n4200 4100 1 1", env: "", cgroup: "", calls: [] as string[][] };
  const run: Runner = async (argv, opts) => {
    probe.calls.push([...argv]);
    if (argv[0] === "nvidia-smi") return { code: probe.code, out: probe.gpu, err: "" };
    if (argv[0] === "ps") return { code: 0, out: probe.ps, err: "" };
    if (argv[0] === "cat" && argv[1]?.startsWith("/proc/")) return { code: 0, out: argv[1].endsWith("/environ") ? probe.env : probe.cgroup, err: "" };
    return deps.run(argv, opts);
  };
  return { state, probe, deps: { ...deps, run } };
};

test("freshness succeeds and warns on stderr and watch log once per lane/pid across ticks", async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain("HEAVY_BYPASS training: pid 4200");
    expect(line).toContain("directive spread-load; a warning until 2026-12-01, then it refuses");
    expect(readFileSync(f.deps.config.watchLog, "utf8")).toContain(`freshness ${line}`);
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(f.state.dir, "heavy-bypass-seen.json"), "utf8"))).toEqual(["training:4200"]);
    expect(f.probe.calls.some((c) => c.includes("send-text") || c[0] === "kill")).toBe(false);
  } finally { stderr.mockRestore(); f.state.done(); }
});

for (const kind of ["empty", "unrelated", "gone", "missing", "unsupported", "malformed"] as const) test(`clean ${kind} GPU query emits nothing`, async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    if (kind === "empty") f.probe.gpu = "";
    if (kind === "unrelated") f.probe.gpu = "9999, 100 MiB";
    if (kind === "gone") f.probe.ps = "4000 1 0 0";
    if (kind === "missing") f.probe.code = 127;
    if (kind === "unsupported") f.probe.code = 1;
    if (kind === "malformed") f.probe.gpu = "pid, used_memory\nbogus\n0, 10\n1, 10";
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(join(f.state.dir, "heavy-bypass-seen.json"))).toBe(false);
  } finally { stderr.mockRestore(); f.state.done(); }
});

for (const kind of ["scope", "service", "env", "slot", "slot-tree"] as const) test(`heavy ${kind} process trees are exempt`, async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    if (kind === "scope" || kind === "service") f.probe.cgroup = `0::/user.slice/dori-heavy-test-10-1.${kind}\n`;
    if (kind === "env") f.probe.env = "OTHER=1\0DORI_HEAVY_JOB=training\0";
    if (kind === "slot" || kind === "slot-tree") {
      const slot = join(f.state.dir, "heavy", "slot.1");
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, "owner"), `${process.pid} training ${new Date().toISOString()}`);
      if (kind === "slot-tree") writeFileSync(join(slot, "tree"), "4100");
      else f.probe.ps = `4000 1 0 0\n${process.pid} 4000 0 0\n4200 ${process.pid} 0 0`;
    }
    await heavyBypassTick(f.deps);
    expect(stderr).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); f.state.done(); }
});

test("a stale slot cannot hide a bypass, and a new pid gets its own warning", async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    const slot = join(f.state.dir, "heavy", "slot.1");
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "owner"), "2147483647 stale 2026-01-01T00:00:00Z");
    writeFileSync(join(slot, "tree"), "4100");
    await heavyBypassTick(f.deps);
    f.probe.ps += "\n4201 4100 1 1";
    f.probe.gpu = "4201, [N/A]";
    await heavyBypassTick(f.deps);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(String(stderr.mock.calls[1]?.[0])).toContain("pid 4201");
  } finally { stderr.mockRestore(); f.state.done(); }
});
