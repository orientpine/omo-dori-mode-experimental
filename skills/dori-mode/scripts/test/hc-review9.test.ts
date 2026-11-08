import { afterEach, expect, test } from "bun:test";
import { openHerdrSession } from "../src/herdr.ts";
import { childEnv, type Runner } from "../src/run.ts";
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

test("an hc call, which may start the core every later terminal inherits from, carries no DORI_* of the caller; HC_SESSION, the core's own selector, stays", () => {
  const env = { PATH: "/bin", DORI_CONFIG: "/a/config.json", DORI_ENV_FILE: "/a/dori.env", DORI_STATE_DIR: "/a/state", HC_SESSION: "named" };
  expect(childEnv(["hc", "--json", "run"], env)).toEqual({ PATH: "/bin", HC_SESSION: "named" });
  expect(childEnv(["/home/u/.local/bin/hc", "ls"], env)).toEqual({ PATH: "/bin", HC_SESSION: "named" });
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
