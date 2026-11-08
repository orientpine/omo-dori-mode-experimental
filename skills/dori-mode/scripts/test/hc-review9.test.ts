import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHerdrSession } from "../src/herdr.ts";
import { childEnv, doriCore, run, type Runner } from "../src/run.ts";
import { FakeHc } from "./fake-hc.ts";
import { fakeClock } from "./fakes.ts";

// Review 8 of #404: an hc core is a server like herdr's, so it gets the same DORI_* cleanup, and hc lanes are refused on
// native Windows, where the fork's lanes run PowerShell and hc's launch is a Unix `env` line.
const saved = process.env["DORI_RUNTIME"];
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
});

const runnerOf = (fake: FakeHc): Runner => async (argv) => {
  if (argv[0] !== "hc") return { code: 1, out: "", err: "not here" };
  const r = await fake.exec("hc", argv.slice(1));
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
};

const asPlatform = async (platform: string, fn: () => Promise<void>): Promise<void> => {
  const own = Object.getOwnPropertyDescriptor(process, "platform");
  if (!own) throw new Error("process.platform has no descriptor");
  Object.defineProperty(process, "platform", { ...own, value: platform });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", own);
  }
};

test("an hc call, which may start the core every later terminal inherits from, carries no DORI_* of the caller, and its core is the Dori's own, never the caller's HC_SESSION", () => {
  const env = { PATH: "/bin", DORI_CONFIG: "/a/config.json", DORI_ENV_FILE: "/a/dori.env", DORI_STATE_DIR: "/a/state", HC_SESSION: "host" };
  expect(childEnv(["hc", "--json", "run"], env, "named")).toEqual({ PATH: "/bin", HC_SESSION: "named" });
  expect(childEnv(["/home/u/.local/bin/hc", "ls"], env, undefined)).toEqual({ PATH: "/bin" });
  expect(childEnv(["git", "status"], env, "named")).toEqual(env);
});

// H188 (dori challenge of plan-r9): a stored hc:t<n> names a terminal of one core only, so every hc call of a Dori, from
// any unit or shell, goes to the core its dori.env names (HC_SESSION), else the default core
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hc-core-"));
  dirs.push(d);
  return d;
};

test("the Dori's core is the HC_SESSION its dori.env names (quoted or not), else none", () => {
  const d = scratch();
  writeFileSync(join(d, "a.env"), "DORI_DISCORD_TOKEN=x\nHC_SESSION=named\n");
  writeFileSync(join(d, "b.env"), "HC_SESSION='quoted'\n");
  writeFileSync(join(d, "c.env"), "DORI_DISCORD_TOKEN=x\n");
  expect([doriCore(join(d, "a.env")), doriCore(join(d, "b.env")), doriCore(join(d, "c.env")), doriCore(join(d, "missing.env"))]).toEqual(["named", "quoted", undefined, undefined]);
});

test("a real hc call from a process whose HC_SESSION names another core runs in the Dori's core", async () => {
  const d = scratch();
  writeFileSync(join(d, "hc"), "#!/bin/sh\nif [ -n \"$HC_SESSION\" ]; then printf '%s' \"$HC_SESSION\"; else printf default; fi\n");
  chmodSync(join(d, "hc"), 0o755);
  const keep = { env: process.env["DORI_ENV_FILE"], hc: process.env["HC_SESSION"] };
  process.env["HC_SESSION"] = "host";
  try {
    writeFileSync(join(d, "dori.env"), "HC_SESSION=named\n");
    process.env["DORI_ENV_FILE"] = join(d, "dori.env");
    expect((await run([join(d, "hc"), "ls"])).out).toBe("named");
    writeFileSync(join(d, "dori.env"), "DORI_DISCORD_TOKEN=x\n");
    expect((await run([join(d, "hc"), "ls"])).out).toBe("default");
  } finally {
    for (const [k, v] of [["DORI_ENV_FILE", keep.env], ["HC_SESSION", keep.hc]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("on native Windows an hc lane is refused before any hc call, since its launch line is a Unix env line and the fork's lanes there run PowerShell", async () => {
  process.env["DORI_RUNTIME"] = "hc";
  const fake = new FakeHc();
  await asPlatform("win32", async () => {
    await expect(openHerdrSession(runnerOf(fake), fakeClock(0), { title: "k1", cwd: "/w", argv: ["omo"] })).rejects.toThrow(/native Windows/);
  });
  expect(fake.calls).toEqual([]);
  expect(await openHerdrSession(runnerOf(fake), fakeClock(0), { title: "k1", cwd: "/w", argv: ["omo"] })).toEqual({ pane: "hc:t1" });
});
