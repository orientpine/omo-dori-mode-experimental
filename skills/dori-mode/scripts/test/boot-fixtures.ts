import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Monitor } from "../src/boot-monitors.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";
import { runtimesOf } from "../src/run.ts";

export const T0 = Date.parse("2026-01-01T12:00:00Z");
const paneForKey = (key: string): string => `w1:p${Array.from(key, (char) => char.charCodeAt(0).toString(16)).join("")}`;

export const lane = (key: string, status: LaneStatus = "working", pane = paneForKey(key)): Lane => ({
  key,
  status,
  pane,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

export const launched = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  ...lane(key, status, pane),
  reportProtocol: "jsonl-v1",
});

export const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

export const bootDeps = (world: World, stateDir: string, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(stateDir, "sessions");
  const deps = depsFor(world, fakeClock(T0), stateDir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, rts: runtimesOf(deps.run, { runtime: deps.config.runtime }), hcCoreUp: async () => true, reports: new Reports(stateDir), worklog: new Worklog(stateDir), slack, sessionsDir };
};

export const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => [
      join(e.parentPath, e.name),
      e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8") : e.isDirectory() ? "<dir>" : "<other>",
    ])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

export { newWorld };
