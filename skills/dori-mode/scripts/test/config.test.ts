import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, fill, loadConfig, loadEnvFile } from "../src/config.ts";
import { configKeys } from "../src/config-keys.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("the scorecard counts sessionsDir unless scorecard.sessions names one Dori's own sessions", async () => {
  expect((await loadConfig("/nonexistent/config.json", "/home/ana")).scorecard.sessions).toBe("/home/ana/.omo/agent/sessions");
  const path = join(state.dir, "second-dori.json");
  writeFileSync(path, JSON.stringify({ scorecard: { sessions: "~/.omo/agent/sessions/--home-ana-second--" } }));
  expect((await loadConfig(path, "/home/ana")).scorecard.sessions).toBe("/home/ana/.omo/agent/sessions/--home-ana-second--");
});

test("the discord-aoe setup's config loads as the aoe backend with built-in thread hooks, and unset Discord words keep their defaults", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../setups/discord-aoe/config.json"), "/home/ana");
  expect(c.backend).toBe("aoe");
  expect(c.hooks.threadDone).toEqual(["dori", "thread", "done", "{thread}", "{text}"]);
  expect(c.discord.done).toBe("done");
  expect(c.discord.timeZone).toBe("UTC");
  expect(c.discord.statusStyle).toBe("emoji");
  expect((await loadConfig("/nonexistent/config.json", "/home/ana")).discord.statusStyle).toBe("words");
});

test("the env file fills unset variables only, skips comments and strips quotes", async () => {
  const file = join(state.dir, "dori.env");
  writeFileSync(file, "# Discord\nDORI_DISCORD_OWNER=111\nDORI_DISCORD_CHANNEL='222'\nexport_me=x\nDORI_DISCORD_TOKEN=from-file\n");
  const env: Record<string, string | undefined> = { DORI_DISCORD_TOKEN: "from-env" };
  await loadEnvFile(file, env);
  expect(env).toEqual({ DORI_DISCORD_TOKEN: "from-env", DORI_DISCORD_OWNER: "111", DORI_DISCORD_CHANNEL: "222" });
  await loadEnvFile(join(state.dir, "missing.env"), env);
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("documents every configuration field when defaultConfig defines it", async () => {
  // Given
  const defaults = defaultConfig();
  const text = await Bun.file(join(import.meta.dir, "../../references/scripts.md")).text();
  const documented = new Set([...text.matchAll(/`([a-zA-Z][\w.]*)`/g)].map((match) => match[1]));
  const required = [
    ...Object.keys(defaults),
    ...configKeys({ scorecard: defaults.scorecard, update: defaults.update, sameFix: defaults.sameFix, signals: defaults.signals }),
  ];
  // When
  const missing = required.filter((key) => !documented.has(key));
  // Then
  expect(missing).toEqual([]);
});

test("expands update paths and defaults watchLog and alertPane when config overrides state and lead", async () => {
  // Given
  const fixture = withState();
  try {
    const file = join(fixture.dir, "config.json");
    writeFileSync(file, JSON.stringify({ stateDir: "~/custom-state", leadPane: "lead", update: { repo: "~/clone", services: [{ unit: "test", log: "~/service.log" }] } }));
    // When
    const config = await loadConfig(file, "/home/ana");
    // Then
    expect(config.watchLog).toBe("/home/ana/custom-state/lanes.log");
    expect(config.update.repo).toBe("/home/ana/clone");
    expect(config.update.alertPane).toBe("lead");
    expect(config.update.services).toEqual([{ unit: "test", log: "/home/ana/service.log", paths: ["skills/dori-mode/scripts/src/"], ready: "" }]);
    expect(config.update.readyTimeoutSec).toBe(60);
  } finally { fixture.done(); }
});
