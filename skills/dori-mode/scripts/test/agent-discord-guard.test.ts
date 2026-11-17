import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withState } from "./fakes.ts";

const GUARD = join(import.meta.dir, "../../setups/agent-discord-guard/agent-discord");

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

// the guard linked into a bin dir ahead of a fake real agent-discord that records its arguments
const setup = () => {
  const bin = join(state.dir, "bin");
  const real = join(state.dir, "real");
  mkdirSync(bin);
  mkdirSync(real);
  symlinkSync(GUARD, join(bin, "agent-discord"));
  writeFileSync(join(real, "agent-discord"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${join(state.dir, "calls")}\nexit 3\n`);
  chmodSync(join(real, "agent-discord"), 0o755);
  return { PATH: `${bin}:${real}:/usr/bin:/bin`, HOME: state.dir, XDG_STATE_HOME: join(state.dir, "xdg") };
};
const run = async (env: Record<string, string>, args: string[]) => {
  const p = Bun.spawn(["agent-discord", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, err: await new Response(p.stderr).text() };
};
const log = (env: Record<string, string>) => join(env["XDG_STATE_HOME"]!, "dori/agent-discord-guard.log");

test("a write through agent-discord warns AGENT_DISCORD_SEND with the directive id, logs it, and still runs the real CLI with its exit code", async () => {
  const env = setup();
  const r = await run(env, ["--server", "9", "message", "send", "123", "hello send"]);
  expect(r.code).toBe(3);
  expect(r.err).toBe("AGENT_DISCORD_SEND agent-discord message send: the owner's user-account CLI was called to write (directive no-agent-discord; a warning for now, refusal to be reviewed on 2026-12-01). Send with dori send discord (bot token).\n");
  expect(readFileSync(join(state.dir, "calls"), "utf8")).toBe("--server 9 message send 123 hello send\n");
  expect(readFileSync(log(env), "utf8")).toMatch(/^\S+Z AGENT_DISCORD_SEND agent-discord message send: /);
});

test("a read passes silently, even when its text holds a write word", async () => {
  const env = setup();
  for (const args of [["message", "list", "123"], ["message", "search", "send"], ["whoami"], ["--help"]]) {
    const r = await run(env, args);
    expect(r.err).toBe("");
    expect(r.code).toBe(3);
  }
  expect(readFileSync(join(state.dir, "calls"), "utf8").trim().split("\n")).toHaveLength(4);
  expect(existsSync(log(env))).toBe(false);
});
