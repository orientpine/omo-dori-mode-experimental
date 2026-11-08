import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { migratePlan, migrateRefusal, moveLanes, writeRuntime } from "../src/migrate.ts";

// dori migrate (upstream #157's command, through the fork's own handovers): the plan it prints and runs, and the one
// config key it writes.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "migrate-"));
  dirs.push(d);
  return d;
};

test("the plan moves every open lane not on the target, skips the ones already there and the done ones, and leaves the lead to its own handover", () => {
  const lanes = [
    { key: "a", pane: "w1:p2", status: "working" },
    { key: "b", pane: "hc:t3", status: "working" },
    { key: "c", pane: "w1:p4", status: "done" },
    { key: "d", status: "working" },
  ];
  const plan = migratePlan(lanes, "w1:p1", "herdr", "hc");
  expect(plan.moving.map((l) => l.key)).toEqual(["a"]);
  expect(plan.lines).toEqual([
    "MIGRATE_PLAN config runtime herdr -> hc",
    "MIGRATE_PLAN lane a w1:p2 -> hc (lane handover)",
    "MIGRATE_SKIP lane b hc:t3 already on hc",
    "MIGRATE_PLAN lead w1:p1 -> hc (after the lanes: the lead's own dori handover, with its summary note)",
  ]);
});

test("a named lane is the only one moved, and an unknown name is refused", () => {
  const lanes = [{ key: "a", pane: "w1:p2", status: "working" }, { key: "e", pane: "w1:p5", status: "working" }];
  expect(migratePlan(lanes, "hc:t1", "hc", "hc", ["e"]).moving.map((l) => l.key)).toEqual(["e"]);
  expect(migratePlan(lanes, "hc:t1", "hc", "hc", ["e"]).lines.at(-1)).toBe("MIGRATE_SKIP lead hc:t1 already on hc");
  expect(() => migratePlan(lanes, "w1:p1", "herdr", "hc", ["zz"])).toThrow(/no open lane zz/);
});

test("writeRuntime backs the config up, sets only its runtime key, and the result loads", async () => {
  const d = scratch();
  const path = join(d, "config.json");
  const before = `${JSON.stringify({ stateDir: d, runtime: "herdr", leadPane: "w1:p1" }, null, 2)}\n`;
  writeFileSync(path, before);
  const backup = writeRuntime(path, "hc", "20261109T000000Z");
  expect(backup).toBe(`${path}.bak-migrate-20261109T000000Z`);
  expect(readFileSync(backup, "utf8")).toBe(before);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ stateDir: d, runtime: "hc", leadPane: "w1:p1" });
  expect((await loadConfig(path, d, () => {})).runtime).toBe("hc");
});

test("as upstream #157, a run names its scope (--lane K or --all), and a DORI_RUNTIME naming the other runtime is refused, since it would override the config the run writes", () => {
  expect(migrateRefusal("hc", {}, { all: false })).toMatch(/give --lane K or --all/);
  expect(migrateRefusal("hc", {}, { all: true, lane: "a" })).toMatch(/give --lane K or --all/);
  expect(migrateRefusal("hc", {}, { all: true })).toBeUndefined();
  expect(migrateRefusal("hc", {}, { all: false, lane: "a" })).toBeUndefined();
  expect(migrateRefusal("hc", { DORI_RUNTIME: "hc" }, { all: true })).toBeUndefined();
  expect(migrateRefusal("hc", { DORI_RUNTIME: "herdr" }, { all: true })).toMatch(/DORI_RUNTIME=herdr/);
  expect(migrateRefusal("herdr", { DORI_RUNTIME: "hc" }, { all: false, lane: "a" })).toMatch(/DORI_RUNTIME=hc/);
});

test("the lanes move one at a time through their handovers; the first that fails stops the run, the ones before it stay moved and the rest are not tried", async () => {
  const tried: string[] = [];
  const lines: string[] = [];
  const lanes = [{ key: "a", pane: "w1:p2" }, { key: "b", pane: "w1:p3" }, { key: "c", pane: "w1:p4" }];
  const code = await moveLanes(lanes, "herdr", "hc", async (key) => {
    tried.push(key);
    return key === "b" ? { code: 2, retry: true } : { code: 0 };
  }, (l) => void lines.push(l));
  expect(code).toBe(2);
  expect(tried).toEqual(["a", "b"]);
  expect(lines[0]).toBe("MIGRATE_LANE a w1:p2 -> hc");
  expect(lines.at(-1)).toMatch(/^MIGRATE_STOPPED lane b: its handover exited 2 \(busy: run dori migrate again once it is ready\).*dori migrate --to herdr/);
  const all: string[] = [];
  expect(await moveLanes(lanes, "herdr", "hc", async (key) => {
    all.push(key);
    return { code: 0 };
  }, () => {})).toBe(0);
  expect(all).toEqual(["a", "b", "c"]);
});

test("writeRuntime refuses a config it cannot read as JSON and writes nothing", () => {
  const d = scratch();
  const path = join(d, "config.json");
  writeFileSync(path, "{ not json");
  expect(() => writeRuntime(path, "hc", "s")).toThrow(/config/);
  expect(readFileSync(path, "utf8")).toBe("{ not json");
  expect(existsSync(`${path}.bak-migrate-s`)).toBe(false);
});
