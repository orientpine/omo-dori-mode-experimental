import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withState } from "./fakes.ts";

setDefaultTimeout(30_000); // each test starts the dori CLI twice, one inside the other

// A dori heavy started inside a heavy job here (rv make inside dori heavy ... -- rv make without --no-heavy) waited for a
// slot of its own while the job it ran in held one, which with the last slot taken never ends (lead 2026-11-08,
// rv-actreverse-skip); now it runs at once in that job's slot and scope.
const CLI = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let env: Record<string, string | undefined>;

beforeEach(() => {
  state = withState();
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "dori"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "dori"), 0o755);
  const config = join(state.dir, "config.json");
  // named jobs: one that prints, one whose command starts a plain dori heavy itself
  const jobs = { say: { argv: ["sh", "-c", "echo job ran"] }, wrap: { argv: ["dori", "heavy", "inner", "--", "sh", "-c", "echo inner of a job ran"] } };
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyMaxLoad: 1e9, heavySlots: 1, heavyMaxSlots: 1, heavyQueue: { jobs, jobDir: join(state.dir, "jobs") } }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  env = { ...own, PATH: `${bin}:/usr/bin:/bin`, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") };
});
afterEach(() => state.done());

const heavy = async (args: string[], ms: number): Promise<{ code: number | null; out: string; err: string }> => {
  // in its own process group, so a stuck inner dori heavy (which holds the pipes) goes with it
  const p = Bun.spawn(["setsid", process.execPath, CLI, "heavy", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(-p.pid, "SIGKILL"), ms);
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: p.signalCode ? null : code, out, err };
};

test("a dori heavy inside a heavy job here runs at once in that job's slot, not waiting for one of its own", async () => {
  // Given: one heavy slot here, and a heavy job whose command starts dori heavy itself
  // When
  const r = await heavy(["outer", "--", "dori", "heavy", "inner", "--", "sh", "-c", "echo inner ran"], 20_000);
  // Then
  expect([r.code, r.out]).toEqual([0, "inner ran\n"]);
  expect(r.err).toContain("HEAVY_NESTED inner: inside the heavy job outer here, so it runs now in that job's slot and scope");
});

test("the inner job's exit code is the outer job's, and a --kind inner job is not sent to a helper", async () => {
  const r = await heavy(["outer", "--", "dori", "heavy", "inner", "--kind", "cpu", "--sync", state.dir, "--", "sh", "-c", "exit 3"], 20_000);
  expect(r.code).toBe(3);
  expect(r.err).toContain("HEAVY_NESTED inner:");
  expect(r.err).not.toContain("HEAVY_LOCAL inner");
});

test("a named --job inside a heavy job here runs at once too, and a named job's own command is a heavy job for what it starts", async () => {
  // Given: one heavy slot here
  // When: a plain job starts a named one, and a named job starts a plain one
  const a = await heavy(["outer", "--", "dori", "heavy", "inner", "--job", "say"], 20_000);
  const b = await heavy(["outer", "--job", "wrap"], 20_000);
  // Then
  expect([a.code, a.out]).toEqual([0, "job ran\n"]);
  expect(a.err).toContain("HEAVY_NESTED inner: inside the heavy job outer here, so it runs now in that job's slot and scope");
  expect(b.code).toBe(0);
  expect(b.err).toContain("HEAVY_NESTED inner: inside the heavy job outer here, so it runs now in that job's slot and scope");
});
