import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { footer, cliCommand } from "../src/launch-footer.ts";
import { renderBrief } from "../src/launch-render.ts";
import { Registry, type Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState, depsFor, fakeClock, newWorld } from "./fakes.ts";

test("relative selectors resolve from the launching cwd before the command runs elsewhere", async () => {
  const state = withState();
  const previousCwd = process.cwd();
  const previousConfig = process.env["DORI_CONFIG"];
  try {
    const launchRoot = join(state.dir, "srv-dori");
    const stateDir = join(launchRoot, "state");
    const unrelated = join(state.dir, "srv-worktree");
    mkdirSync(launchRoot, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(launchRoot, "config.json"), JSON.stringify({ stateDir: "./state", defaultCwd: launchRoot, hooks: {} }));
    const brief = join(launchRoot, "brief.md");
    writeFileSync(brief, "do the work\n");
    process.chdir(launchRoot);
    process.env["DORI_CONFIG"] = "./config.json";
    const deps = depsFor(newWorld(), fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir, { stateDir: "./state", defaultCwd: launchRoot });
    const rendered = await renderBrief(deps, { key: "report-lane", title: "reports", brief, done: "file /done", noThread: "QA", cwd: unrelated });
    const command = rendered.text.match(/with (.+ report) /)?.[1];
    expect(command).toContain(`DORI_CONFIG=${join(launchRoot, "config.json")}`);
    expect(command).toContain(`DORI_STATE_DIR=${stateDir}`);
    await new Registry(stateDir).write({ key: "report-lane", title: "reports", thread: "none", brief: "/b.md", done: "file /done", openedAt: "2026-01-01T12:00:00.000Z" });
    const child = Bun.spawn(["sh", "-c", `${command} report-lane --kind milestone --text "relative bound"`], {
      cwd: unrelated,
      env: { HOME: join(state.dir, "home"), PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, out, err }).toEqual({ code: 0, out: "[REPORT] report-lane | milestone | relative bound\n", err: "" });
    expect(new Reports(stateDir).read("report-lane")?.lastReport?.text).toBe("relative bound");
  } finally {
    process.chdir(previousCwd);
    if (previousConfig === undefined) delete process.env["DORI_CONFIG"];
    else process.env["DORI_CONFIG"] = previousConfig;
    state.done();
  }
});

// Runs wherever PowerShell 7 is installed (the windows workflow; PWSH_TEST_BIN elsewhere), like the other pwsh tests.
const pwsh = process.env["PWSH_TEST_BIN"] ?? Bun.which("pwsh");
test.skipIf(!pwsh)("the generated PowerShell command reports into a non-default state", async () => {
  const state = withState();
  try {
    const stateDir = join(state.dir, "state");
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir, defaultCwd: state.dir, hooks: {} }));
    await new Registry(stateDir).write({ key: "report-lane", title: "reports", thread: "none", brief: "/b.md", done: "file /done", openedAt: "2026-01-01T12:00:00.000Z" });
    const command = cliCommand(undefined, { config, stateDir }, "win32");
    expect(command).not.toStartWith("env ");
    expect(command).toContain("Set-Item");
    expect(command).toContain("$doriArgv");
    const argv = [pwsh ?? "pwsh", "-NoProfile", "-NonInteractive", "-Command", `${command} report report-lane --kind milestone --text "pwsh report"`];
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: 180_000, killSignal: "SIGKILL" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, out, err }).toEqual({ code: 0, out: "[REPORT] report-lane | milestone | pwsh report\n", err: "" });
    expect(new Reports(stateDir).read("report-lane")?.lastReport?.text).toBe("pwsh report");
  } finally { state.done(); }
}, 200_000);

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
