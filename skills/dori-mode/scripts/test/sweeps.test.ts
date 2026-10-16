import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultDiscordWords } from "../src/config.ts";
import { deadPaneTick } from "../src/dead-panes.ts";
import { claimDone } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { parseGpuQuery, parsePmon, treeOf, type Usage } from "../src/heavy-headroom.ts";
import { acquireSlot, releaseSlot, type SlotDeps } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import { adoptLane, LaunchError } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import type { Clock } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lane silent past the nudge time is nudged once, then its last report is posted for it", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n❯ ";
  expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const posted = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(posted.map((a) => a.kind)).toEqual(["posted"]);
  const call = world.calls.find((c) => c[0] === "notify");
  expect(call?.[1]).toBe("chat:team/9");
  expect(call?.[2]).toBe("Still working on it. The last report came 21 min ago; I'll sum it up for you soon.");
  // one nudge to the lane, one note to the lead carrying the report
  expect(sent(world)).toHaveLength(2);
});

test("a report the lane sent to the lead pane is found there, wrapped lines joined, and a new report resets the silence", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = "working on it\n❯ ";
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first step done\n\n [REPORT] other-lane | done | not ours\n [REPORT] quiet-lane | blocker | CI is red on the\n flaky e2e job, rerunning\n\n❯ ";
  expect(await freshnessTick(deps(T0 + 14 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 28 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const later = await freshnessTick(deps(T0 + 35 * MIN), "/home/test");
  expect(later.map((a) => a.kind)).toEqual(["nudged", "posted"]);
  // the owner's thread gets a plain status line in the configured words; the raw report goes to the lead pane
  expect(world.calls.find((c) => c[0] === "notify")?.[2]).toBe("Still working on it. The last report came 21 min ago; I'll sum it up for you soon.");
  const toLead = world.calls.find((c) => c[0] === "herdr" && c[2] === "send-text" && c[3] === "lead:p1")?.[4];
  expect(toLead).toContain("[DORI] quiet-lane: 21 min without a new report");
  expect(toLead).toContain("Last report: [REPORT] quiet-lane | blocker | CI is red on the flaky e2e job, rerunning");
  expect(later[1]?.detail).toEndWith("; lead told");
});

test("quietText is the configured words, and postRawReports posts the lane's report as before without telling the lead", async () => {
  const korean = { ...defaultDiscordWords, quietText: "진행 중이야 — 마지막 보고는 {min}분 전. 정리해서 곧 알려 줄게." };
  await depsFor(world, fakeClock(T0), state.dir).registry.write(working);
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | (a) 승인 조건대로 ① `bun test` green, $(x) gone\n\n❯ ";
  const ko = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] }, discord: korean });
  await freshnessTick(ko(T0 + MIN), "/home/test");
  await freshnessTick(ko(T0 + 22 * MIN), "/home/test");
  expect(world.calls.find((c) => c[0] === "notify")?.[2]).toBe("진행 중이야 — 마지막 보고는 21분 전. 정리해서 곧 알려 줄게.");
  // a report with a backtick or $( still reaches the lead, defused, instead of failing the sweep
  expect(sent(world).find((t) => t.startsWith("[DORI] quiet-lane"))).toContain("① 'bun test' green, $ (x) gone");

  world.calls = [];
  await depsFor(world, fakeClock(T0), state.dir).registry.write({ ...working, key: "raw-lane" });
  world.screens["lead:p1"] = " [REPORT] raw-lane | milestone | tests green on /home/test/repo, PR open\n\n❯ ";
  const raw = { hooks: { threadReply: ["notify", "{thread}", "{text}"] }, discord: { ...defaultDiscordWords, postRawReports: true } };
  await freshnessTick(depsFor(world, fakeClock(T0 + MIN), state.dir, raw), "/home/test");
  await freshnessTick(depsFor(world, fakeClock(T0 + 22 * MIN), state.dir, raw), "/home/test");
  expect(world.calls.filter((c) => c[0] === "notify").map((c) => c[2])).toContain("Progress (from the lane's last report): tests green on ~/repo, PR open");
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "send-text" && c[3] === "lead:p1")).toBe(false);
});

test("a done claim written while a sweep is nudging the lane survives the sweep's own registry write", async () => {
  const base = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await base.registry.write(working);
  const run: typeof base.run = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "send-text") await claimDone({ ...base, run: async () => ({ code: 0, out: "❯ ", err: "" }) }, working, "merged acme/app#1");
    return base.run(argv, opts);
  };
  expect((await freshnessTick({ ...base, run }, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  const after = await base.registry.read("quiet-lane");
  expect(after?.status).toBe("done-claimed");
  expect(after?.lastNudgeAt).toBe(T0 + 16 * MIN);
});

test("a nudge that never reaches the lane's pane is reported as failed, not as sent", async () => {
  const deps = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await deps.registry.write(working);
  world.screens["w:p7"] = "❯ [LEAD] your work thread has had no update";
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudge-failed"]);
});

test("a stopped agent pane is reported once per hour and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12")).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12")).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13")).toEqual(["DEAD_PANE w:p1"]);
});

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

