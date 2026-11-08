import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canScope, gpuRoomPlan, makeGpuRoom, memVerdict, neverFits, parseMem, parseRoomInfo, spawnScoped } from "../src/heavy-mem.ts";
import { linesOf } from "../src/heavy-queue.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(30_000); // load-proof: the tests here start systemd-run, systemctl and a memory-touching helper as child processes; a loaded host (40-67 on 20 cores) slows them several times over, so this file, not the suite, gets 30 s

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const CLI = join(import.meta.dir, "../src/cli.ts");
const ownCgroup = (): string => readFileSync("/proc/self/cgroup", "utf8").trim();

test("a heavy command over its MemoryMax is killed alone in its own scope and the process that started it keeps running", async () => {
  const no = await canScope();
  // the caller may itself run in a dori-heavy scope (a lane runs big test bundles through dori heavy): what must hold
  // is that the jobs never move it, so its cgroup is read now and compared at the end
  const before = ownCgroup();
  const logs: string[] = [];
  const out = join(state.dir, "cgroup");
  // the job's cgroup is its own, not the caller's (2026-10-30: a lane's job shared the lane's aoe-session scope)
  expect(await spawnScoped({ label: "where", cmd: ["sh", "-c", `cat /proc/self/cgroup > ${out}`], free: 10, log: (l) => logs.push(l) }, { stdin: "ignore", stdout: "ignore", stderr: "inherit" })).toBe(0);
  if (no) {
    // a host without a systemd user manager (macOS) runs the job as before and says so
    expect(logs).toEqual([expect.stringMatching(/^HEAVY_NO_SCOPE where: /)]);
    return;
  }
  expect(readFileSync(out, "utf8")).toMatch(/dori-heavy-where-\d+-\d+\.scope/);
  expect(readFileSync(out, "utf8").trim()).not.toBe(ownCgroup());
  // 600M held in memory (tail keeps a line without a newline) against a 200M cap
  logs.length = 0;
  const code = await spawnScoped({ label: "oom", cmd: ["sh", "-c", "head -c 600M /dev/zero | tail -n 1 > /dev/null"], free: 10, needBytes: 200 * 1024 ** 2, log: (l) => logs.push(l) }, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  expect(code).not.toBe(0);
  expect(logs[0]).toMatch(/^HEAVY_SCOPE oom dori-heavy-oom-\d+-\d+\.scope MemoryMax=200M \(its --mem\)$/);
  expect(logs[1]).toMatch(/^HEAVY_OOM oom: killed at MemoryMax=200M in dori-heavy-oom-\d+-\d+\.scope \(exit \d+\); only the job stopped/);
  expect(ownCgroup()).toBe(before);
});

test("two jobs with one label in one process each get their own scope, while the first still runs", async () => {
  // 2026-11-02: the scope was named <label>-<pid>, so a second job of one label in one process (a job sent back from a
  // helper, two jobs of a queue host's test) met the first one's scope still loaded and systemd-run refused it (exit 1)
  const fifo = join(state.dir, "fifo");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  let started: (out: ReadableStream<Uint8Array>) => void = () => {};
  const stdout = new Promise<ReadableStream<Uint8Array>>((r) => (started = r));
  // the first job says it runs (inside its scope, so the scope is loaded), then waits on the fifo
  const first = spawnScoped({ label: "same", cmd: ["sh", "-c", `echo up; cat ${fifo} > /dev/null`], free: 10 }, { stdin: "ignore", stdout: "pipe", stderr: "inherit" }, (_, p) => started(p.stdout as ReadableStream<Uint8Array>));
  expect((await linesOf(await stdout).next()).value).toBe("up");
  const second = await spawnScoped({ label: "same", cmd: ["sh", "-c", `echo go > ${fifo}`], free: 10 }, { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  // a refused second job never opened the fifo: open it here so the first one ends either way
  if (second !== 0) writeFileSync(fifo, "go\n");
  expect(second).toBe(0);
  expect(await first).toBe(0);
});

test("dori heavy refuses at once a --mem that never fits on the host and a size it cannot read", async () => {
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyHoldDir: join(state.dir, "hold") }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, "heavy", ...args], { env: { ...own, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const huge = await run("huge", "--mem", "999T", "--", "true");
  expect(huge.code).toBe(2);
  expect(huge.err).toContain("HEAVY_REFUSED huge: --mem 999.0T never fits here");
  const bad = await run("bad", "--mem", "lots", "--", "true");
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain('dori heavy --mem takes a size like 70G or 200M, not "lots"');
});

test("memory sizes read as bytes and a fit keeps the free share", () => {
  expect(parseMem("70G")).toBe(70 * 1024 ** 3);
  expect(parseMem("200M")).toBe(200 * 1024 ** 2);
  expect(parseMem("1.5g")).toBe(1.5 * 1024 ** 3);
  expect(parseMem("lots")).toBeUndefined();
  const host = { totalKb: 100_000_000, availKb: 60_000_000 };
  expect(neverFits(95 * 1024 ** 3, host, 10)).toContain("never fits");
  expect(neverFits(80 * 1024 ** 3, host, 10)).toBeUndefined();
  expect(memVerdict(host, 50_000_000, 0, 10).ok).toBe(true);
  expect(memVerdict(host, 50_000_001, 0, 10).ok).toBe(false);
});

test("before a GPU job page cache is pushed out only when free memory is short, and never under the heavy headroom floor", () => {
  // the host at 2026-11-02 20:33 KST, when the owner's voice note failed in ggml_cuda_init: MemFree 1G, MemAvailable 95G of 121G
  const host = { totalKb: 127539392, availKb: 100103936, freeKb: 1024 ** 2 };
  const want = 20 * 1024 ** 2;
  expect(gpuRoomPlan(host, want, 10)).toMatchObject({ make: true, wantKb: want, budgetKb: want, floorKb: 12753940 });
  expect(gpuRoomPlan({ ...host, freeKb: 24 * 1024 ** 2 }, want, 10)).toEqual({ make: false, why: "24.0G free, 20.0G wanted from under 20.0G" });
  // dori heavy acts only under a quarter of what it wants: touching eats free memory before any cache goes
  expect(gpuRoomPlan({ ...host, freeKb: 6 * 1024 ** 2 }, want, 10, want / 4)).toMatchObject({ make: false });
  expect(gpuRoomPlan({ ...host, freeKb: 4 * 1024 ** 2 }, want, 10, want / 4)).toMatchObject({ make: true, wantKb: want, budgetKb: want });
  // 3G available over the 10% floor: no more than that is touched
  expect(gpuRoomPlan({ ...host, availKb: 12753940 + 3 * 1024 ** 2 }, want, 10)).toMatchObject({ make: true, budgetKb: 3 * 1024 ** 2 });
  expect(gpuRoomPlan({ ...host, availKb: 12_000_000 }, want, 10)).toMatchObject({ make: false, why: expect.stringMatching(/^short: 1.0G free and 11.4G available, no room above the 10% floor$/) });
});

test("the room maker touches memory up to its budget and lets it go, and touches none when that would cross the floor", async () => {
  // the stop checks read fixed files, not the host's memory that moment: on 0a83 (2026-11-09, 52G free) free memory rose
  // past the wanted mark after the test read it, and the floor case stopped at enough. The helper still touches real
  // memory (512M at most here), only what it reads to decide stays put, so every run ends the same way.
  const proc = { meminfo: join(state.dir, "meminfo"), buddyinfo: join(state.dir, "buddyinfo") };
  writeFileSync(proc.meminfo, "MemTotal:       127539392 kB\nMemFree:        41943040 kB\nMemAvailable:   62914560 kB\nSwapFree:        6291456 kB\n");
  // 10 free blocks of order 9 (2M) and 20 of order 10 (4M): 100M in 2M+ blocks
  writeFileSync(proc.buddyinfo, "Node 0, zone   Normal      1      1      1      1      1      1      1      1      1     10     20\n");
  const m = parseRoomInfo(readFileSync(proc.meminfo, "utf8"))!;
  const room = (wantKb: number, budgetKb: number, floorKb: number) => makeGpuRoom({ make: true, wantKb, budgetKb, floorKb, why: "" }, "test", proc);
  const line = (pushed: number, stop: string) => expect.stringMatching(new RegExp(`^pushed ${pushed}M of cache out in [\\d.]+s \\(stop: ${stop}\\): free 40960M -> 40960M, in 2M\\+ blocks 100M -> 100M$`));
  // 300M more free wanted, 512M may be touched: two 256M chunks reach it
  expect(await room(m.freeKb + 300 * 1024, 512 * 1024, 0)).toEqual({ ok: true, line: line(512, "enough") });
  // 2G more wanted, 512M may be touched: the budget stops it
  expect(await room(m.freeKb + 2 * 1024 ** 2, 512 * 1024, 0)).toEqual({ ok: true, line: line(512, "budget") });
  // available is already under the floor: nothing touched
  expect(await room(m.freeKb + 1024 ** 2, 1024 ** 2, m.availKb + 1024 ** 2)).toEqual({ ok: true, line: line(0, "floor") });
  // a --mem of 70.1G makes fractional kB; the helper still runs (it stops at the floor here, touching nothing)
  expect(await room(m.freeKb + 73_505_996.8, 1024 ** 2 + 0.6, m.availKb + 1024 ** 2 + 0.4)).toEqual({ ok: true, line: line(0, "floor") });
  // without files it reads the host's own /proc: it runs and says why it stopped, whatever that is today
  const host = parseRoomInfo(readFileSync("/proc/meminfo", "utf8"))!;
  const real = await makeGpuRoom({ make: true, wantKb: host.freeKb + 300 * 1024, budgetKb: 512 * 1024, floorKb: 0, why: "" }, "test");
  expect(real).toMatchObject({ ok: true, line: expect.stringMatching(/^pushed (0|256|512)M of cache out in [\d.]+s \(stop: (enough|budget|swap)\): free \d+M -> \d+M, in 2M\+ blocks \d+M -> \d+M$/) });
});

test("dori gpu-room reads --want as a size and refuses one it cannot read", async () => {
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyHoldDir: join(state.dir, "hold") }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, "gpu-room", ...args], { env: { ...own, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const bad = await run("--want", "lots");
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain('dori gpu-room --want takes a size like 20G, not "lots"');
  // 1K is always free: nothing to do, nothing said (read as the 20G default it would push cache out)
  const small = await run("--want", "1K");
  expect({ code: small.code, room: small.err.includes("HEAVY_GPU_ROOM") }).toEqual({ code: 0, room: false });
});
