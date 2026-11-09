import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { holdOff, holdOn, liveHolds, parseUntil } from "../src/heavy-hold.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import { acquire, admitOnce, type SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(30_000);

// zzangdori 2026-11-08 (#dori-pair): while 0a83 measured and ran its regression, dori heavy put other Doris' jobs in 0a83's
// slot whenever every helper was busy (gongdori rvp-make5, make7, make8, soodori's whole bun test for 105 s), and the window
// broke five times. A hold on this host keeps every account's new heavy job out of its slots until it ends; --helpers-only
// keeps one job out of them always.
const ME = userInfo().username;
const CLI = join(import.meta.dir, "../src/cli.ts");
const OTHER = 4243;
let state: ReturnType<typeof withState>;
let hold: string;
let lines: string[];

beforeEach(() => {
  state = withState();
  hold = join(state.dir, "hold");
  lines = [];
});
afterEach(() => state.done());

const slotDir = (): string => join(state.dir, "heavy");
const depsWith = (h: () => string | undefined, sleep: () => Promise<void>, alive: (p: number) => boolean = (p) => p === process.pid, load: () => Promise<number> = async () => 0): SlotDeps => ({
  dir: slotDir(), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep }, pid: process.pid, load, alive, hold: h, log: (l) => void lines.push(l),
});
const holdNow = (): string | undefined => liveHolds(hold, Date.now()).map((x) => `by ${x.by}: ${x.reason}`).join("; ") || undefined;

test("a hold names who set it, why and until when, in a directory every account can write, and ends at off or at its time", () => {
  const now = Date.now();
  expect(holdOn(hold, ME, now + 30 * 60_000, "zzangdori v0.3.0 regression", now)).toBeUndefined();
  expect(statSync(hold).mode & 0o1777).toBe(0o1777);
  expect(liveHolds(hold, now)).toEqual([{ by: ME, reason: "zzangdori v0.3.0 regression", until: now + 30 * 60_000 }]);
  expect(liveHolds(hold, now + 30 * 60_000)).toEqual([]);
  holdOff(hold, ME);
  expect(liveHolds(hold, now)).toEqual([]);
});

test("--until takes minutes, hours, a clock time or an ISO time, up to a day ahead", () => {
  const now = Date.parse("2026-11-08T18:00:00Z");
  expect(parseUntil("30", now)).toEqual({ at: now + 30 * 60_000 });
  expect(parseUntil("90m", now)).toEqual({ at: now + 90 * 60_000 });
  expect(parseUntil("2h", now)).toEqual({ at: now + 2 * 3_600_000 });
  expect(parseUntil("2026-11-09T03:10+09:00", now)).toEqual({ at: Date.parse("2026-11-08T18:10:00Z") });
  const clock = parseUntil("03:10", now);
  expect("at" in clock && clock.at > now && clock.at <= now + 24 * 3_600_000 && new Date(clock.at).getMinutes() === 10).toBe(true);
  for (const bad of ["25h", "0", "abc", "2026-11-08T17:00:00Z"]) expect(parseUntil(bad, now)).toHaveProperty("why");
});

test("a job already waiting here when the hold comes on does not take the freed slot; it takes it after off", async () => {
  // Given: the one slot held by another live job, no hold yet
  mkdirSync(join(slotDir(), "slot.1"), { recursive: true });
  writeFileSync(join(slotDir(), "slot.1", "owner"), `${OTHER} other ${new Date().toISOString()}`);
  let sleeps = 0;
  let takenUnderHold = false;
  const sleep = async () => {
    sleeps++;
    // the hold comes on and the other job ends
    if (sleeps === 1) holdOn(hold, ME, Date.now() + 60_000, "measuring", Date.now());
    if (sleeps === 1) rmSync(join(slotDir(), "slot.1"), { recursive: true });
    if (sleeps === 3) takenUnderHold = existsSync(join(slotDir(), "slot.1"));
    if (sleeps === 3) holdOff(hold, ME);
    if (sleeps > 5) throw new Error("never admitted");
  };
  // When
  const got = await acquire<never>(depsWith(holdNow, sleep, (p) => p === process.pid || p === OTHER), "plain", {});
  // Then
  expect(takenUnderHold).toBe(false);
  expect("slot" in got).toBe(true);
  expect(sleeps).toBe(3);
  expect(lines.some((l) => l.startsWith("HEAVY_HOLD_LOCAL plain: ") && l.includes(`by ${ME}: measuring`) && l.includes("waits here until the hold ends"))).toBe(true);
});

test("under a hold a job that may run elsewhere goes to a helper, and this host's free slot stays free", async () => {
  holdOn(hold, ME, Date.now() + 60_000, "measuring", Date.now());
  const got = await acquire(depsWith(holdNow, async () => { throw new Error("waited"); }), "spread", { elsewhere: async () => "helper" });
  expect(got).toEqual({ elsewhere: "helper" });
  expect(existsSync(join(slotDir(), "slot.1"))).toBe(false);
  expect(lines.some((l) => l.startsWith("HEAVY_HOLD_LOCAL spread: ") && l.includes("goes to the first helper that admits it"))).toBe(true);
});

