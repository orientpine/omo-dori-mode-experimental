import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { knownConfigKeys } from "../src/config-keys.ts";
import type { Runner } from "../src/run.ts";
import { applyUpdate, type UpdateDeps } from "../src/update.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let deps: UpdateDeps;
let changes: string;
let head: string;
let lines: string[];
let calls: string[][];
let alerts: string[];
const options = { pull: false, dryRun: false };
const old = "1111111111111111111111111111111111111111";
const next = "2222222222222222222222222222222222222222";
beforeEach(() => {
  state = withState();
  changes = "skills/dori-mode/scripts/src/cli.ts";
  head = next;
  lines = [];
  calls = [];
  alerts = [];
  let time = 0;
  const git: Runner = async (args) => {
    calls.push([...args]);
    return { code: 0, out: args.includes("rev-parse") ? head : args.includes("diff") ? changes : "", err: "" };
  };
  const systemctl: Runner = async (args) => {
    calls.push([...args]);
    if (args.includes("restart")) appendFileSync(join(state.dir, "service.log"), "READY\n");
    return { code: 0, out: "active", err: "" };
  };
  deps = {
    config: { ...defaultConfig(), stateDir: state.dir, watchLog: join(state.dir, "lanes.log"), update: {
      ...defaultConfig().update, repo: state.dir, services: [{ unit: "dori-test", paths: ["skills/dori-mode/scripts/src/"], log: join(state.dir, "service.log"), ready: "^READY$" }],
      readyTimeoutSec: 1, alertPane: "test-pane",
    } },
    configPath: join(state.dir, "config.json"), git, systemctl,
    clock: { now: () => time, sleep: async (ms) => { time += ms; } },
    send: async (pane, text) => { alerts.push(`${pane} ${text}`); return true; },
    print: (line) => lines.push(line),
  };
});
afterEach(() => state.done());
const baseline = (keys = knownConfigKeys()) => writeFileSync(join(state.dir, "update.json"), JSON.stringify({ applied: old, keys }));
const logLines = async () => (await Bun.file(deps.config.watchLog).text()).trim().split("\n");

test("records HEAD and keys without restarts when state is absent", async () => {
  // Given
  // When
  expect(await applyUpdate(deps, options)).toBe(true);
  // Then
  expect(await Bun.file(join(state.dir, "update.json")).json()).toEqual({ applied: next, keys: knownConfigKeys() });
  expect(calls.some((args) => args[0] === "systemctl")).toBe(false);
  expect(alerts).toEqual([]);
  expect(await logLines()).toEqual([`1970-01-01T00:00:00.000Z update UPDATED first-run ${next.slice(0, 7)}`]);
});

test("restarts once and logs success when a new ready line follows a source change", async () => {
  // Given
  baseline();
  writeFileSync(join(state.dir, "service.log"), "READY\n");
  // When
  expect(await applyUpdate(deps, options)).toBe(true);
  // Then
  expect(calls.filter((args) => args.includes("restart"))).toEqual([["systemctl", "--user", "restart", "dori-test"]]);
  expect((await logLines()).filter((line) => line.includes(" RESTARTED "))).toEqual([`1970-01-01T00:00:00.000Z update RESTARTED dori-test ${next.slice(0, 7)}`]);
  expect(alerts).toEqual([]);
});

test("leaves services alone when only docs changed", async () => {
  // Given
  baseline();
  changes = "skills/dori-mode/references/scripts.md";
  // When
  expect(await applyUpdate(deps, options)).toBe(true);
  // Then
  expect(calls.some((args) => args[0] === "systemctl")).toBe(false);
  expect((await logLines()).find((line) => line.includes(" UPDATED "))).toEndWith("changed=1 restarted=-");
});

test("alerts and records attempted HEAD when no new ready line appears", async () => {
  // Given
  baseline();
  writeFileSync(join(state.dir, "service.log"), "READY\n");
  deps = { ...deps, systemctl: async () => ({ code: 0, out: "", err: "" }) };
  // When
  expect(await applyUpdate(deps, options)).toBe(false);
  // Then
  expect((await logLines()).filter((line) => line.includes(" RESTART_FAIL "))).toHaveLength(1);
  expect(alerts).toEqual(["test-pane [ALERT] dori update: RESTART_FAIL dori-test ready timeout after 1s"]);
  expect((await Bun.file(join(state.dir, "update.json")).json()).applied).toBe(next);
});

