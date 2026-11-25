// Ported from https://github.com/sisyphuslabs/dori-superagent/pull/284.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { renderBrief } from "../src/launch-render.ts";
import { runtimesFor } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test("leadRuntime accepts a terminal runtime without changing the terminal default", async () => {
  const state = withState();
  try {
    const path = join(state.dir, "config.json");
    await Bun.write(path, JSON.stringify({ runtime: "hc", leadRuntime: "hc" }));
    const config = await loadConfig(path);
    const rts = runtimesFor(config, { DORI_RUNTIME: "herdr" });
    expect([rts.default.kind, rts.lane.kind, rts.lead.kind]).toEqual(["herdr", "herdr", "hc"]);
    await Bun.write(path, JSON.stringify({ runtime: "hc", leadRuntime: "tmux" }));
    await expect(loadConfig(path)).rejects.toThrow(/leadRuntime/);
  } finally { state.done(); }
});

test("a terminal lane can send its report to an explicitly selected hc lead", async () => {
  const state = withState();
  try {
    const id = "t3";
    const brief = join(state.dir, "brief.md");
    await Bun.write(brief, "Do the thing.\n");
    const deps = depsFor(newWorld(), fakeClock(0), state.dir, { runtime: "hc", leadPane: id });
    const config = { ...deps.config, leadRuntime: "hc" as const };
    const { text } = await renderBrief({ ...deps, config }, { key: "fix-x", title: "fix", brief, done: "closed acme/app#3" });
    expect(text).toContain(`cli.ts","type","hc:${id}","--text","<report line>"`);
  } finally { state.done(); }
});
