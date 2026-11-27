import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdAdmission } from "../src/checkpoint-lock.ts";
import { admissionFile, admitOwnerCommand } from "../src/handover-drain.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "admission-"));
  dirs.push(d);
  return d;
};

// a separate process that takes the lock, prints TOOK ok|busy, and on a line on stdin lets go and prints RELEASED
const holder = async (dir: string, lock: string, mode: "shared" | "exclusive") => {
  const script = join(dir, `${mode}-${Math.random().toString(36).slice(2)}.ts`);
  await Bun.write(script, `import { holdAdmission } from ${JSON.stringify(join(import.meta.dir, "..", "src", "checkpoint-lock.ts"))};
const release = holdAdmission(${JSON.stringify(lock)}, ${JSON.stringify(mode)});
console.log(release ? "TOOK ok" : "TOOK busy");
for await (const _ of console) break;
release?.();
console.log("RELEASED");`);
  const p = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = p.stdout.getReader();
  const line = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value).trim();
  const took = await line();
  return {
    took,
    let: async (): Promise<string> => {
      p.stdin.write("go\n");
      p.stdin.flush();
      const out = await line();
      await p.exited;
      return out;
    },
  };
};

test("two dori commands hold the admission lock shared at once; the handover cannot take it until the last one let go, and the file stays (challenge r8 of #533)", async () => {
  // Given two processes holding the lock shared
  const dir = fresh();
  const lock = admissionFile(dir, "hc:t1");
  const a = await holder(dir, lock, "shared");
  const b = await holder(dir, lock, "shared");
  // When the first lets go while the second still holds it, and then the second
  const aGone = await a.let();
  const whileB = await holder(dir, lock, "exclusive");
  await whileB.let();
  const bGone = await b.let();
  const afterB = await holder(dir, lock, "exclusive");
  await afterB.let();
  // Then the exclusive take fails while any shared holder lives, and the lock file is never removed
  expect([a.took, b.took, aGone, whileB.took, bGone, afterB.took, existsSync(lock)]).toEqual(["TOOK ok", "TOOK ok", "RELEASED", "TOOK busy", "RELEASED", "TOOK ok", true]);
});

test("a dori command waits only a short while for the handover's exclusive hold, then goes on without the lock and says so; free, it takes the lock shared", async () => {
  // Given a handover holding a pane's lock exclusive, and a clock whose sleeps pass at once
  const dir = fresh();
  const ex = holdAdmission(admissionFile(dir, "hc:t1"), "exclusive");
  let t = 1_000_000;
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  // When a command of that pane is admitted, and one of another pane
  const blocked = await admitOwnerCommand(dir, "hc:t1", clock);
  const other = await admitOwnerCommand(dir, "hc:t2", clock);
  const exOther = holdAdmission(admissionFile(dir, "hc:t2"), "exclusive");
  ex?.();
  other.release?.();
  // Then the first went on without it within its bound, with a line for the watch log; the other holds its own lock shared
  expect([ex !== undefined, blocked.release, blocked.line?.startsWith("ADMISSION_WAIT_PASSED hc:t1:"), t - 1_000_000 <= 3_000, other.line, exOther]).toEqual([true, undefined, true, true, undefined, undefined]);
});

test("a pane that is not a tmux or hc pane (a service, a plain shell) is admitted without a lock", async () => {
  // Given no pane
  const dir = fresh();
  // When a command without a pane is admitted
  const r = await admitOwnerCommand(dir, "", { now: () => 0, sleep: async () => {} });
  // Then nothing is held and nothing is logged
  expect([r.release, r.line, existsSync(join(dir, "handover", "admission"))]).toEqual([undefined, undefined, false]);
});
