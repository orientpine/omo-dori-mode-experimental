import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { holdNote, holdOff, holdOn, liveHolds } from "../src/heavy-hold.ts";
import { newJobDir, stageInputs } from "../src/heavy-job.ts";
import { runQueued, type HeavyCtx } from "../src/heavy-queue.ts";
import { withState } from "./fakes.ts";

// lead 2026-11-08 (yoodori, #dori-pair): yoodori has no helper, so under a hold its dori heavy voice --job transcribe
// waited the whole window, and the owner waited for his own transcript. The owner's transcription runs here under a
// hold; nothing else does, unless the one who set the hold named its account with --except (zzangdori).
const ME = userInfo().username;
const CLI = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let hold: string;
let logs: string[];

beforeEach(() => {
  state = withState();
  hold = join(state.dir, "hold");
  logs = [];
});
afterEach(() => state.done());

const job = { argv: ["sh", "-c", 'echo here > "$0/where"', "{out}"] };
const ctxWith = (sleep: () => Promise<void>): HeavyCtx => ({
  q: { jobs: { transcribe: job, upper: job }, helpers: [], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 },
  deps: { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep }, pid: process.pid, load: async () => 0, alive: () => true, hold: () => holdNote(hold, Date.now(), ME), log: (l) => void logs.push(l) },
});
const queued = async (kind: string, sleep: () => Promise<void>) => {
  const ctx = ctxWith(sleep);
  const dir = newJobDir(ctx.q.jobDir);
  const input = join(state.dir, "in.txt");
  writeFileSync(input, "x");
  stageInputs(dir, [input]);
  const r = await runQueued(ctx, { label: "voice", kind, rl: false, args: [] }, dir);
  return { code: r.code, where: existsSync(join(dir, "out", "where")) ? readFileSync(join(dir, "out", "where"), "utf8").trim() : "" };
};
const never = async () => {
  throw new Error("waited");
};

test("under a hold the owner's transcription (--job transcribe) runs here at once and says why", async () => {
  holdOn(hold, "zzangdori-test", Date.now() + 30 * 60_000, "measuring", Date.now());
  expect(await queued("transcribe", never)).toEqual({ code: 0, where: "here" });
  expect(logs.some((l) => l.startsWith("HEAVY_HOLD_EXEMPT voice: the owner's transcription (--job transcribe) runs here under the hold by "))).toBe(true);
  expect(logs.some((l) => l.startsWith("HEAVY_HOLD_LOCAL voice"))).toBe(false);
});

// an earlier job of this account standing in this host's line (a live waiter's ticket)
const ticketAhead = () => {
  mkdirSync(join(state.dir, "heavy", "queue"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "queue", `${String(Date.now() - 1000).padStart(15, "0")}-4242-plain`), "local");
};

test("under a hold the owner's transcription passes a job of this account that waits for the hold, not one that waits without it (review 1 of #413)", async () => {
  ticketAhead();
  holdOn(hold, "zzangdori-test", Date.now() + 30 * 60_000, "measuring", Date.now());
  expect(await queued("transcribe", never)).toEqual({ code: 0, where: "here" });
  holdOff(hold, "zzangdori-test");
  logs = [];
  await expect(queued("transcribe", never)).rejects.toThrow("waited");
  expect(logs.some((l) => l.startsWith("HEAVY_WAIT voice: 1 job(s) ahead in the queue"))).toBe(true);
});

test("under a hold any other --job still waits and takes no slot here", async () => {
  holdOn(hold, "zzangdori-test", Date.now() + 30 * 60_000, "measuring", Date.now());
  await expect(queued("upper", never)).rejects.toThrow("waited");
  expect(existsSync(join(state.dir, "heavy", "slot.1"))).toBe(false);
  expect(logs.some((l) => l.startsWith("HEAVY_HOLD_LOCAL voice: "))).toBe(true);
  expect(logs.some((l) => l.startsWith("HEAVY_HOLD_EXEMPT"))).toBe(false);
});

