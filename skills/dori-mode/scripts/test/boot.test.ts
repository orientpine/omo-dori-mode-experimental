import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { ChosenRuntimes, runtimesOf } from "../src/run.ts";
import { bootDeps, launched, lane, manifest, newWorld, snapshot, T0 } from "./boot-fixtures.ts";
import { withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());
const depsFor = (world: World, slack?: () => Promise<{ userId: string; teamId: string } | null>) => bootDeps(world, state.dir, slack);

test("boot prints the selected runtime before every other check", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }];
  const deps = depsFor(world);
  const rts = new ChosenRuntimes(() => ({ kind: "herdr", source: "default" }), () => deps.rts.default);
  await deps.registry.write(lane("leftover", "closed", "w2:p2"));
  expect((await bootCheck({ ...deps, rts })).lines[0]).toBe("RUNTIME herdr (from default)");
});

test("an unavailable runtime prints its fix and fails boot before any other check", async () => {
  const deps = depsFor(newWorld());
  const rts = new ChosenRuntimes(() => { throw new Error("no usable runtime: set DORI_RUNTIME=herdr or hc, or make one available on PATH"); }, () => { throw new Error("unused"); });
  const result = await bootCheck({ ...deps, rts });
  expect(result.exitCode).toBe(1);
  expect(result.lines).toEqual([
    "RUNTIME unavailable: no usable runtime: set DORI_RUNTIME=herdr or hc, or make one available on PATH",
    "BOOT incomplete read-only; nothing restarted, written or stopped",
  ]);
});

test("boot reports vanished panes, journals and stale watches, and writes nothing", async () => {
  // Given a lane whose pane vanished, a live lane, a closed lane with a watch, and a halted journal.
  const world = newWorld();
  world.herdrGone = ["w1:p8"];
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }];
  const deps = depsFor(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  for (const l of [launched("api-release", "working", "w1:p8"), lane("live", "working", "w2:p2"), lane("closed", "closed")]) await deps.registry.write(l);
  deps.reports.report("api-release", "halted", "work pushed, waiting for the owner", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_REALFIXTURE" }]).data));
  const before = snapshot(state.dir);
  // When boot runs; then every finding is printed, the exit is clean, and no file changed.
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("DRIFT n=1 api-release");
  expect(result.lines).toContain("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(result.lines).toContain("VANISHED api-release pane=w1:p8 status=working; registry and worktrees preserved; no relaunch");
  expect(result.lines).toContain("UNREGISTERED w2:p1");
  expect(result.lines).toContain("REPORT api-release kind=halted at=2026-01-01T12:00:00.000Z state=halted registryStatus=working");
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_REALFIXTURE"})');
  expect(result.lines.some((l) => l.startsWith("VANISHED closed"))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
  expect(world.calls.every((c) => c[0] === "herdr" && c[1] === "pane" && ["list", "get"].includes(c[2] ?? ""))).toBe(true);
});

test("boot on a state dir with no lanes directory leaves it byte-identical", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  writeFileSync(join(state.dir, "messenger.json"), "{}");
  const before = snapshot(state.dir);
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a closed lane owns no pane, so a pane left behind by a failed close is unregistered", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }, { pane_id: "w2:p3", workspace_id: "w2" }];
  const deps = depsFor(world);
  await deps.registry.write(lane("gone", "closed", "w2:p3"));
  await deps.registry.write(lane("current", "working", "w2:p2"));
  const result = await bootCheck(deps);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=1 vanished=0 unregistered=2");
  expect(result.lines).toContain("UNREGISTERED w2:p1 w2:p3");
});

test("an unreadable lane file is named and the other lanes are still checked", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  await deps.registry.write(lane("healthy", "working", "w1:p99"));
  writeFileSync(deps.registry.path("broken"), "{partial");
  writeFileSync(deps.registry.path("null-record"), "null");
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("broken")}`);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("null-record")}`);
  expect(result.lines).toContain("VANISHED healthy pane=w1:p99 status=working; registry and worktrees preserved; no relaunch");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a lanes path that cannot be listed is named and the rest of boot still runs", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  writeFileSync(join(state.dir, "lanes"), "not a directory");
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${join(state.dir, "lanes")}`);
  expect(result.lines.some((l) => l.startsWith("MONITORS cleanupCandidates="))).toBe(true);
  expect(result.exitCode).toBe(1);
});

test("a journal done lane counts as finished for vanished lanes and watch cleanup alike", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  await deps.registry.write(launched("old-api", "working", "w1:p8"));
  deps.reports.report("old-api", "done", "merged", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch old-api", monitorId: "mon_OLD" }]).data));
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("VANISHED old-api"))).toBe(false);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_OLD"})');
  expect(result.exitCode).toBe(0);
});

test("a verified-done lane whose pane is gone is not flagged VANISHED", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const deps = depsFor(world);
  await deps.registry.write(lane("verified", "verified-done", "w1:p7"));
  await deps.registry.write(lane("working", "working", "w1:p8"));
  const result = await bootCheck(deps);
  expect(result.lines.filter((l) => l.startsWith("VANISHED"))).toEqual(["VANISHED working pane=w1:p8 status=working; registry and worktrees preserved; no relaunch"]);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=0 vanished=1 unregistered=1");
});

test("a failed pane list stays unknown instead of declaring every lane vanished", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  await deps.registry.write(lane("active"));
  const failing = { ...deps, run: async () => ({ code: 1, out: "", err: "server not running" }) };
  const result = await bootCheck({ ...failing, rts: runtimesOf(failing.run, { runtime: failing.config.runtime }) });
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("PANES unavailable (session list failed)");
  expect(result.lines.some((line) => line.startsWith("VANISHED"))).toBe(false);
});
