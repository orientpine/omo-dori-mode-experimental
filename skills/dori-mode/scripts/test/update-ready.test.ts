import { expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartService } from "../src/update-ready.ts";
import { withState } from "./fakes.ts";

test("waits for a whole new line when the historical log ends with a partial line", async () => {
  // Given
  const state = withState();
  try {
    const log = join(state.dir, "service.log");
    writeFileSync(log, "old READY");
    let time = 0;
    let sleeps = 0;
    const deps = {
      timeoutSec: 1,
      systemctl: async () => { appendFileSync(log, "\nRE"); return { code: 0, out: "", err: "" }; },
      clock: { now: () => time, sleep: async (ms: number) => { time += ms; sleeps++; appendFileSync(log, "ADY\n"); } },
    };
    // When
    const reason = await restartService(deps, { unit: "test", paths: [], log, ready: "^READY$" });
    // Then
    expect(reason).toBeUndefined();
    expect(sleeps).toBe(1);
  } finally { state.done(); }
});

test("rejects an unterminated ready fragment when the timeout expires", async () => {
  // Given
  const state = withState();
  try {
    const log = join(state.dir, "service.log");
    let time = 0;
    // When
    const reason = await restartService({
      timeoutSec: 1, clock: { now: () => time, sleep: async (ms) => { time += ms; } },
      systemctl: async () => { writeFileSync(log, "READY"); return { code: 0, out: "", err: "" }; },
    }, { unit: "test", paths: [], log, ready: "^READY$" });
    // Then
    expect(reason).toBe("ready timeout after 1s");
    expect(time).toBe(1000);
  } finally { state.done(); }
});

test("times out when is-active never succeeds and ready is empty", async () => {
  // Given
  let time = 0;
  const calls: string[][] = [];
  // When
  const reason = await restartService({
    timeoutSec: 1, clock: { now: () => time, sleep: async (ms) => { time += ms; } },
    systemctl: async (args) => { calls.push([...args]); return { code: args.includes("restart") ? 0 : 3, out: "inactive", err: "" }; },
  }, { unit: "test", paths: [], log: "", ready: "" });
  // Then
  expect(reason).toBe("ready timeout after 1s");
  expect(calls).toContainEqual(["systemctl", "--user", "is-active", "test"]);
  expect(time).toBe(1000);
});
