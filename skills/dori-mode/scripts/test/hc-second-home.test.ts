import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";
import { CORE, flowRig } from "./hc-flow-rig.ts";

let dir: string;
const ENV = ["PATH", "DORI_RUNTIME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "HC_SESSION", "HC_FLOW_ROOT"] as const;
let saved: (string | undefined)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-second-home-"));
  saved = ENV.map((k) => process.env[k]);
  process.env["PATH"] = `${dir}:${process.env["PATH"]}`;
  process.env["DORI_RUNTIME"] = "hc";
  process.env["DORI_CONFIG"] = join(dir, "second", "config.json");
  process.env["DORI_ENV_FILE"] = join(dir, "second", "dori.env");
  delete process.env["DORI_STATE_DIR"];
  process.env["HC_FLOW_ROOT"] = dir;
  mkdirSync(join(dir, "second"));
  writeFileSync(join(dir, "second", "dori.env"), `HC_SESSION=${CORE}\n`);
});
afterEach(() => {
  ENV.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("second dori home: an hc lane's agent line carries this home's absolute config, state and env file (#197)", async () => {
  // Given: a Dori whose config and env file are a second home, launching on hc, whose core keeps another environment
  const rig = flowRig(dir);
  const stateDir = join(dir, "second", "state");
  const base = depsFor(newWorld(), fakeClock(Date.parse("2026-11-09T00:00:00Z")), stateDir, { runtime: "hc", backend: "herdr", leadPane: "hc:t1", launchEnv: { CUDA_VISIBLE_DEVICES: "" } });
  const deps: FlowDeps = { ...base, run: rig.run, readGoal: async () => ({ status: "active" }) };
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "# brief\n");

  // When: the lane is launched
  const launched = await launchLane(deps, { noThread: "test lane", model: "test/model", key: "hc-second", title: "hc-second", brief, done: "file /tmp/ok", cwd: dir });

  // Then: the command the hc terminal ran names the second home, and the configured launchEnv still applies
  const line = rig.read().sent.find((s) => s.id !== "t1" && s.text.includes("omo"))?.text ?? "";
  expect(launched.lane.pane).toStartWith("hc:");
  expect(line).toContain(`DORI_CONFIG=${join(dir, "second", "config.json")}`);
  expect(line).toContain(`DORI_STATE_DIR=${stateDir}`);
  expect(line).toContain(`DORI_ENV_FILE=${join(dir, "second", "dori.env")}`);
  expect(line).toContain("CUDA_VISIBLE_DEVICES=");
});
