import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { fill, loadConfig, loadEnvFile } from "../src/config.ts";
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

test("the discord-aoe setup's config loads as the aoe backend with built-in thread hooks, and unset Discord words keep their defaults", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../setups/discord-aoe/config.json"), "/home/ana");
  expect(c.backend).toBe("aoe");
  expect(c.hooks.threadDone).toEqual(["dori", "thread", "done", "{thread}", "{text}"]);
  expect(c.discord.done).toBe("done");
  expect(c.discord.timeZone).toBe("UTC");
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