const heldSlot = (dir: string, n: number, pid: number, since: number) => {
  mkdirSync(join(dir, `slot.${n}`), { recursive: true });
  writeFileSync(join(dir, `slot.${n}`, "owner"), `${pid} running eval ${new Date(since).toISOString()}`);
};
const eval25: Usage = { gpu: 25, gpuMem: null, cpu: 10, mem: 10 };
const headroomDeps = (dir: string, host: () => Usage, logs: string[], clock: Clock = fakeClock(T0)): SlotDeps & { calls: number } => {
  const d = {
    dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => 10, alive: (pid: number) => pid !== 999999, calls: 0,
    headroom: { maxSlots: 4, free: 30, settleSec: 120, usage: async (pids: readonly number[]) => { d.calls++; return { host: host(), unified: true, jobs: pids.map(() => eval25) }; } },
    log: (l: string) => logs.push(l),
  };
  return d;
};
const stopAfter = (n: number) => { let polls = 0; return { now: () => T0, sleep: async () => { if (++polls >= n) throw new Error("stop"); } }; };

test("a heavy job starts beside a running one when every resource keeps 30% free with it, and waits when one would not", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const logs: string[] = [];
  const slot = await acquireSlot(headroomDeps(dir, () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 }), logs), "eval-b");
  expect(slot).toBe(join(dir, "slot.2"));
  expect(logs).toEqual(["HEAVY_ADMIT eval-b slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  heldSlot(dir, 2, 101, T0 - 10 * MIN);
  const waits: string[] = [];
  const busy = headroomDeps(dir, () => ({ gpu: 46, gpuMem: null, cpu: 20, mem: 25 }), waits, stopAfter(3));
  await expect(acquireSlot(busy, "eval-c", 1)).rejects.toThrow("stop");
  expect(waits).toEqual(["HEAVY_WAIT eval-c: 2 running; gpu 46%+25% -> 29% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  expect(busy.calls).toBe(3);
});

test("a heavy job waits while the last one taken has not shown its load, and two waiters never take one headroom twice", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 30_000);
  const logs: string[] = [];
  const settling = headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), logs, stopAfter(2));
  await expect(acquireSlot(settling, "eval-b", 1)).rejects.toThrow("stop");
  expect(logs).toEqual(["HEAVY_WAIT eval-b: slot.1 was taken 30s ago; its load shows after 120s"]);
  expect(settling.calls).toBe(0);
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const both: string[] = [];
  const a = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(3)), "eval-b", 1);
  const b = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(3)), "eval-c", 1);
  const got = await Promise.allSettled([a, b]);
  expect(got.filter((g) => g.status === "fulfilled").length).toBe(1);
  expect(both.filter((l) => l.startsWith("HEAVY_ADMIT")).length).toBe(1);
  expect(both.some((l) => /^HEAVY_WAIT eval-[bc]: slot\.2 was taken 0s ago/.test(l))).toBe(true);
});

test("GPU, per-process and process-tree readings parse as nvidia-smi and ps print them on a GB10", () => {
  expect(parseGpuQuery("77, [N/A], [N/A]")).toEqual({ util: 77, memUsedMib: null, memTotalMib: null });
  expect(parseGpuQuery("40, 8000, 16000\n60, 4000, 16000")).toEqual({ util: 50, memUsedMib: 12000, memTotalMib: 32000 });
  const pmon = [
    "# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command ",
    "# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name ",
    "    0       3292     G      -      -      -      -      -      -     18      0    Xorg           ",
    "    0    1977792     C     34      0      -      -      -      -    289      0    python         ",
  ].join("\n");
  expect(parsePmon(pmon).get(1977792)).toEqual({ sm: 34, fbMib: 289 });
  expect(parsePmon(pmon).get(3292)).toEqual({ sm: 0, fbMib: 18 });
  const t = treeOf("   10     1  100  0.0\n   11    10 2000 100\n   12    11  500 50.5\n   13     1  900 99", 10);
  expect(t.pids.sort()).toEqual([10, 11, 12]);
  expect(t.rssKb).toBe(2600);
  expect(t.cpuPct).toBe(150.5);
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" })).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" });
  expect(ok.thread).toBe("none");
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).rejects.toThrow("already registered");
});

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({ result: { process_info: { shell_pid: 10 } } });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("herdr pane process-info")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" }, { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" }];
  const flagged = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  expect((await resolveSession("w:p1", "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect((await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww -o command= -p 12": "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }), sessionsDir: "/s" })).id).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => ["2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl", "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl"];
  const byStart = await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }), sessionsDir: "/s", listDir });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});
