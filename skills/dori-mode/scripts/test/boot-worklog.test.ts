import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { bootDeps, newWorld, snapshot, T0 } from "./boot-fixtures.ts";
import { withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());
const depsFor = (world: World, slack?: () => Promise<{ userId: string; teamId: string } | null>) => bootDeps(world, state.dir, slack);

test("open worklog items are printed with the next step the lead asked for; closed ones are omitted", async () => {
  const world = newWorld();
  const deps = depsFor(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  const open = await deps.worklog.add("Reply to the owner on api-release", "ask Q42", T0);
  const closed = await deps.worklog.add("Already done", "ask Q43", T0);
  await deps.worklog.next(open.id, "After the API review", T0 + 1000);
  await deps.worklog.note(open.id, "owner asked twice", T0 + 2000);
  await deps.worklog.close(closed.id, "done", T0 + 3000);
  const before = snapshot(state.dir);
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(result.lines).toContain("WORKLOG open=1");
  expect(result.lines).toContain(`OPEN ${open.id} "Reply to the owner on api-release" source="ask Q42" next="After the API review"`);
  expect(result.lines.some((line) => line.includes("Already done"))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a garbage worklog line fails boot rather than presenting the worklog as empty", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  await deps.worklog.add("Real item", "ask", T0);
  writeFileSync(join(state.dir, "worklog.jsonl"), "garbage\n");
  const result = await bootCheck(deps);
  expect(result.lines.filter((line) => line.startsWith("WORKLOG damaged"))).toHaveLength(1);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a torn write from a crashed fold is skipped, not presented as damage", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  writeFileSync(join(state.dir, "worklog.jsonl"), '{"op":"add","id":"abcd1234","at":"2026-11-');
  const result = await bootCheck(deps);
  expect(result.lines.some((line) => line.startsWith("WORKLOG damaged"))).toBe(false);
  expect(result.lines).toContain("WORKLOG open=0");
  expect(result.exitCode).toBe(0);
});

test("a second close left by two writers is a no-op and never a damaged line", async () => {
  const world = newWorld();
  const deps = depsFor(world);
  const item = await deps.worklog.add("Unique item", "ask", T0);
  await deps.worklog.close(item.id, "done", T0 + 1000);
  const raw = (await Bun.file(join(state.dir, "worklog.jsonl")).text()).trim().split("\n");
  writeFileSync(join(state.dir, "worklog.jsonl"), `${[...raw, raw.at(-1)].join("\n")}\n`);
  const result = await bootCheck(deps);
  expect(result.lines.some((line) => line.startsWith("WORKLOG damaged"))).toBe(false);
  expect(result.lines).toContain("WORKLOG open=0");
  expect(result.exitCode).toBe(0);
});

test("an unreadable worklog fails boot, and the report and Slack lines still run", async () => {
  const world = newWorld();
  const deps = depsFor(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  mkdirSync(join(state.dir, "worklog.jsonl"), { recursive: true });
  const result = await bootCheck(deps);
  expect(result.lines.some((line) => line.startsWith("WORKLOG unreadable "))).toBe(true);
  expect(result.lines).toContain("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(result.exitCode).toBe(1);
});
