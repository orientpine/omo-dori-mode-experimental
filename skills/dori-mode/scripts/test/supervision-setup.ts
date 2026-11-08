import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { defaultSupervision, type SessionUsage, Supervision, type SupervisionSettings } from "../src/supervision.ts";
import { fakeClock, withState } from "./fakes.ts";

// The meaning of dori-superagent #61's test/supervision.test.ts (15 cases, at 90f02c1), carried over to this fork, where a
// lane's reports are lane.lastReport in the registry instead of a reports.jsonl journal and an alert goes to the lead.
export const start = Date.parse("2026-10-29T00:00:00Z");
export const lane: Lane = { key: "demo-lane", title: "Demo", thread: "none", brief: "", done: "", pane: "w1:p9", openedAt: new Date(start).toISOString() };
export const fixture = (settings: Partial<SupervisionSettings> = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const calls: string[][] = [];
  const alerts: string[] = [];
  let usage = '{"tokens":null,"costUsd":null}';
  let dirty = "";
  let session: SessionUsage | null = null;
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: argv[0] === "usage" ? usage : argv[0] === "git" ? (argv.includes("rev-parse") ? argv[2] ?? "" : dirty) : "", err: "" };
  };
  const deps = { stateDir: state.dir, clock, run, alert: (_lane: Lane, message: string) => { alerts.push(message); return true; }, sessionUsage: async () => session };
  const options: SupervisionSettings = { ...defaultSupervision(), ...settings };
  return {
    ...state, clock, calls, alerts, deps, options, supervisor: new Supervision(deps, options),
    setUsage: (value: string) => { usage = value; }, setDirty: (value: string) => { dirty = value; }, setSession: (value: SessionUsage | null) => { session = value; },
  };
};
