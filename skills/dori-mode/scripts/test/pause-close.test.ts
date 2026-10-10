import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultDiscordWords } from "../src/config.ts";
import { deadPaneTick } from "../src/dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, LaneStateError, pauseLane, resumeLane, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Discord } from "../src/messenger/discord.ts";
import { discordThreadId, setThreadStatus } from "../src/messenger/discord-thread.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const PANE = "aoe_fix-a_abcdef12";
const THREAD_ID = "300000000000000003";
const lane: Lane = { key: "fix-a", title: "fix-a", thread: `discord:${THREAD_ID}`, pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps> = {}): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d", hooks: { threadReply: ["notify", "{thread}", "{text}"] } }),
  ...patch,
});
const read = async () => (await at(T0).registry.read("fix-a")) ?? lane;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: "abcdef1200112233", title: "fix-a", path: "/repo", tool: "omo", profile: "main" }];
  world.tmux = [PANE];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

const waitingForHuman = () => {
  world.aoePs = [{ session: "abcdef1200112233", state: "waiting" }];
  world.screen = "[REPORT] fix-a | question | A or B?\nAllow this command? (y/n)\n❯ ";
};

test("a paused lane gets no freshness nudge or post, no LANE_BLOCKED and no DEAD_PANE; resume brings them back a full interval later", async () => {
  expect(await pauseLane(at(T0), lane, "waiting on the owner's pick")).toBe("LANE_PAUSED fix-a (was working) waiting on the owner's pick");
  waitingForHuman();
  expect(await freshnessTick(at(T0 + 30 * MIN), "/home/test")).toEqual([]);
  expect(await watchTick(at(T0 + 30 * MIN))).toEqual([]);
  world.screen = "omo has stopped\n$ ";
  const paused = (await at(T0).registry.open()).flatMap((l) => (statusOf(l) === "paused" && l.pane ? [l.pane] : []));
  expect(await deadPaneTick(at(T0).run, at(T0).config, new Set(), "2026-01-01T12", paused)).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);

  expect(await resumeLane(at(T0 + 40 * MIN), await read())).toEqual(["LANE_RESUMED fix-a working"]);
  const resumed = await read();
  expect(statusOf(resumed)).toBe("working");
  expect(resumed.history?.map((h) => [h.status, h.note])).toEqual([["paused", "PAUSED: waiting on the owner's pick"], ["working", "RESUMED"]]);
  waitingForHuman();
  expect(await freshnessTick(at(T0 + 41 * MIN), "/home/test")).toEqual([]);
  // the report first read at +41 min is the last word from the lane, so the nudge is due a full interval after it
  expect((await freshnessTick(at(T0 + 41 * MIN + at(T0).config.nudgeAfterMin * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect(await watchTick(at(T0 + 60 * MIN))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
});

test("resume returns a lane to not-done when it was paused from not-done; pausing twice or resuming a running lane is refused", async () => {
  await at(T0).registry.write({ ...lane, status: "not-done" });
  await pauseLane(at(T0), await read(), "owner decides");
  await expect(pauseLane(at(T0), await read(), "again")).rejects.toBeInstanceOf(LaneStateError);
  await resumeLane(at(T0 + MIN), await read());
  expect(statusOf(await read())).toBe("not-done");
  await expect(resumeLane(at(T0), await read())).rejects.toBeInstanceOf(LaneStateError);
});

test("a done claim on a paused lane is announced once and never closes it; resume points at the waiting claim", async () => {
  await pauseLane(at(T0), lane, "owner approval");
  expect(await claimDone(at(T0 + MIN), await read(), "merged #3")).toBe(`LANE_DONE_CLAIMED_PAUSED fix-a ${PANE} merged #3`);
  expect(sent(world)[0]).toContain("does not close automatically");
  expect(await watchTick(at(T0 + 2 * MIN))).toEqual([`LANE_DONE_CLAIMED_PAUSED fix-a ${PANE} merged #3`]);
  expect(await watchTick(at(T0 + 20 * MIN))).toEqual([]);
  expect(statusOf(await read())).toBe("paused");
  expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "rm")).toBe(false);
  const lines = await resumeLane(at(T0 + 21 * MIN), await read());
  expect(lines[1]).toStartWith("NOTE fix-a claimed done while paused (merged #3)");
});

// a fake Discord thread: GET returns its name and archive flag, PATCHes are recorded (or refused)
const fakeThread = (name: string, archived: boolean, refuse = false) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req): Promise<HttpResponse> => {
    seen.push(req);
    if (refuse && req.method === "PATCH") return { status: 403, headers: {}, body: JSON.stringify({ code: 50013, message: "Missing Permissions" }) };
    return { status: 200, headers: {}, body: JSON.stringify(req.method === "GET" ? { name, thread_metadata: { archived } } : {}) };
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const markThreadDone = (ref: string) => setThreadStatus(dc, discordThreadId(ref), "done", { ...defaultDiscordWords, statusStyle: "emoji" });
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}${r.body ? ` ${r.body}` : ""}`);
  return { markThreadDone, calls };
};
const T = `/channels/${THREAD_ID}`;

test("close sets the lane's Discord thread done and archives it", async () => {
  const f = fakeThread("🔄 fix login", false);
  const r = await closeLane(at(T0, { markThreadDone: f.markThreadDone }), lane, "closed by the lead");
  expect(r.closed).toBe(true);
  expect(f.calls()).toEqual([`GET ${T}`, `PATCH ${T} {"name":"✅ fix login"}`, `PATCH ${T} {"archived":true}`]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread set done and archived");
});

test("an archived thread is opened, renamed and archived again, since Discord will not rename an archived thread; one already done is left alone", async () => {
  const f = fakeThread("🔄 fix login", true);
  await closeLane(at(T0, { markThreadDone: f.markThreadDone }), lane, "closed");
  expect(f.calls()).toEqual([`GET ${T}`, `PATCH ${T} {"archived":false}`, `PATCH ${T} {"name":"✅ fix login"}`, `PATCH ${T} {"archived":true}`]);
  await at(T0).registry.write(lane);
  const done = fakeThread("✅ fix login", true);
  await closeLane(at(T0, { markThreadDone: done.markThreadDone }), lane, "closed");
  expect(done.calls()).toEqual([`GET ${T}`]);
});

test("a thread that cannot be renamed is a warning, the lane still closes; a lane without a thread or sharing it with an open lane is not touched", async () => {
  const refused = fakeThread("🔄 fix login", false, true);
  const r = await closeLane(at(T0, { markThreadDone: refused.markThreadDone }), lane, "closed");
  expect(r.closed).toBe(true);
  expect(r.lines.some((l) => l.startsWith(`THREAD_DONE_WARN fix-a discord:${THREAD_ID}: discord PATCH`))).toBe(true);
  expect(statusOf(await read())).toBe("closed");

  const none = fakeThread("🔄 fix login", false);
  await at(T0).registry.write({ ...lane, thread: "none" });
  expect((await closeLane(at(T0, { markThreadDone: none.markThreadDone }), { ...lane, thread: "none" }, "closed")).closed).toBe(true);
  await at(T0).registry.write(lane);
  await at(T0).registry.write({ ...lane, key: "fix-b", pane: "aoe_fix-b_00000000" });
  await closeLane(at(T0, { markThreadDone: none.markThreadDone }), lane, "closed");
  expect(none.calls()).toEqual([]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open lane fix-b uses it too");
});
