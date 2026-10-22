import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
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
