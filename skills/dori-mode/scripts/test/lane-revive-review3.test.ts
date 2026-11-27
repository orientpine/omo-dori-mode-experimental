import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CheckpointError, takeLock } from "../src/checkpoint-lock.ts";
import { closeLane } from "../src/done-flow.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";
import { laneOf, reviveRig, T0 } from "./lane-revive-rig.ts";

// Review 3 of #535: a failed start's rollback runs under the lane's lifecycle lock, a close takes a revived pane down the
// way it takes its own (processes that outlive it stopped). Review 4: a running handover moves the lane itself.
let state: ReturnType<typeof withState>;
const saved = process.env["DORI_RUNTIME"];
beforeEach(() => {
  state = withState();
  process.env["DORI_RUNTIME"] = "hc";
});
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
  state.done();
});

const lifecycleHeld = (): boolean => {
  try {
    takeLock(join(state.dir, "revive", "h3-charsheet.lifecycle.lock"), T0, "probe", "h3-charsheet")();
    return false;
  } catch (e) {
    if (e instanceof CheckpointError) return true;
    throw e;
  }
};

test("a refused start puts the gone pane back only under the lifecycle lock, so a close cannot land between its read and write", async () => {
  // Given: the agent start is refused; every registry read after it notes whether the lifecycle lock is held
  let failed = false;
  const held: boolean[] = [];
  const { fake, deps } = reviveRig(state.dir, {
    before: (argv) => {
      if (argv[0] === "hc" && argv[2] === "send") failed = true;
    },
  });
  fake.knobs.sendError = "invalid_params";
  const base = deps(T0);
  const registry = new (class extends Registry {
    override async read(key: string) {
      if (failed) held.push(lifecycleHeld());
      return super.read(key);
    }
  })(state.dir);
  const d = { ...base, registry };
  await d.registry.write(laneOf(state.dir));
  // When
  expect(await reviveTarget(d, "h3-charsheet", "")).toContain("that pane was closed");
  // Then: the rollback read the lane under the lock and put the gone pane back
  expect(held.slice(0, 1)).toEqual([true]);
  expect((await registry.read("h3-charsheet"))?.pane).toBe("hc:t27");
});

test("a close takes a revived pane down as it takes its own: the lane process that outlives the terminal is stopped too", async () => {
  // Given: the revived terminal (root pid 900) runs omo (4242), which runs a job (4300) that stays after the terminal goes
  const snapshot = laneOf(state.dir, { thread: "none", done: "merged acme/app#1" });
  let closing: Promise<{ readonly closed: boolean; readonly lines: string[] }> | undefined;
  const START = "Thu Nov 26 23:00:00 2026";
  const tables = [["900 1 Ss bash", "4242 900 Sl omo", "4300 4242 S sleep 9999"], ["4300 1 S sleep 9999"]];
  const starts = [[900, 4242, 4300], [4300]];
  const ok = (out = "") => ({ code: 0, out, err: "" });
  const { w, deps } = reviveRig(state.dir, {
    before: (argv) => {
      if (argv[0] === "hc" && argv[2] === "send" && !closing) closing = closeLane(deps(T0), snapshot, "done");
    },
    answer: (argv) => {
      if (argv[0] === "ps" && argv[1] === "-A") return ok((tables.length > 1 ? tables.shift() : tables[0])?.join("\n"));
      if (argv[0] === "ps" && argv[2] === "pid=,lstart=") return ok((starts.length > 1 ? starts.shift() : starts[0])?.map((p) => `${p} ${START}`).join("\n"));
      if (argv[0] === "cat" && argv[1] === "/proc/900/environ") return ok("HOME=/home/test\0HC_TERMINAL_ID=t1\0");
      if (argv[0] === "kill") {
        w.calls.push([...argv]);
        return ok();
      }
      return undefined;
    },
  });
  const d = deps(T0);
  await d.registry.write(snapshot);
  // When
  await reviveTarget(d, "h3-charsheet", "");
  const result = await closing;
  // Then: closed, and the job under the revived pane got the same stop a lane's own leftovers get
  expect(result?.closed).toBe(true);
  expect(w.calls.some((c) => c[0] === "kill" && c.includes("4300"))).toBe(true);
});

test("a revive refuses while a handover of the lane runs, and one starting while the new pane opens leaves the record as it was", async () => {
  // Given: a handover holds the lane (its lock names a live process)
  const lock = join(state.dir, "handover", "lanes", "h3-charsheet.lock");
  const hold = () => {
    mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid }));
  };
  hold();
  const first = reviveRig(state.dir);
  const d = first.deps(T0);
  await d.registry.write(laneOf(state.dir));
  // When / Then: nothing opened
  expect(await reviveTarget(d, "h3-charsheet", "")).toBe("REVIVE_FAIL h3-charsheet: a handover of the lane is running or holds hc:t27; it moves the lane itself, so nothing was opened");
  expect(first.fake.calls.some((c) => c[0] === "run")).toBe(false);
  // Given: the handover starts only once the new terminal is being made
  rmSync(lock);
  const second = reviveRig(state.dir, { before: (argv) => void (argv[0] === "hc" && argv[2] === "run" && hold()) });
  // When / Then: the new pane is not written and is closed unused
  expect(await reviveTarget(second.deps(T0), "h3-charsheet", "")).toContain("a handover of the lane is running or holds hc:t27");
  expect((await d.registry.read("h3-charsheet"))?.pane).toBe("hc:t27");
  expect(second.fake.sent.length).toBe(0);
});
