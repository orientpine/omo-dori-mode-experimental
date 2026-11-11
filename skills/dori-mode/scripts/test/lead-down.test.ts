import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { writeFrozen } from "../src/frozen.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { watchTick } from "../src/done-flow.ts";
import { leadDownTick, REVIVE_SCRIPT } from "../src/lead-down.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-22T09:23:14Z");
const MIN = 60_000;
const PANE = "aoe_Dori_mode_2f5789f9";
const ENV = { DORI_LEAD_AOE_ID: "2f5789f93ea54d8b", DORI_CONFIG: "/home/test/.dori/config.json" };
const OWNER = "100000000000000001";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const leadWorld = () => {
  const w = newWorld();
  const life = { down: true, units: [] as string[][], posts: [] as string[][] };
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, `${JSON.stringify({ ts: new Date(T0 + 5 * MIN).toISOString(), id: "m-1", channel_id: "C-ZZ", scope: "channel", author_id: OWNER, content: "사용량" })}\n`);
  const deps = (ms: number, patch = {}): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { leadPane: PANE, ...patch });
    return {
      ...base,
      run: async (argv, opts) => {
        if (argv[0] === "tmux" && argv[1] === "has-session") return { code: life.down ? 1 : 0, out: "", err: life.down ? "no server running" : "" };
        if (argv[0] === "systemd-run") return (life.units.push([...argv]), { code: 0, out: "", err: "" });
        return base.run(argv, opts);
      },
      ownerInbox: { path: inbox, ownerId: OWNER, ownerChannel: "C-OWNER" },
      postOwner: async (channel, text) => (life.posts.push([channel, text]), `p${life.posts.length}`),
    };
  };
  return { life, deps };
};

test("a lead whose tmux session is gone is started again in its own unit after leadReviveMin, the owner hears it once where he last wrote, and LEAD_UP ends it", async () => {
  const { life, deps } = leadWorld();
  expect(await leadDownTick(deps(T0), ENV)).toEqual([`LEAD_DOWN ${PANE} no live tmux session or pane; revive after 2 min`]);
  expect(await leadDownTick(deps(T0 + MIN), ENV)).toEqual([]);
  expect(life.units).toEqual([]);
  const unit = `dori-lead-revive-${T0 + 6 * MIN}`;
  expect(await leadDownTick(deps(T0 + 6 * MIN), ENV)).toEqual([
    `LEAD_REVIVE_STARTED ${PANE} down since 2026-10-22T09:23:14.000Z; ${unit} runs self-restart.sh --start 2f5789f93ea54d8b (1/3)`,
    `LEAD_DOWN_NOTICE ${PANE} POSTED C-ZZ p1`,
  ]);
  const argv = life.units[0] ?? [];
  expect(argv.slice(0, 10)).toEqual(["systemd-run", "--user", "--collect", "--quiet", "--unit", unit, "-p", "KillMode=none", "-p", "RemainAfterExit=yes"]);
  expect(argv).toContain("--setenv=DORI_CONFIG=/home/test/.dori/config.json");
  expect(argv.slice(-6, -1)).toEqual(["/bin/bash", REVIVE_SCRIPT, "--start", "2f5789f93ea54d8b", PANE]);
  expect(argv.at(-1)).toStartWith("[DORI] LEAD_REVIVED: your session was down since 09:23");
  expect(life.posts).toEqual([["C-ZZ", "My session went down at 09:23; I'm starting it again in the same conversation and will answer in a few minutes."]]);
  // still down: no second start inside 10 minutes, then one more without a second owner line
  expect(await leadDownTick(deps(T0 + 10 * MIN), ENV)).toEqual([]);
  expect(await leadDownTick(deps(T0 + 16 * MIN), ENV)).toEqual([`LEAD_REVIVE_STARTED ${PANE} down since 2026-10-22T09:23:14.000Z; dori-lead-revive-${T0 + 16 * MIN} runs self-restart.sh --start 2f5789f93ea54d8b (2/3)`]);
  expect(life.posts).toHaveLength(1);
  life.down = false;
  expect(await leadDownTick(deps(T0 + 17 * MIN), ENV)).toEqual([`LEAD_UP ${PANE} down since 2026-10-22T09:23:14.000Z (17 min, 2 revive(s))`]);
  expect(await leadDownTick(deps(T0 + 18 * MIN), ENV)).toEqual([]);
});

test("after three starts that did not bring the lead back it gives up once; leadReviveMin 0 never starts it; a live lead costs nothing", async () => {
  const { life, deps } = leadWorld();
  expect(await leadDownTick(deps(T0, { leadReviveMin: 0 }), ENV)).toEqual([]);
  for (const m of [0, 2, 12, 22]) await leadDownTick(deps(T0 + m * MIN), ENV);
  expect(life.units).toHaveLength(3);
  expect(await leadDownTick(deps(T0 + 32 * MIN), ENV)).toEqual([`LEAD_REVIVE_GAVE_UP ${PANE} still down after 3 revives since 2026-10-22T09:23:14.000Z; ~/.dori/self-restart.log`]);
  expect(await leadDownTick(deps(T0 + 42 * MIN), ENV)).toEqual([]);
  expect(life.units).toHaveLength(3);
  life.down = false;
  await leadDownTick(deps(T0 + 43 * MIN), ENV);
  expect(await leadDownTick(deps(T0 + 44 * MIN), ENV)).toEqual([]);
});

