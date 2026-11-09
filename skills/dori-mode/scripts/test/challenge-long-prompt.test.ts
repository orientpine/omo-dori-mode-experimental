import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChallenge } from "../src/challenge.ts";
import type { Lane } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// One spawn argument holds at most 128 KiB on Linux (MAX_ARG_STRLEN): a longer prompt passed as the prompt argument
// fails with E2BIG before omo starts. A fake omo, started by the real runner, records how the prompt reached it.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let bin: string;
beforeEach(() => {
  state = withState();
  bin = mkdtempSync(join(tmpdir(), "dori-fake-omo-"));
});
afterEach(() => {
  state.done();
  rmSync(bin, { recursive: true, force: true });
});

const fakeOmo = (): string => {
  const omo = join(bin, "omo");
  const script = [
    "#!/bin/sh",
    'last=""; for a; do last="$a"; done',
    `printf '%s' "$last" > ${join(bin, "last")}`,
    `if [ "$last" = "-" ]; then cat > ${join(bin, "stdin")}; fi`,
    "printf '## Reasons this will fail\\nx\\n## Missing alternatives\\ny\\n## Cheapest falsifying test\\nz\\n'",
  ];
  writeFileSync(omo, `${script.join("\n")}\n`);
  chmodSync(omo, 0o755);
  return omo;
};

test("a plan longer than one spawn argument may be reaches omo on stdin and is reviewed", async () => {
  const base = depsFor(newWorld(), fakeClock(T0), state.dir);
  const omo = fakeOmo();
  const explore = { ...base.config.explore, modelsCommand: [], challengeCommand: [omo, ...base.config.explore.challengeCommand.slice(1)] };
  const deps = { ...base, run, config: { ...base.config, explore, reviewers: { ...base.config.reviewers, models: ["chatgpt-subscription/gpt-6-astra"] } } };
  const lane: Lane = { key: "long-plan", title: "Long plan", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", cwd: state.dir, model: "anthropic/claude-opus-5-5", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
  await deps.registry.write(lane);
  const plan = join(state.dir, "plan.md");
  const text = `Plan start. ${"가".repeat(50_000)} Plan end.`; // 150 KB in UTF-8, past the 128 KiB of one argument
  await Bun.write(plan, text);
  const r = await runChallenge(deps, lane, plan);
  expect(r.reviews.map((v) => v.record.model)).toEqual(["chatgpt-subscription/gpt-6-astra"]);
  expect(await Bun.file(join(bin, "last")).text()).toBe("-");
  const stdin = await Bun.file(join(bin, "stdin")).text();
  expect(stdin).toContain(text);
  expect(stdin).toContain("## Cheapest falsifying test");
});