test("a hold set while an admission samples the load takes the slot back, here and as a helper", async () => {
  const turnOn = async () => {
    holdOn(hold, ME, Date.now() + 60_000, "measuring", Date.now());
    return 0;
  };
  const here = depsWith(holdNow, async () => { throw new Error("waited"); }, undefined, turnOn);
  await expect(acquire<never>(here, "plain", {})).rejects.toThrow("waited");
  expect(existsSync(join(slotDir(), "slot.1"))).toBe(false);
  expect(lines.some((l) => l.startsWith("HEAVY_HOLD_LOCAL plain: "))).toBe(true);
  holdOff(hold, ME);
  expect(await admitOnce(depsWith(holdNow, async () => {}, undefined, turnOn), "theirs")).toMatchObject({ wait: "hold" });
  expect(existsSync(join(slotDir(), "slot.1"))).toBe(false);
});

test("as a helper this host takes no job under a hold", async () => {
  holdOn(hold, ME, Date.now() + 60_000, "measuring", Date.now());
  const t = await admitOnce(depsWith(holdNow, async () => {}), "theirs");
  expect(t).toMatchObject({ wait: "hold" });
  expect(existsSync(join(slotDir(), "slot.1"))).toBe(false);
});

test("a --helpers-only job never takes this host's free slot and leaves no ticket in its line while it waits for a helper", async () => {
  let asked = 0;
  let tickets = -1;
  const sleep = async () => {
    tickets = existsSync(join(slotDir(), "queue")) ? readdirSync(join(slotDir(), "queue")).length : 0;
  };
  const got = await acquire(depsWith(() => undefined, sleep), "only", { helpersOnly: true, elsewhere: async () => (++asked < 2 ? null : "helper") });
  expect(got).toEqual({ elsewhere: "helper" });
  expect([asked, tickets, existsSync(join(slotDir(), "slot.1"))]).toEqual([2, 0, false]);
});

test("a --helpers-only job that every helper refused ends with exit 2 and a line, not on this host", async () => {
  const helper = ["sh", "-c", "printf 'WORKER_REFUSED exec is off on this host (heavyQueue.exec)\\n' >&2; exit 3", "helper"];
  const deps = depsWith(() => undefined, async () => { throw new Error("waited"); });
  const ctx: HeavyCtx = { q: { jobs: {}, helpers: [{ name: "second", ssh: helper }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
  const work = join(state.dir, "work");
  mkdirSync(work, { recursive: true });
  const job: SpreadJob = { label: "only", kind: "cpu", cmd: ["true"], cwd: work, sync: [work], env: {}, helpersOnly: true };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  expect(await heavySpread(ctx, job, plan)).toEqual({ code: 2 });
  expect(existsSync(join(slotDir(), "slot.1"))).toBe(false);
  expect(lines.some((l) => l.startsWith("HEAVY_HELPERS_ONLY only: no helper can run it (second: exec is off"))).toBe(true);
});

// the CLI with a config of its own: a test never reads or writes the host's real hold directory
const cli = (args: string[], helpers: unknown[] = []) => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyMaxLoad: 1e9, heavyHoldDir: hold, heavyQueue: { helpers } }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  return Bun.spawn(["setsid", process.execPath, CLI, "heavy", ...args], { env: { ...own, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, cwd: state.dir, stdout: "pipe", stderr: "pipe" });
};
const done = async (p: ReturnType<typeof cli>) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() });

test("dori heavy hold-local on, status and off print HEAVY_HOLD_LOCAL lines", async () => {
  const on = await done(cli(["hold-local", "on", "--until", "30", "--reason", "zzangdori regression"]));
  expect(on.code).toBe(0);
  expect(on.err).toMatch(new RegExp(`^HEAVY_HOLD_LOCAL on by ${ME} until \\S+Z \\(30 min left\\): zzangdori regression; `, "m"));
  expect((await done(cli(["hold-local"]))).err).toMatch(new RegExp(`^HEAVY_HOLD_LOCAL on by ${ME} until `, "m"));
  expect((await done(cli(["hold-local", "off"]))).err).toMatch(new RegExp(`^HEAVY_HOLD_LOCAL off by ${ME}$`, "m"));
  expect((await done(cli(["hold-local"]))).err).toMatch(/^HEAVY_HOLD_LOCAL off: no hold on this host$/m);
  expect((await done(cli(["hold-local", "on", "--until", "30"]))).code).not.toBe(0);
});

test("a plain job under a hold says so and does not start", async () => {
  await done(cli(["hold-local", "on", "--until", "30", "--reason", "measuring"]));
  const p = cli(["plain", "--", "sh", "-c", "echo ran"]);
  let err = "";
  for await (const chunk of p.stderr) {
    err += new TextDecoder().decode(chunk);
    if (err.includes("HEAVY_HOLD_LOCAL plain: ")) break;
  }
  process.kill(-p.pid, "SIGKILL");
  expect(err).toContain(`by ${ME} until`);
  expect(await new Response(p.stdout).text()).toBe("");
});

test("--helpers-only goes with --kind, and with no helper it is refused with exit 2", async () => {
  expect((await done(cli(["only", "--helpers-only", "--", "true"]))).code).not.toBe(0);
  const r = await done(cli(["only", "--helpers-only", "--kind", "cpu", "--sync", state.dir, "--", "sh", "-c", "echo ran"]));
  expect([r.code, r.out]).toEqual([2, ""]);
  expect(r.err).toContain("HEAVY_HELPERS_ONLY only: no heavyQueue.helpers on this host; it does not run here");
});
