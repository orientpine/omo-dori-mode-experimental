import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { procId, stopRuns } from "../src/heavy-stale.ts";
import { withState } from "./fakes.ts";

// A helper's `stop <label> [run]` (heavy-stale.ts stopRuns): the stale run alone, never another caller's run or a
// process that only reuses a dead worker's pid, and its worker killed before its folder goes.
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

// a live process standing in for a heavy worker, and the job folder a worker of that caller and label left for it
const fakeRun = (exec: string, caller: string, label: string, recorded?: string) => {
  const p = Bun.spawn(["sleep", "30"]);
  const dir = join(exec, `${p.pid}-x`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "who"), `${caller} ${label} ${recorded ?? procId(p.pid)}`);
  return { p, run: `${p.pid}-x` };
};
const holdSlot = (slots: string, n: number, pid: number) => {
  mkdirSync(join(slots, `slot.${n}`), { recursive: true });
  writeFileSync(join(slots, `slot.${n}`, "owner"), `${pid} t ${new Date().toISOString()}`);
};
// alive and not a zombie (a killed child of this test stays one until reaped)
const alive = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim().replace(/^Z.*/, "") !== "";

test("stop with a run id ends that run alone, not another run of the same caller and label", () => {
  // Given: two runs of label t by one caller (two lanes), each holding a slot
  const exec = join(state.dir, "exec");
  const slots = join(state.dir, "slots");
  const a = fakeRun(exec, "tester", "t");
  const b = fakeRun(exec, "tester", "t");
  holdSlot(slots, 1, a.p.pid);
  holdSlot(slots, 2, b.p.pid);
  try {
    // When
    const n = stopRuns(exec, slots, "tester", "t", a.run);
    // Then
    expect(n).toBe(1);
    expect(alive(a.p.pid)).toBe(false);
    expect(alive(b.p.pid)).toBe(true);
    expect(readdirSync(exec)).toEqual([b.run]);
    expect(readdirSync(slots)).toEqual(["slot.2"]);
  } finally {
    a.p.kill("SIGKILL");
    b.p.kill("SIGKILL");
  }
});

test("stop ends the run even when its folder cannot all be deleted (a read-only folder the job made)", () => {
  // Given: a live run whose folder holds a non-empty read-only folder, and the slot it holds
  const exec = join(state.dir, "exec");
  const slots = join(state.dir, "slots");
  const a = fakeRun(exec, "tester", "t");
  const ro = join(exec, a.run, "in", "ro");
  mkdirSync(ro, { recursive: true });
  writeFileSync(join(ro, "f"), "x");
  Bun.spawnSync(["chmod", "555", ro]);
  holdSlot(slots, 1, a.p.pid);
  try {
    // When
    const n = stopRuns(exec, slots, "tester", "t", a.run);
    // Then
    expect(n).toBe(1);
    expect(alive(a.p.pid)).toBe(false);
    expect(readdirSync(slots)).toEqual([]);
    expect(readdirSync(exec)).toEqual([]);
  } finally {
    Bun.spawnSync(["chmod", "-R", "u+w", exec]);
    a.p.kill("SIGKILL");
  }
});

test("stop leaves another caller's run, and a process that only reuses a dead worker's pid, alone", () => {
  // Given: another caller's live run of the same label, and a left folder of this caller whose recorded worker is not
  // the process now holding that pid (the pid was reused), which holds a slot
  const exec = join(state.dir, "exec");
  const slots = join(state.dir, "slots");
  const other = fakeRun(exec, "other", "t");
  const reused = fakeRun(exec, "tester", "t", "an-earlier-boot 12345");
  holdSlot(slots, 1, reused.p.pid);
  try {
    // When
    const n = stopRuns(exec, slots, "tester", "t");
    // Then: nothing stopped; the left folder is gone, the process and its slot are not
    expect(n).toBe(0);
    expect(alive(other.p.pid)).toBe(true);
    expect(alive(reused.p.pid)).toBe(true);
    expect(readdirSync(exec)).toEqual([other.run]);
    expect(readdirSync(slots)).toEqual(["slot.1"]);
  } finally {
    other.p.kill("SIGKILL");
    reused.p.kill("SIGKILL");
  }
});
