import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitToPane } from "../src/panes.ts";
import type { Runner } from "../src/run.ts";
import { FakeHc, terminal } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, RUNNING } from "./fakes.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-stale-block-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runnerOf = (fake: FakeHc): Runner => async (argv) => {
  if (argv[0] !== "hc") return { code: 1, out: "", err: "not here" };
  const r = await fake.exec("hc", argv.slice(1));
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
};

// A blocked status whose dialog is gone (2026-11-12, hc:t2r): senpi took the permission dialog off the screen without
// settling it, so the status stayed blocked for hours over omo's own empty input box, which no dialog holds focus of
const BLOCKED = { state: "blocked", app: "omo" };
const IDLE_BOX = "the last reply\n─────\n❯ \n─────\n~/w • main\n(OmO) watching 6";
const OLD = (): number => Date.now() - 30 * 60_000;

test("a long-blocked hc pane whose screen shows omo's idle input box takes the text", async () => {
  const fake = new FakeHc({ t1: terminal({ status: BLOCKED, status_ms: OLD(), screen: IDLE_BOX }) });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  const base = runnerOf(fake);
  // omo starts a turn on the text it took, as it does over the stale status
  const run: Runner = async (argv, o) => {
    const r = await base(argv, o);
    const t1 = fake.terminals.get("t1");
    if (argv.includes("send") && r.code === 0 && t1) t1.screen = `${RUNNING}\n─────\n❯ \n─────`;
    return r;
  };
  expect(await submitToPane(run, deps.clock, deps.config, "hc:t1", "[LEAD] hi")).toMatchObject({ status: "SUBMITTED" });
  expect(fake.sent).toEqual([{ id: "t1", text: "[LEAD] hi" }]);
});

test("a blocked hc pane gets nothing typed while its dialog is on screen, its turn runs, its editor holds a draft, or the block is new", async () => {
  const dialog = "─────\nPermission required: external_directory\n→ Allow once\n  Always\n  Reject\n─────\n(OmO) watching 6";
  const running = "── • Working (3s • esc to interrupt) ──\n❯ \n─────\n(OmO) watching 6";
  const fake = new FakeHc({
    t1: terminal({ status: BLOCKED, status_ms: OLD(), screen: dialog }),
    t2: terminal({ status: BLOCKED, status_ms: OLD(), screen: running }),
    t3: terminal({ status: BLOCKED, status_ms: Date.now(), screen: IDLE_BOX }),
    t4: terminal({ status: BLOCKED, screen: IDLE_BOX }),
    // the owner's unfinished draft, one line or several, would go out with the text (review 1 of #464)
    t5: terminal({ status: BLOCKED, status_ms: OLD(), screen: IDLE_BOX.replace("❯ ", "❯ half typed") }),
    t6: terminal({ status: BLOCKED, status_ms: OLD(), screen: IDLE_BOX.replace("❯ ", "❯ line one\n  line two") }),
  });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  for (const pane of ["hc:t1", "hc:t2", "hc:t3", "hc:t4", "hc:t5", "hc:t6"])
    expect(await submitToPane(runnerOf(fake), deps.clock, deps.config, pane, "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: expect.stringContaining("PANE_BLOCKED") });
  expect(fake.sent).toEqual([]);
});
