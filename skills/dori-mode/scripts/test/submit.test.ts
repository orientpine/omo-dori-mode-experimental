import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { sendVerified, submitToPane } from "../src/panes.ts";
import { editorText, type PaneKeys, SUBMIT_TIMING, submitText } from "../src/submit.ts";
import { announceChange } from "../src/update-announce.ts";
import { fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

const BORDER = "────────────────────────────────────────";
const box = (...lines: string[]): string => ["transcript", BORDER, ...lines, BORDER, " ~/repo • main • 12K/1M"].join("\n");
const busyBox = (...lines: string[]): string => ["transcript", `── • Working (2s • esc to interrupt) ${BORDER}`, ...lines, BORDER, " ~/repo • main"].join("\n");
const PASTED = box("❯ [paste #1 +13 lines]");
const EMPTY = box("❯ ");
const RUNNING = busyBox("❯ ");

// screens are read in order, the last one repeats
const keysFor = (screens: readonly string[]) => {
  const log = { enters: 0, typed: [] as string[], reads: 0 };
  const keys: PaneKeys = {
    type: async (text) => { log.typed.push(text); return undefined; },
    enter: async () => { log.enters++; },
    read: async () => screens[Math.min(log.reads++, screens.length - 1)] ?? "",
  };
  return { keys, log };
};

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a paste-collapsed text left in the input box gets exactly one more Enter and is NOT_SUBMITTED", async () => {
  const { keys, log } = keysFor([PASTED]);
  const r = await submitText(keys, fakeClock(0), "line 1\nline 2");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toContain("[paste #1 +13 lines]");
  expect(log.enters).toBe(2);
});

test("a box that clears after the second Enter, with the turn running, is SUBMITTED", async () => {
  const { keys, log } = keysFor([...Array<string>(SUBMIT_TIMING.clearPolls).fill(PASTED), RUNNING]);
  expect(await submitText(keys, fakeClock(0), "line 1\nline 2")).toEqual({ status: "SUBMITTED", reason: "input box empty and the turn runs" });
  expect(log.enters).toBe(2);
});

test("an empty box without a running turn is NOT_SUBMITTED, even when the transcript quotes the busy mark", async () => {
  const quoted = ["omo prints esc to interrupt while it works", ...Array<string>(10).fill("transcript"), BORDER, "❯ ", BORDER].join("\n");
  const { keys, log } = keysFor([EMPTY, quoted]);
  const r = await submitText(keys, fakeClock(0), "hello");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith("input box empty but no running turn");
  expect(log.enters).toBe(1);
});

test("the text echoed in the transcript above the box is not unsent text", async () => {
  const echoed = ["❯ [paste #1 +13 lines]", busyBox("❯ ")].join("\n");
  const { keys, log } = keysFor([echoed]);
  expect((await submitText(keys, fakeClock(0), "line 1\nline 2")).status).toBe("SUBMITTED");
  expect(log.enters).toBe(1);
});

test("a tall box whose ❯ line scrolled out of view still counts as unsent text", () => {
  expect(editorText(box("line 12 of the announcement", "line 13 of the announcement"))).toBe("line 12 of the announcement line 13 of the announcement");
  expect(editorText(PASTED)).toBe("[paste #1 +13 lines]");
  expect(editorText(EMPTY)).toBe("");
});

test("NOT_SUBMITTED goes to the watch log with the pane and the reason", async () => {
  const world = newWorld();
  world.screen = PASTED;
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, watchLog: join(state.dir, "lanes.log") };
  const r = await submitToPane(fakeRunner(world), fakeClock(0), config, "aoe_lead_0a1b2c3d", "[UPDATE] a\n\nb");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(await Bun.file(config.watchLog).text()).toContain("submit NOT_SUBMITTED aoe_lead_0a1b2c3d text still in the input box after 2 Enters: [paste #1 +13 lines]");
});

test("an update announcement that stays in the lead's input box logs ANNOUNCE_FAIL, never ANNOUNCED", async () => {
  const world = newWorld();
  world.screen = PASTED;
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, leadPane: "aoe_lead_0a1b2c3d", watchLog: join(state.dir, "lanes.log") };
  const run = fakeRunner(world);
  const clock = fakeClock(0);
  expect(await announceChange({ config, clock, print: () => {}, send: (pane, text) => sendVerified(run, clock, config, pane, text) }, { summary: "Guidance updated", files: ["skills/dori-mode/references/sessions.md"] })).toBe(false);
  const log = await Bun.file(config.watchLog).text();
  expect(log).toContain("update ANNOUNCE_FAIL aoe_lead_0a1b2c3d");
  expect(log).not.toContain("ANNOUNCED");
});
