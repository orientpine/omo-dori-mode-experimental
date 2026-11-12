import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane, startupFailure } from "../src/launch.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, newWorld, withState, type World } from "./fakes.ts";

// hc's read already joins the rows a long line wraps onto: its text is ghostty-vt's plain_text, "soft wraps joined"
// (herdrdev/herdr-core crates/ghostty-vt/src/lib.rs, since ca5699ab), and hc 0.1.18 at 200 columns gave a 210-cell line
// back whole and kept an exactly 200-cell line apart from the next (review 3 of #471, qa/hc-wrap-probe.txt). So every
// row launch reads is a line the agent printed, and the screens here are written that way. dori-superagent PR #205
// (SUL-1.0: NOTICE, https://github.com/sisyphuslabs/dori-superagent/pull/205) and #470 joined full-width rows instead,
// which only ever glued two printed lines; that join is gone. Bun's tail after an extension's missing module names the
// extension's own path, which may hold a failure word (quota-meter).

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const BOX = "────────\n❯ \n────────";
const WARNING = `Warning: Failed to load extension "/Users/someone/.omo/agent/extensions/memory-sync/index.js": Failed to load extension: Cannot find module '/Users/someone/.omo/agent/extensions/memory-sync/node_modules/gone/dist/index.mjs'`;

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("Bun's tail after the missing module names the extension's own path: a directory named quota-meter is no failure", () => {
  for (const tail of [" imported from /Users/someone/.omo/agent/extensions/quota-meter/index.js", " from '/Users/someone/.omo/agent/extensions/quota-meter/index.js'"])
    expect(startupFailure(`${WARNING}${tail}\n${BOX}`)).toBeUndefined();
});

test("omo's own error line, as hc reads it back whole however narrow the pane, reports its phrase", () => {
  expect(startupFailure(`Error: rate limit reached, retry later\n${BOX}`)).toBe("rate limit reached");
  expect(startupFailure(`Error: No API key found for anthropic\n${BOX}`)).toBe("No API key");
  expect(startupFailure(` All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: 2026-01-01T13:00:00.000Z.\n${BOX}`)).toBe("accounts for anthropic-subscription are currently blocked");
  expect(startupFailure(` The fakep account usage limit has been reached. Switch to another provider with /model.\n${BOX}`)).toBe("account usage limit has been reached");
});

// Each row is its own printed line, whatever its width: none is glued to the next (the join manufactured these, challenge
// of the review 3 plan): an own error line exactly as wide as the pane keeps its phrase, and two lines never make one.
test("two printed lines are never read as one, whatever their width", () => {
  expect(startupFailure(`Error: all quotas exhausted\n/tmp/w\n${BOX}`)).toBe("quotas exhausted");
  expect(startupFailure(`Error: rate limit reached\nPlease retry later\n${BOX}`)).toBe("rate limit reached");
  expect(startupFailure(`Error: rate limit\nreached the end of the log\n${BOX}`)).toBeUndefined();
  expect(startupFailure(`Error: tool output for quota\nexceeded checks is below\n${BOX}`)).toBeUndefined();
  expect(startupFailure(`Error: notes in /x/briefs/\nquota exhausted handling.md\n${BOX}`)).toBeUndefined();
  expect(startupFailure(`load is moderate\nlimits apply\n${BOX}`)).toBeUndefined();
  // a warning line as wide as the pane is followed by omo's own error on the next printed line: that error still counts
  const exact = `Warning: Failed to load extension "x.js": Cannot find module '${"a".repeat(17)}'`;
  expect(startupFailure(`${exact}\nError: No API key found\n${BOX}`)).toBe("No API key");
});

// launch on an hc terminal of the given width (hc get), its screen read back as hc does
const hcLaunch = async (key: string, cols: number, screen: string): Promise<string> => {
  const previous = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    world.terminals = { t1: hcTerm({ cols }) };
    const brief = join(state.dir, "brief.md");
    await Bun.write(brief, "# brief\n");
    const base = depsFor(world, { now: () => T0, sleep: async () => {} }, state.dir, { backend: "herdr", runtime: "hc" });
    const run: FlowDeps["run"] = async (argv, o) => {
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "read") return { code: 0, out: JSON.stringify({ text: screen, complete: true, how: "screen" }), err: "" };
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
      return base.run(argv, o);
    };
    const { startup } = await launchLane({ ...base, run }, { noThread: "QA", key, title: key, brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "m" });
    return startup;
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"];
    else process.env["DORI_RUNTIME"] = previous;
  }
};

test("an hc lane whose own error shows on its screen is STARTUP_ERROR at the first check, at any pane width", async () => {
  expect(await hcLaunch("hc-narrow", 12, `Error: rate limit reached, retry later\n${BOX}`)).toBe("STARTUP_ERROR hc-narrow hc:t1: rate limit reached");
  // an own error line exactly as wide as the pane, then a path line: not glued, the error stands (challenge of review 3's plan)
  expect(await hcLaunch("hc-exact", 27, `Error: all quotas exhausted\n/tmp/w\n${BOX}`)).toBe("STARTUP_ERROR hc-exact hc:t1: quotas exhausted");
});

test("on hc, an own line one cell short of the pane and the next printed line never make a failure together", async () => {
  expect(await hcLaunch("hc-short", 18, `Error: rate limit\nreached the end of the log\n${BOX}`)).not.toStartWith("STARTUP_ERROR");
});
