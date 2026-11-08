// From upstream dori-superagent test/runtime-herdr-screen.test.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/test/runtime-herdr-screen.test.ts).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { omoScreenIdle } from "../src/runtime/herdr/index.ts";
import { ref, world } from "./herdr-recorder.ts";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("omoScreenIdle (#62: herdr reports an omo with live monitors as working)", () => {
  test("idle input rule between turns, monitors still live: idle; a real turn: not idle", async () => {
    expect(omoScreenIdle(await screen("omo-idle-live-monitors"))).toBe(true);
    expect(omoScreenIdle(await screen("omo-turn"))).toBe(false);
  });

  test("doubt keeps it working: dialog, draft in the input, no box, unknown layout, empty read", async () => {
    expect(omoScreenIdle(await screen("omo-dialog"))).toBe(false);
    expect(omoScreenIdle(await screen("omo-draft"))).toBe(false);
    expect(omoScreenIdle("$ ls\nREADME.md\n$ ")).toBe(false);
    expect(omoScreenIdle("──────────\n❯\nsomething else\n")).toBe(false);
    expect(omoScreenIdle("")).toBe(false);
  });

  test("esc to interrupt anywhere, or an idle box scrolled up above other output, is not idle", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoScreenIdle("── • Working (9s • esc to interrupt) ──\n" + idle)).toBe(false);
    expect(omoScreenIdle(idle + "\n".repeat(2) + ["more", "output", "below", "the", "box"].join("\n"))).toBe(false);
  });

  test("probe of a working pane reads 30 recent lines and reports idle only for an idle omo screen", async () => {
    const { w, rt, herdr } = world();
    const p = w.addPane("w1:p1", "working");
    for (const [name, want] of [
      ["omo-idle-live-monitors", "idle"],
      ["omo-turn", "working"],
      ["omo-dialog", "working"],
      ["omo-draft", "working"],
    ] as const) {
      p.screen = await screen(name);
      expect((await rt.probe(ref("w1:p1"))).status).toBe(want);
    }
    expect(herdr()).toContainEqual(["pane", "read", "w1:p1", "--lines", "30", "--source", "recent"]);
    p.screen = undefined;
    expect((await rt.probe(ref("w1:p1"))).status).toBe("working");
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, rt, herdr } = world();
    w.addPane("w1:p1", "blocked").screen = await screen("omo-idle-live-monitors");
    expect((await rt.probe(ref("w1:p1"))).status).toBe("blocked");
    expect(herdr().some((a) => a[1] === "read")).toBe(false);
  });
});
