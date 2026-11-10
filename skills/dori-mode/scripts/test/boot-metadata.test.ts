import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { Registry } from "../src/registry.ts";
import { bootDeps, lane, manifest, newWorld, T0 } from "./boot-fixtures.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(30_000);
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a manifest with a malformed monitor entry is named as unreadable and the check still finishes", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "null.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: [null] }));
  writeFileSync(join(bad, "string.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: ["mon_X"] }));
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data));
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "null.json")}`);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "string.json")}`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});

test("expired and delivery-paused watches are listed apart from live ones, and an expired one gets no stop call", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(lane("closed", "closed"));
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([
    { command: "dori watch closed", monitorId: "mon_EXPIRED", expiresAt: T0 - 1 },
    { command: "dori watch closed", monitorId: "mon_PAUSED", expiresAt: T0 + 60_000, deliveryPaused: true },
    { command: "dori watch closed", monitorId: "mon_LIVE", expiresAt: T0 + 60_000 },
  ]).data));
  const result = await bootCheck(deps);
  const watchLines = result.lines.filter((l) => /^(MONITORS cleanup|CLEANUP|STOP|EXPIRED)/.test(l));
  const owner = `ownerSession=owner metadata=${join(terminal, "owner.json")}`;
  expect(watchLines).toEqual([
    "MONITORS cleanupCandidates=2 deliveryPaused=1 expired=1 (from metadata; liveness unverified)",
    `CLEANUP closed match=closed:command:key ${owner}`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_LIVE"})',
    `CLEANUP closed match=closed:command:key ${owner} deliveryPaused=true`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_PAUSED"})',
    `EXPIRED closed match=closed:command:key ${owner} expiresAt=${new Date(T0 - 1).toISOString()}; nothing to stop`,
  ]);
});

test("dori boot reads the current session's terminal metadata from PI_SESSION_DIR and PI_SESSION_FILE", async () => {
  const home = join(state.dir, "home");
  const stateDir = join(state.dir, "state");
  const current = join(state.dir, "current", "extensions", "terminal");
  const fileDir = join(state.dir, "other", "extensions", "terminal");
  for (const dir of [home, current, fileDir]) mkdirSync(dir, { recursive: true });
  await new Registry(stateDir).write(lane("closed", "closed"));
  writeFileSync(join(current, "a.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONDIR" }]).data));
  writeFileSync(join(fileDir, "b.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONFILE" }]).data));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "boot"], {
    env: {
      HOME: home,
      PATH: dirname(process.execPath),
      TMPDIR: state.dir,
      DORI_TELEMETRY: "0",
      DORI_CONFIG: join(home, "none.json"),
      DORI_STATE_DIR: stateDir,
      DORI_LEAD_PANE: "w9:p1",
      PI_SESSION_DIR: join(state.dir, "current"),
      PI_SESSION_FILE: join(state.dir, "other", "session.jsonl"),
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(out).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(current, "a.json")}`);
  expect(out).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(fileDir, "b.json")}`);
  expect(out).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(out).toContain("PANES unavailable (session list failed)");
  expect(code).toBe(1);
});

test("one unreadable metadata file is named and the other sessions' cleanup is still listed, path quoted", async () => {
  const world = newWorld();
  const deps = bootDeps(world, state.dir);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b session", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "owner.json"), "{partial");
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data));
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "owner.json")}`);
  expect(result.lines).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata='${join(good, "owner.json")}'`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});