test("reports an unset new key when stored code did not know it", async () => {
  // Given
  baseline(knownConfigKeys().filter((key) => key !== "scorecard.sessions"));
  changes = "README.md";
  writeFileSync(deps.configPath, JSON.stringify({ scorecard: { language: "ko" } }));
  // When
  await applyUpdate(deps, options);
  // Then
  const notice = `CONFIG_NEW_KEY scorecard.sessions unset in ${deps.configPath} (default used)`;
  expect(lines).toContain(notice);
  expect((await logLines()).some((line) => line.endsWith(notice))).toBe(true);
  expect((await Bun.file(join(state.dir, "update.json")).json()).keys).toContain("scorecard.sessions");
  expect(alerts).toEqual([]);
});

test("includes new keys in the failure alert but not keys explicitly set", async () => {
  // Given
  baseline(knownConfigKeys().filter((key) => !["scorecard.sessions", "signals.launchLanes"].includes(key)));
  writeFileSync(deps.configPath, JSON.stringify({ signals: { launchLanes: 0 } }));
  deps = { ...deps, systemctl: async () => ({ code: 1, out: "", err: "restart refused" }) };
  // When
  await applyUpdate(deps, options);
  // Then
  expect(alerts[0]).toContain("RESTART_FAIL dori-test restart: restart refused");
  expect(alerts[0]).toContain("CONFIG_NEW_KEY scorecard.sessions");
  expect(lines.some((line) => line.includes("CONFIG_NEW_KEY signals.launchLanes"))).toBe(false);
});

test("checks activity without a log when ready is empty", async () => {
  // Given
  baseline();
  deps = { ...deps, config: { ...deps.config, update: { ...deps.config.update, services: [{ unit: "dori-test", paths: ["skills/"], log: "", ready: "" }] } } };
  // When
  await applyUpdate(deps, options);
  // Then
  expect(calls).toContainEqual(["systemctl", "--user", "is-active", "dori-test"]);
  expect(lines).toContain("RESTARTED dori-test 2222222");
});

test("does not mutate anything when dry run is requested even with pull", async () => {
  // Given
  baseline();
  const before = await Bun.file(join(state.dir, "update.json")).text();
  // When
  await applyUpdate(deps, { pull: true, dryRun: true });
  // Then
  expect(calls.some((args) => args.includes("pull") || args[0] === "systemctl")).toBe(false);
  expect(await Bun.file(join(state.dir, "update.json")).text()).toBe(before);
  expect(await Bun.file(deps.config.watchLog).exists()).toBe(false);
  expect(alerts).toEqual([]);
  expect(lines).toContain("DRY_RUN restart dori-test 2222222");
});

test("prints only UP_TO_DATE when the applied HEAD is unchanged", async () => {
  // Given
  baseline();
  head = old;
  // When
  await applyUpdate(deps, options);
  // Then
  expect(lines).toEqual(["UP_TO_DATE"]);
  expect(await Bun.file(deps.config.watchLog).exists()).toBe(false);
});

test("logs UPDATE_FAIL and preserves state when the pull fails", async () => {
  // Given
  baseline();
  deps = { ...deps, git: async () => ({ code: 1, out: "", err: "not fast-forward" }) };
  // When
  expect(await applyUpdate(deps, { pull: true, dryRun: false })).toBe(false);
  // Then
  expect(lines).toEqual(["UPDATE_FAIL git pull: not fast-forward"]);
  expect((await logLines())[0]).toEndWith(lines[0] ?? "");
  expect((await Bun.file(join(state.dir, "update.json")).json()).applied).toBe(old);
  expect(alerts).toEqual(["test-pane [ALERT] dori update: UPDATE_FAIL git pull: not fast-forward"]);
});

test("attempts the next matched service when the first restart fails", async () => {
  // Given
  baseline();
  const second = { unit: "second", paths: ["skills/"], log: "", ready: "" };
  deps = { ...deps, config: { ...deps.config, update: { ...deps.config.update, services: [...deps.config.update.services, second] } },
    systemctl: async (args) => { calls.push([...args]); return { code: args.includes("dori-test") ? 1 : 0, out: "", err: args.includes("dori-test") ? "failed" : "" }; } };
  // When
  expect(await applyUpdate(deps, options)).toBe(false);
  // Then
  expect(calls.filter((args) => args.includes("restart"))).toEqual([
    ["systemctl", "--user", "restart", "dori-test"], ["systemctl", "--user", "restart", "second"],
  ]);
  expect(lines).toContain("RESTARTED second 2222222");
  expect((await Bun.file(join(state.dir, "update.json")).json()).applied).toBe(next);
});
