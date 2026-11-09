import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";

let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "hc-revive-readability-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = () => depsFor(world, fakeClock(0), dir, { backend: "herdr" });

test("revive waits for a readable shell before starting the agent", async () => {
  // Given: the restored shell is unreadable for its first two reads, then ready
  const deps = omo();
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  let reads = 0;
  const base = deps.run;
  const delayed: Runner = async (argv, o) => {
    if (argv[2] === "read") world.screens["w1:p1"] = ++reads < 3 ? "" : "omo\n────────\n❯ \n────────";
    if (argv[2] === "run") world.herdrDead = [];
    return base(argv, o);
  };
  // When / Then: the start happens only once the third read succeeds
  expect(await reviveHerdr(delayed, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555");
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(world.calls.findIndex((c) => c[2] === "run")).toBeGreaterThan(2);
});

test("revive refuses to start into a shell that never becomes readable", async () => {
  // Given: a pane that exists but whose screen never becomes readable
  const deps = omo();
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  world.screens["w1:p1"] = "";
  // When
  const line = await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true);
  // Then: a bounded refusal, and no start was sent
  expect(line).toContain("REVIVE_FAIL w1:p1");
  expect(line).toContain("readable");
  expect(world.calls.some((c) => c[2] === "run")).toBe(false);
});
