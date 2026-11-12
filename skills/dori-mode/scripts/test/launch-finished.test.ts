import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, newWorld, withState, type World } from "./fakes.ts";

// A lane can finish and close its own pane before launch's start wait is over: launch then said STARTUP_ERROR (exit 3)
// for a lane that was done (dori-superagent issue #215 reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/issues/215, upstream PR #216). A pane that is gone while the lane is
// closed, verified done or reported done is STARTUP_DONE; one that is gone with the lane unfinished stays STARTUP_ERROR,
// and so does an agent that exited in a pane still there.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const PANE = "w:p9";

let state: ReturnType<typeof withState>;
let world: World;
let brief: string;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
});

afterEach(() => state.done());

type Done = "verified" | "closed" | "journal" | "none";

// the lane finishes, then its pane goes, at `at` seconds after launch: 1 is before the 20 s check, 40 a re-read in the wait
const launchFinishing = async (runtime: "herdr" | "hc", key: string, at: number, done: Done, vanish: "gone" | "dead" = "gone"): Promise<string> => {
  if (runtime === "hc") world.terminals = { t1: hcTerm() };
  let base: FlowDeps | undefined;
  let fired = false;
  const finish = async (): Promise<void> => {
    if (!base) throw new Error("no deps");
    const lane = await base.registry.read(key);
    if (!lane) throw new Error("lane not registered");
    if (done === "verified" || done === "closed") await base.registry.write({ ...lane, status: done === "verified" ? "verified-done" : "closed" });
    else if (done === "journal") new Reports(state.dir).report(key, "done", "finished", clock.now());
    if (runtime === "hc") world.terminals = {};
    else if (vanish === "gone") world.herdrGone = [PANE];
    else world.herdrDead = [PANE];
  };
  const clock = { at: T0, now: () => clock.at, sleep: async (ms: number) => {
    clock.at += ms;
    // the start wait's own sleeps (the 20 s check, 10 s re-reads), not the short polls while the tab opens
    if (!fired && ms >= 10_000 && clock.at >= T0 + at * 1000) {
      fired = true;
      await finish();
    }
  } };
  base = depsFor(world, clock, state.dir, runtime === "hc" ? { backend: "herdr", runtime: "hc" } : {});
  const deps: FlowDeps = { ...base, run: async (argv, o) => {
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: PANE }, tab_id: "w:t9" } }), err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
    return (base as FlowDeps).run(argv, o);
  } };
  const previous = process.env["DORI_RUNTIME"];
  if (runtime === "hc") process.env["DORI_RUNTIME"] = "hc";
  try {
    return (await launchLane(deps, { noThread: "QA", key, title: key, brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "m" })).startup;
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"];
    else process.env["DORI_RUNTIME"] = previous;
  }
};

for (const runtime of ["herdr", "hc"] as const) {
  const pane = runtime === "hc" ? "hc:t1" : PANE;
  for (const at of [1, 40]) {
    for (const done of ["verified", "closed", "journal"] as const) {
      test(`${runtime}: a lane ${done} done whose pane goes ${at} s after launch is STARTUP_DONE`, async () => {
        expect(await launchFinishing(runtime, "fast", at, done)).toBe("STARTUP_DONE fast");
      });
    }
    test(`${runtime}: an unfinished lane whose pane goes ${at} s after launch stays STARTUP_ERROR`, async () => {
      expect(await launchFinishing(runtime, "fast", at, "none")).toStartWith(`STARTUP_ERROR fast ${pane}: `);
    });
  }
}

test("a lane reported done whose agent exited in a pane still there stays STARTUP_ERROR", async () => {
  expect(await launchFinishing("herdr", "fast", 40, "journal", "dead")).toBe(`STARTUP_ERROR fast ${PANE}: no agent runs in the pane any more`);
});
