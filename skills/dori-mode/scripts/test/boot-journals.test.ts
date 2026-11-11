import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { objectDone, reopenClaim } from "../src/done-flow.ts";
import { bootDeps, launched, lane, manifest, newWorld, T0 } from "./boot-fixtures.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a corrupt journal is reported for its lane and does not stop the check", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(launched("broken"));
  deps.reports.report("broken", "milestone", "started", T0);
  writeFileSync(deps.reports.path("broken"), `${readFileSync(deps.reports.path("broken"), "utf8")}{partial\n`);
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR broken kind=invalid-journal");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("the launch's activity record is not a report: a lane that never reported reads NO-REPORT", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(launched("quiet"));
  deps.reports.append({ type: "activity", key: "quiet", at: new Date(T0).toISOString(), state: "running", text: "lane launched in w1:quiet" });
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT quiet state=running registryStatus=working (journal holds harness activity only)");
  expect(result.lines.some((l) => l.startsWith("REPORT quiet"))).toBe(false);
});

test("a launched lane with no journal at all reads NO-REPORT, never nothing", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w1:p7", workspace_id: "w1", agent: "omo", agent_status: "working" }];
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(launched("silent", "working", "w1:p7"));
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT silent registryStatus=working (no journal)");
  expect(result.exitCode).toBe(0);
});

test("an adopted lane's journal is not read, so a done record there cannot offer its watch for cleanup", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w1:p9", workspace_id: "w1" }];
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(lane("adopted", "working", "w1:p9"));
  deps.reports.report("adopted", "done", "finished", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch adopted", monitorId: "mon_ADOPTED" }]).data));
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => /^(NO-)?REPORT adopted/.test(l))).toBe(false);
  expect(result.lines).toContain("MONITORS cleanupCandidates=0 deliveryPaused=0 expired=0 (from metadata; liveness unverified)");
  expect(result.exitCode).toBe(0);
});

test("an unreadable journal of any kind is that lane's error; the other lanes are still reported", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(launched("a-broken"));
  await deps.registry.write(launched("b-healthy"));
  mkdirSync(deps.reports.path("a-broken"), { recursive: true });
  deps.reports.report("b-healthy", "blocker", "needs the owner", T0);
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR a-broken kind=EISDIR");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines).toContain("REPORT b-healthy kind=blocker at=2026-01-01T12:00:00.000Z state=blocked registryStatus=working");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test.each(["reopen", "object"] as const)("a historical done journal is invalidated by %s before boot", async (transition) => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  const claimed = launched("again", "done-claimed", "w1:p8");
  await deps.registry.write(claimed);
  deps.reports.report("again", "done", "claimed too early", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch again", monitorId: "mon_AGAIN" }]).data));
  if (transition === "reopen") await reopenClaim(deps, claimed, "new work arrived");
  else await objectDone(deps, claimed, ["checks still fail"]);
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`VANISHED again pane=w1:p8 status=${transition === "reopen" ? "working" : "not-done"}; registry and worktrees preserved; no relaunch`);
  expect(result.lines).toContain("MONITORS cleanupCandidates=0 deliveryPaused=0 expired=0 (from metadata; liveness unverified)");
  expect(result.lines.some((line) => line.includes("mon_AGAIN"))).toBe(false);
});
