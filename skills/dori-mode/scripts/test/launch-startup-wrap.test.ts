import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane, startupFailure } from "../src/launch.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, newWorld, withState, type World } from "./fakes.ts";

// hc prints a long line as rows cut at the pane's width, trailing blanks dropped, so omo's own error line can carry its
// failure words across a wrap (dori-superagent PR #205 reproduced here (SUL-1.0: NOTICE):
// https://github.com/sisyphuslabs/dori-superagent/pull/205), and Bun's tail after an extension's missing module names the
// extension's own path, which may hold a failure word (quota-meter).

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const BOX = "────────\n❯ \n────────";
// rows as hc prints them: cut every `width` characters, trailing blanks dropped (so a wrap on a space loses it)
const wrap = (text: string, width: number): string => (text.match(new RegExp(`.{1,${width}}`, "g")) ?? []).map((row) => row.trimEnd()).join("\n");
const WARNING = `Warning: Failed to load extension "/Users/someone/.omo/agent/extensions/memory-sync/index.js": Failed to load extension: Cannot find module '/Users/someone/.omo/agent/extensions/memory-sync/node_modules/gone/dist/index.mjs'`;

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("Bun's tail after the missing module names the extension's own path: a directory named quota-meter is no failure, wrapped or not", () => {
  for (const tail of [" imported from /Users/someone/.omo/agent/extensions/quota-meter/index.js", " from '/Users/someone/.omo/agent/extensions/quota-meter/index.js'"]) {
    expect(startupFailure(`${WARNING}${tail}\n${BOX}`)).toBeUndefined();
    expect(startupFailure(`${wrap(`${WARNING}${tail}`, 80)}\n${BOX}`, false, 80)).toBeUndefined();
  }
});

test("omo's own error line wrapped by hc still counts: a cut space is put back, a cut inside a word is joined as is", () => {
  const limited = wrap("Error: rate limit reached, retry later", 12);
  expect(limited.split("\n")[0]).toBe("Error: rate");
  expect(startupFailure(`${limited}\n${BOX}`, false, 12)).toBe("rate limit reached");
  const noKey = wrap("Error: No API key found for anthropic", 12);
  expect(noKey.split("\n")[0]).toBe("Error: No AP");
  expect(startupFailure(`${noKey}\n${BOX}`, false, 12)).toBe("No API key");
  // without the pane's width no row is taken as wrapped, as before
  expect(startupFailure(`${limited}\n${BOX}`)).toBeUndefined();
});

test("omo's provider notices count when the wrap cuts their own marker: blocked accounts and a reached usage limit at 40 columns (review 1 of #470)", () => {
  const blocked = wrap(" All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).", 40);
  expect(blocked.split("\n")[0]).not.toContain("blocked");
  expect(startupFailure(`${blocked}\n  Soonest automatic retry: 2026-01-01T13:00:00.000Z.\n${BOX}`, false, 40)).toBe("accounts for anthropic-subscription are currently blocked");
  const limit = wrap(" The fakep account usage limit has been reached. Switch to another provider with /model.", 40);
  expect(limit.split("\n")[0]).not.toContain("reached");
  expect(startupFailure(`${limit}\n${BOX}`, false, 40)).toBe("account usage limit has been reached");
});

test("only rows that fill the pane go on: a real line break, a warning row and code that only looks like a failure are none", () => {
  expect(startupFailure(`Error: tool rate\nlimits apply\n${BOX}`, false, 40)).toBeUndefined();
  expect(startupFailure(`load is moderate\nlimits apply\n${BOX}`, false, 16)).toBeUndefined();
  expect(startupFailure(`const rateLimit = ratelimiter(noApiKey, usageLimit); // SessionCrashed\n${BOX}`, false, 30)).toBeUndefined();
  // a warning whose last row fills the pane is followed by omo's own error on the next printed line: that error still counts
  const exact = `Warning: Failed to load extension "x.js": Cannot find module '${"a".repeat(17)}'`;
  expect(exact.length).toBe(80);
  expect(startupFailure(`${exact}\nError: No API key found\n${BOX}`, false, 80)).toBe("No API key");
});

// dori-superagent PRs #206 and #207 (SUL-1.0: NOTICE, https://github.com/sisyphuslabs/dori-superagent/pull/207, its
// launch-startup-wait.test.ts hc-filled and hc-glue cases): an own error row exactly as wide as the pane is joined to the
// next row as is, and a phrase glued on after a letter still counts, as a provider prints it.
test("a failure phrase glued onto a full-width own error row counts, and reports the whole phrase", () => {
  const row = "Error: loading ok";
  for (const [line, found] of [["No API key found", "No API key"], ["Rate limit exceeded", "Rate limit exceeded"], ["Quota exceeded for model", "Quota exceeded"], ["Usage limit reached", "Usage limit reached"]] as const)
    expect([line, startupFailure(`${row}\n${line}\n${BOX}`, false, row.length)]).toEqual([line, found]);
  // a kebab-case name glued the same way is none
  expect(startupFailure(`${row}\nfix-rate-limit-error lane\n${BOX}`, false, row.length)).toBeUndefined();
});

test("an hc lane whose own error wraps on a narrow pane is STARTUP_ERROR at the first check", async () => {
  const previous = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    world.terminals = { t1: hcTerm({ cols: 12 }) };
    const brief = join(state.dir, "brief.md");
    await Bun.write(brief, "# brief\n");
    const base = depsFor(world, { now: () => T0, sleep: async () => {} }, state.dir, { backend: "herdr", runtime: "hc" });
    const screen = `${wrap("Error: rate limit reached, retry later", 12)}\n${BOX}`;
    const run: FlowDeps["run"] = async (argv, o) => {
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "read") return { code: 0, out: JSON.stringify({ text: screen, complete: true, how: "screen" }), err: "" };
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
      return base.run(argv, o);
    };
    const { startup } = await launchLane({ ...base, run }, { noThread: "QA", key: "hc-split", title: "hc-split", brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "m" });
    expect(startup).toBe("STARTUP_ERROR hc-split hc:t1: rate limit reached");
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"];
    else process.env["DORI_RUNTIME"] = previous;
  }
});
