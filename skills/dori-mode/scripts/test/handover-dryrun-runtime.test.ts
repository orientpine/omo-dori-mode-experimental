import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handover, type HandoverDeps } from "../src/handover.ts";
import { laneHandover, type LaneHandoverDeps } from "../src/lane-handover.ts";
import { useConfiguredRuntime } from "../src/run.ts";
import type { RuntimeKind } from "../src/runtime/types.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";

// A herdr-backend Dori whose config runtime is hc opens its new lead and lane sessions on hc (herdr.ts openHerdrSession),
// so the dry run names hc, not the backend herdr (수돌 and 옥돌 2026-11-11: HANDOVER_DRY_RUN said herdr, the move opened hc:t7).
const savedEnv = process.env["DORI_RUNTIME"];
let dir: string;
let world: World;
let printed: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-dryrun-runtime-"));
  world = newWorld();
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  printed = [];
  delete process.env["DORI_RUNTIME"];
});
afterEach(() => {
  useConfiguredRuntime(undefined);
  if (savedEnv === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

const extras = { cardDir: join("x", "cards"), home: "/home/test", sessionOf: async () => "", procs: async () => [{ pid: 4000, ppid: 1, cmd: "bash" }, { pid: 4001, ppid: 4000, cmd: "omo" }], envOf: () => "", alive: () => false, signal: () => true, realpath: (path: string) => path, nonce: () => "n1", print: (line: string) => printed.push(line) };

const laneDryRun = async (runtime: RuntimeKind): Promise<string> => {
  useConfiguredRuntime(runtime);
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "# Demo\n");
  const base = depsFor(world, fakeClock(0), dir, { backend: "herdr", runtime, agentCommand: ["omo", "--model", "{model}", "{prompt}"], sessionsDir: join(dir, "sessions") });
  await base.registry.write({ key: "demo", title: "Demo", pane: "w1:p1", thread: "none", brief, cwd: dir, model: "review/model", done: "file /done", status: "working", openedAt: new Date(0).toISOString() });
  const deps: LaneHandoverDeps = { ...base, ...extras, cardDir: join(dir, "cards") };
  const r = await laneHandover(deps, "demo", "w0:p0", { dryRun: true });
  expect(r.code).toBe(0);
  return printed.find((l) => l.startsWith("HANDOVER_DRY_RUN")) ?? printed.join("\n");
};

const leadDryRun = async (runtime: RuntimeKind): Promise<string> => {
  useConfiguredRuntime(runtime);
  const base = depsFor(world, fakeClock(0), dir, { backend: "herdr", runtime, leadPane: "w1:p1", agentCommand: ["omo", "--model", "{model}", "{prompt}"], sessionsDir: join(dir, "sessions") });
  const deps: HandoverDeps = { ...base, ...extras, cardDir: join(dir, "cards"), configPath: join(dir, "config.json"), envPath: join(dir, "dori.env"), inbox: join(dir, "inbox.jsonl"), routedPane: async () => "w1:p1", envLeadPane: "", timers: async () => [], restart: async () => undefined };
  const r = await handover(deps, { dryRun: true, noMonitors: true });
  expect(r.code).toBe(0);
  return printed.find((l) => l.startsWith("HANDOVER_DRY_RUN")) ?? printed.join("\n");
};

test.each(["hc", "herdr"] as const)("a lane dry run on backend herdr names the runtime %s that the config chose", async (runtime) => {
  expect(await laneDryRun(runtime)).toStartWith(`HANDOVER_DRY_RUN demo would open ${runtime} session "`);
});

test.each(["hc", "herdr"] as const)("a lead dry run on backend herdr names the runtime %s that the config chose", async (runtime) => {
  expect(await leadDryRun(runtime)).toStartWith(`HANDOVER_DRY_RUN would open ${runtime} session "`);
});
