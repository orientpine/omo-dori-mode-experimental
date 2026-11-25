import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { loadConfig } from "../src/config.ts";
import { acquire, admitOnce, type SlotDeps } from "../src/heavy-slot.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const GiB = 1024 ** 2;
const now = Date.parse("2026-11-25T09:00:00Z");
const sample = (available: number, load1: number | null = 2) => ({
  load1,
  memory: { totalKb: 20 * GiB, availKb: available * GiB },
});

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const depsFor = (host = async () => sample(8), elapsedMs = () => 0) => ({
  dir: join(state.dir, "heavy"),
  slots: 4,
  maxLoad: 10,
  pid: 7,
  alive: (pid: number) => Number.isInteger(pid) && pid !== 55,
  load: async () => 2,
  clock: { now: () => now, sleep: async () => {} },
  dynamic: { minSlots: 0, maxSlots: 4, jobMemKb: 4 * GiB, memFreeMinPct: 20, sample: host, elapsedMs },
} satisfies SlotDeps);

const owner = (dir: string, n: number, value: string): void => {
  const slot = join(dir, `slot.${n}`);
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "owner"), value);
};

test("a job fits at the exact memory floor and its reservation blocks the next job", async () => {
  const deps = depsFor();
  expect(await admitOnce(deps, "first")).toMatchObject({ slot: join(deps.dir, "slot.1") });
  expect(await admitOnce(deps, "second")).toMatchObject({ wait: "memory", why: expect.stringContaining("limit 1 of 0-4") });
});

test.each([
  ["load", async () => sample(19, null)],
  ["memory", async () => ({ ...sample(19), memory: null })],
] as const)("unknown %s admits only the configured floor", async (name, host) => {
  const deps = depsFor();
  const dynamic = { ...deps.dynamic, minSlots: 1, sample: host };
  expect(await admitOnce({ ...deps, dynamic }, "floor")).toHaveProperty("slot");
  const result = await admitOnce({ ...deps, dynamic }, "above-floor");
  expect(result).toMatchObject({ why: expect.stringContaining(`${name} unknown`) });
  expect(result).not.toHaveProperty("slot");
});

test("load at the cutoff prevents new admissions above the floor", async () => {
  const deps = depsFor(async () => sample(19, 10));
  expect(await admitOnce(deps, "loaded")).toMatchObject({ wait: "load", why: expect.stringContaining("limit 0 of 0-4") });
});

test("a slow optimistic sample cannot admit if the fresh sample says memory is short", async () => {
  let time = 0;
  const deps = depsFor(async () => {
    if (time > 0) return sample(7.99);
    time = 1_001;
    return sample(19);
  }, () => time);
  expect(await admitOnce(deps, "resampled")).toMatchObject({ wait: "memory", why: expect.stringContaining("limit 0 of 0-4") });
});

test("three stale samples use unknown readings rather than the optimistic sample", async () => {
  let time = 0;
  const deps = depsFor(async () => { time += 1_001; return sample(19); }, () => time);
  expect(await admitOnce(deps, "stale")).toMatchObject({ why: expect.stringContaining("load unknown") });
  expect(time).toBe(3_003);
});

test("an indeterminate owner stays held and a confirmed-dead owner is replaced", async () => {
  const deps = depsFor(async () => sample(19));
  mkdirSync(join(deps.dir, "slot.1", "owner"), { recursive: true });
  utimesSync(join(deps.dir, "slot.1"), 1, 1);
  owner(deps.dir, 2, `55 dead job ${new Date(now).toISOString()}\n`);
  const result = await admitOnce(deps, "replacement");
  expect(result).toMatchObject({ slot: join(deps.dir, "slot.2") });
  expect(readFileSync(join(deps.dir, "slot.2", "owner"), "utf8")).toContain("replacement");
});

test("a held kernel flock blocks admission; after release the waiter uses current memory", async () => {
  let available = 19;
  const deps = depsFor(async () => sample(available));
  mkdirSync(deps.dir, { recursive: true });
  const unlock = takeLock(join(deps.dir, "admit.flock"), now, "heavy admission", deps.dir);
  try {
    expect(await admitOnce(deps, "contender")).toBeNull();
    available = 7;
  } finally {
    unlock();
  }
  expect(await admitOnce(deps, "contender")).toMatchObject({ wait: "memory" });
});

test.each([
  { heavyJobMemGb: "4" },
  { heavyJobMemGb: 4, heavyMinSlots: 3, heavyMaxSlots: 2 },
  { heavyJobMemGb: 4, heavyMinSlots: 0.5 },
])("dynamic config rejects an invalid estimate or slot range: %j", async (given) => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify(given));
  await expect(loadConfig(path)).rejects.toThrow(/heavyJobMemGb|heavyMinSlots/);
});

test("heavy status displays the enabled limit and a held owner's full label", async () => {
  const path = join(state.dir, "config.json");
  const dir = join(state.dir, "heavy");
  owner(dir, 1, `${process.pid} browser suite ${new Date().toISOString()}\n`);
  await Bun.write(path, JSON.stringify({ heavyJobMemGb: 4, heavyMinSlots: 2, heavyMaxSlots: 2 }));
  const result = await run(["env", `DORI_CONFIG=${path}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "no.env")}`, process.execPath, join(import.meta.dir, "../src/cli.ts"), "heavy", "--status"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("HEAVY OPEN limit 2 of 2-2");
  expect(result.out).toContain(`HEAVY_SLOT slot.1 browser suite pid ${process.pid}`);
});

test("dynamic full waits name the blocking slot holder before routing elsewhere", async () => {
  const deps = depsFor(async () => sample(19));
  owner(deps.dir, 1, `42 browser suite ${new Date(now).toISOString()}\n`);
  const logs: string[] = [];
  const got = await acquire({ ...deps, dynamic: { ...deps.dynamic, maxSlots: 1 }, log: (line) => logs.push(line) }, "next", {
    elsewhere: async () => "helper",
  });
  expect(got).toEqual({ elsewhere: "helper" });
  expect(logs).toEqual([expect.stringMatching(/^HEAVY_WAIT next: .*slot\.1 browser suite pid 42/)]);
});
