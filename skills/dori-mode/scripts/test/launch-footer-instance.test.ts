import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { footer } from "../src/launch-footer.ts";
import { Registry, type Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";

test("the generated report command binds a non-default instance without DORI_ENV_FILE", async () => {
  const state = withState();
  try {
    const home = join(state.dir, "home");
    const configDir = join(state.dir, "instance");
    const stateDir = join(state.dir, "state");
    const unrelated = join(state.dir, "unrelated");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    const config = join(configDir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir, defaultCwd: join(state.dir, "default"), hooks: {} }));
    const lane: Lane = { key: "report-lane", title: "reports", thread: "none", brief: "/b.md", done: "file /done", openedAt: "2026-01-01T12:00:00.000Z" };
    await new Registry(stateDir).write(lane);
    const text = footer(lane, "lead:p1", "herdr", [], { config, stateDir });
    const command = text.match(/with (.+ report) /)?.[1];
    expect(command).toBeDefined();
    expect(command).toContain("DORI_CONFIG=");
    expect(command).toContain("DORI_STATE_DIR=");
    expect(command).not.toContain("DORI_ENV_FILE");
    const child = Bun.spawn(["sh", "-c", `${command} report-lane --kind milestone --text "bound report"`], {
      cwd: unrelated,
      env: { HOME: home, PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, out, err }).toEqual({ code: 0, out: "[REPORT] report-lane | milestone | bound report\n", err: "" });
    expect(new Reports(stateDir).read("report-lane")?.lastReport?.text).toBe("bound report");
    expect(existsSync(join(home, ".dori", "state"))).toBe(false);
  } finally { state.done(); }
});
