// Ported from https://github.com/sisyphuslabs/dori-superagent/pull/284.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { renderBrief } from "../src/launch-render.ts";
import { runtimesOf } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const configWith = async (body: object) => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify(body));
  return loadConfig(path);
};

test("leadRuntime selects either terminal independently of the default and runtime cache", async () => {
  const { run } = depsFor(newWorld(), fakeClock(0), state.dir);
  const hc = runtimesOf(run, await configWith({ runtime: "herdr", leadRuntime: "hc" }));
  const herdr = runtimesOf(run, await configWith({ runtime: "herdr", leadRuntime: "herdr" }));
  expect([hc.default.kind, hc.lead.kind, herdr.lead.kind]).toEqual(["herdr", "hc", "herdr"]);
});

test.each(["tmux", null, 1])("invalid leadRuntime %p stops loading", async (leadRuntime) => {
  await expect(configWith({ leadRuntime })).rejects.toThrow(/leadRuntime must be "herdr" or "hc"/);
});

test.each([
  { laneRuntime: "hc" },
  { laneRuntime: false },
  { laneRuntime: null },
  { leadRuntime: "omo-host" },
  { leadPane: "omo-host:00000000-0000-4000-8000-000000000123" },
])("unsupported #282 config %j fails with one diagnostic", async (settings) => {
  const error = await configWith(settings).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ConfigError);
  if (!(error instanceof ConfigError)) return;
  expect(error.message).toBe(`${join(state.dir, "config.json")}: the omo-host runtime (upstream #282) is not ported in this fork; leave laneRuntime unset and use leadRuntime "hc" or "herdr"`);
});

test("leadRuntime hc requires a qualified file and environment lead address", async () => {
  await expect(configWith({ leadRuntime: "hc", leadPane: "t3" })).rejects.toThrow(/hc:<terminal>/);
  expect((await configWith({ leadRuntime: "hc", leadPane: "hc:t3" })).leadPane).toBe("hc:t3");
  const previous = process.env["DORI_LEAD_PANE"];
  try {
    process.env["DORI_LEAD_PANE"] = "t4";
    await expect(configWith({ leadRuntime: "hc", leadPane: "hc:t3" })).rejects.toThrow(/hc:<terminal>/);
  } finally {
    if (previous === undefined) delete process.env["DORI_LEAD_PANE"];
    else process.env["DORI_LEAD_PANE"] = previous;
  }
});

test.each([
  ["hc", "t3", "hc:t3"],
  ["herdr", "herdr:w1:p3", "w1:p3"],
] as const)("a terminal lane's report command is bound to its instance and %s lead", async (leadRuntime, leadPane, target) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "Do the thing.\n");
  const deps = depsFor(newWorld(), fakeClock(0), state.dir, { backend: "aoe", runtime: "hc", leadRuntime, leadPane });
  const { text } = await renderBrief(deps, { key: "fix-x", title: "fix", brief, done: "closed acme/app#3" });
  expect(text).toContain(`DORI_STATE_DIR=${state.dir}`);
  if (process.platform === "win32") {
    expect(text).toContain(`'type', '${target}', '--text', '<report line>'`);
  } else {
    const line = text.split("\n").find((line) => line.includes("Report to the lead"));
    expect(line).toContain('run ["env","DORI_CONFIG=');
    expect(line).toContain(`"DORI_STATE_DIR=${state.dir}","bun",`);
    expect(line).toContain(`cli.ts","type","${target}","--text","<report line>"`);
  }
});
