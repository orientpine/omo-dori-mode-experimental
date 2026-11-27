import type { FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { FakeHc, type FakeTerminal } from "./fake-hc.ts";
import { depsFor, fakeClock, fakeRunner, newWorld } from "./fakes.ts";

export const T0 = Date.parse("2026-11-26T00:00:00Z");
export const SESSION = "e365459c-71a6-4e51-a5dd-c8a7298cfb91";
const BOX = "omo · resumed\n────────\n❯ \n────────";

export const laneOf = (cwd: string, patch: Partial<Lane> = {}): Lane => ({ key: "h3-charsheet", title: "H3", thread: "discord:1", brief: "/b.md", done: "file /d", openedAt: new Date(T0 - 3_600_000).toISOString(), pane: "hc:t27", session: SESSION, cwd, model: "anthropic-subscription/claude-opus-5-5:medium", ...patch });

// hc calls go to the fake core (an agent drawing omo's box once the start line is typed), the rest to the world (the lead);
// before runs ahead of each call, so a test can change the world in the middle of a revive
export const reviveRig = (stateDir: string, opts: { readonly initial?: Record<string, FakeTerminal>; readonly before?: (argv: readonly string[]) => Promise<void> | void; readonly patch?: Partial<FlowDeps> } = {}) => {
  const fake = new FakeHc(opts.initial ?? {});
  const w = newWorld();
  w.screens["lead:p1"] = "❯ ";
  const world = fakeRunner(w);
  const run: Runner = async (argv, o) => {
    await opts.before?.(argv);
    if (argv[0] !== "hc") return world(argv, o);
    const r = await fake.exec("hc", argv.slice(1));
    if (argv[2] === "send" && argv[3] && r.code === 0) {
      const t = fake.terminals.get(argv[3]);
      if (t) t.screen = BOX;
    }
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const deps = (ms: number): FlowDeps => ({ ...depsFor(w, fakeClock(ms), stateDir, { backend: "herdr", runtime: "hc", leadPane: "lead:p1" }), run, ...opts.patch });
  return { fake, w, deps };
};