// 2026-11-11: after ZzangDori's handover w1:p37 -> w1:p4C froze w1:p37, a watch still holding leadPane w1:p37 (it reads it
// once when it starts) printed LEAD_REVIVE_WARN w1:p37 REVIVE_FAIL ... no such pane every ten minutes. Each pass of the watch
// now takes the lead the config names then (leadPaneNow), whatever the frozen record and its forward still say.
const OLD = "w1:p37";
const NOW = "w1:p4C";
const SID = "11111111-2222-4333-8444-555555555555";
const H = 60 * MIN;
type Handover = { to?: string; stopped?: boolean; foreign?: boolean; cleaned?: boolean; configNames?: string };
const handedOver = (opts: Handover = {}) => {
  const w = newWorld();
  w.panes = opts.to === undefined && !opts.foreign && !opts.cleaned ? [] : [{ pane_id: NOW, workspace_id: "w1", cwd: state.dir }];
  w.herdrGone = [OLD];
  w.herdrDead = opts.stopped ? [NOW] : [];
  w.ps = opts.stopped ? "4000 1 -bash" : `4000 1 -bash\n4001 4000 omo --session-id ${SID} --model m/x`;
  for (const pane of [OLD, NOW]) recordHerdrSession(state.dir, pane, { session: SID, cwd: state.dir, at: new Date(T0).toISOString() });
  if (opts.foreign) {
    recordHerdrSession(state.dir, "hc:t9A", { session: "99999999-2222-4333-8444-555555555555", cwd: state.dir, at: new Date(T0).toISOString() });
    writeFrozen(state.dir, { pane: "hc:t99", aoeId: "", at: new Date(T0).toISOString(), agentPid: 1, pids: [1], to: "hc:t9A" });
  } else if (opts.cleaned) {
    // freshness closed the frozen session: its record is gone and the forward it left ran out at closeAt
    mkdirSync(join(state.dir, "handover", "forward"), { recursive: true });
    writeFileSync(join(state.dir, "handover", "forward", "w1_p37.json"), JSON.stringify({ pane: OLD, to: NOW, until: new Date(T0 + 24 * H).toISOString() }));
  } else writeFrozen(state.dir, { pane: OLD, aoeId: "", at: new Date(T0).toISOString(), agentPid: 1, pids: [1], ...(opts.to ? { to: opts.to } : {}) });
  // the watch started before the handover: its config still names OLD, the config file names the lead now
  const named = opts.configNames ?? NOW;
  const deps = (ms: number, leadPane = OLD): FlowDeps => ({ ...depsFor(w, fakeClock(ms), state.dir, { backend: "herdr", leadPane, leadReviveMin: 5, sessionsDir: state.dir }), leadPaneNow: () => named });
  const ticks = async (from = 0): Promise<string[]> => {
    const out: string[] = [];
    for (const m of [0, 6, 16, 26]) out.push(...(await watchTick(deps(T0 + from + m * MIN))));
    return out.filter((l) => /^LEAD_|LEAD_REVIVE/.test(l));
  };
  return { w, deps, ticks };
};
const touched = (w: ReturnType<typeof newWorld>, pane: string) => w.calls.filter((c) => c.includes(pane));

test("a watch started before the handover checks the lead the config names now: nothing to do while it runs, no call names the frozen old pane", async () => {
  const { w, ticks } = handedOver({ to: NOW });
  expect(await ticks()).toEqual([]);
  expect(touched(w, OLD)).toEqual([]);
  expect(w.calls.some((c) => c[2] === "run")).toBe(false);
});

test("after the frozen session was closed and its forward ran out, the watch still checks only the lead now, with no call to the old pane", async () => {
  const { w, ticks } = handedOver({ cleaned: true });
  expect(await ticks(25 * H)).toEqual([]);
  expect(touched(w, OLD)).toEqual([]);
});

test("after the frozen record and its forward are gone, the lead now that actually stopped is the one revived", async () => {
  const { w, deps } = handedOver({ cleaned: true, stopped: true });
  expect((await watchTick(deps(T0 + 25 * H))).filter((l) => l.startsWith("LEAD_"))).toEqual([`LEAD_DOWN ${NOW} no live herdr agent or pane; revive after 5 min`]);
  const lines = (await watchTick(deps(T0 + 25 * H + 6 * MIN))).filter((l) => l.startsWith("LEAD_"));
  expect(lines[0]).toStartWith(`LEAD_REVIVE_STARTED ${NOW} down since ${new Date(T0 + 25 * H).toISOString()}; REVIVE_OK ${NOW} session ${SID}`);
  expect(w.calls.filter((c) => c[2] === "run").map((c) => c[3])).toEqual([NOW]);
  expect(touched(w, OLD)).toEqual([]);
});

test("a frozen pane the config still names, with no lead after it, is no lead to check or revive: no LEAD_DOWN, no LEAD_REVIVE_WARN", async () => {
  const { w, ticks } = handedOver({ configNames: OLD });
  expect(await ticks()).toEqual([]);
  expect(w.calls.filter((c) => c[2] === "run")).toEqual([]);
});

test("another runtime's frozen record and session record are never taken for the herdr lead", async () => {
  const { w, deps } = handedOver({ foreign: true, stopped: true });
  expect(await leadDownTick(deps(T0, NOW), {})).toEqual([`LEAD_DOWN ${NOW} no live herdr agent or pane; revive after 5 min`]);
  expect((await leadDownTick(deps(T0 + 6 * MIN, NOW), {}))[0]).toStartWith(`LEAD_REVIVE_STARTED ${NOW}`);
  expect(w.calls.filter((c) => c.some((a) => a.includes("hc:t9")))).toEqual([]);
});