test("a hold with --except names the accounts it lets through, in its file and its line; it holds every other account", () => {
  const now = Date.now();
  expect(holdOn(hold, ME, now + 60_000, "measuring", now, { except: ["yoodori", "okdori"] })).toBeUndefined();
  expect(JSON.parse(readFileSync(join(hold, `${ME}.json`), "utf8")).except).toEqual(["yoodori", "okdori"]);
  expect(liveHolds(hold, now)).toEqual([{ by: ME, reason: "measuring", until: now + 60_000, except: ["yoodori", "okdori"] }]);
  expect(holdNote(hold, now, "yoodori")).toBeUndefined();
  expect(holdNote(hold, now, "gongdori")).toContain(`by ${ME} until `);
  expect(holdNote(hold, now, "gongdori")).toContain("except yoodori, okdori");
});

test("a hold file whose except is not a list of account names holds every account", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "measuring", now);
  writeFileSync(join(hold, `${ME}.json`), JSON.stringify({ reason: "measuring", until: new Date(now + 60_000).toISOString(), except: "yoodori" }));
  expect(holdNote(hold, now, "yoodori")).toContain("measuring");
  writeFileSync(join(hold, `${ME}.json`), JSON.stringify({ reason: "measuring", until: new Date(now + 60_000).toISOString(), except: ["yoo dori/.."] }));
  expect(holdNote(hold, now, "yoo dori/..")).toContain("measuring");
});

test("the suite reads a hold directory of its own, never the host's (DORI_HEAVY_HOLD_DIR from test/preload.ts)", async () => {
  const own = process.env["DORI_HEAVY_HOLD_DIR"] ?? "";
  expect(own.startsWith("/") && own !== "/tmp/dori-heavy-hold" && !existsSync(own)).toBe(true);
  expect((await loadConfig(join(state.dir, "none.json"), state.dir)).heavyHoldDir).toBe(own);
});

const cli = async (args: string[], heavyQueue: object = {}) => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyHoldDir: hold, heavyMaxLoad: 1e9, heavyQueue: { jobDir: join(state.dir, "jobs"), ...heavyQueue } }));
  mkdirSync(join(state.dir, "state"), { recursive: true });
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const p = Bun.spawn([process.execPath, CLI, "heavy", ...args], { cwd: state.dir, env: { ...own, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { err, code };
};

test("dori heavy hold-local on --except takes accounts, refuses a bad name, and status shows them", async () => {
  const on = await cli(["hold-local", "on", "--until", "30", "--reason", "measuring", "--except", "yoodori", "--except", "okdori"]);
  expect([on.code, on.err]).toEqual([0, expect.stringContaining("except yoodori, okdori")]);
  expect((await cli(["hold-local"])).err).toContain("except yoodori, okdori: measuring");
  const bad = await cli(["hold-local", "on", "--until", "30", "--reason", "measuring", "--except", "../x"]);
  expect([bad.code, bad.err.startsWith("HEAVY_HOLD_LOCAL refused: --except takes account names")]).toEqual([2, true]);
});

test("--helpers-only with --job is refused before the job is sent anywhere, so it never runs here (review 1 of #413)", async () => {
  const ran = join(state.dir, "ran");
  const r = await cli(["voice", "--job", "transcribe", "--helpers-only"], { jobs: { transcribe: { argv: ["touch", ran] } } });
  expect([r.code !== 0, r.err.includes("--helpers-only goes with --kind"), existsSync(ran)]).toEqual([true, true, false]);
});

test("a --helpers-only job's --mem is not refused for this host's memory: it goes to the helpers (review 1 of #413)", async () => {
  const big = ["big", "--helpers-only", "--kind", "cpu", "--mem", "100000T", "--sync", state.dir, "--", "true"];
  const none = await cli(big);
  expect([none.code, none.err.includes("HEAVY_REFUSED"), none.err.includes("HEAVY_HELPERS_ONLY big: no heavyQueue.helpers on this host")]).toEqual([2, false, true]);
  const refuse = ["sh", "-c", "printf 'WORKER_REFUSED exec is off on this host (heavyQueue.exec)\\n' >&2; exit 3", "helper"];
  const asked = await cli(big, { helpers: [{ name: "second", ssh: refuse }] });
  expect([asked.code, asked.err.includes("HEAVY_REFUSED"), asked.err.includes("HEAVY_HELPERS_ONLY big: no helper can run it (second: exec is off")]).toEqual([2, false, true]);
});
