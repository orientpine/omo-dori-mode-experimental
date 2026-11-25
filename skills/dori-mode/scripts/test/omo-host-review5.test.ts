import { expect, test } from "bun:test";
import { join } from "node:path";
import { applyDirectives } from "../src/directive-audit.ts";
import { hostedStartup } from "../src/launch-hosted.ts";
import { adoptLane } from "../src/launch-state.ts";
import { objectDone } from "../src/done-flow-state.ts";
import { reconcileRows } from "../src/missed-answers.ts";
import type { Runner } from "../src/run.ts";
import { FakeOmoHost, writeGoal } from "./fake-omo-host.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const id = "00000000-0000-4000-8000-000000000057";
const pane = `omo-host:${id}`;
const ref = { runtime: "omo-host", id } as const;
const at = Date.parse("2026-11-25T12:00:00Z");
const fixture = (name?: string, group = "") => {
  const state = withState();
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const session = host.add({ id, ...(name === undefined ? {} : { name }) });
  const base = depsFor(newWorld(), fakeClock(at), state.dir, { laneWorkspace: group });
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base.run(argv, opts);
    const r = await host.exec("omo", argv.slice(1));
    return { code: r.code, out: r.stdout, err: r.stderr };
  };
  return { state, host, session, deps: { ...base, run }, lane: { key: "hosted", title: "Hosted", pane, thread: "none", brief: join(state.dir, "brief.md"), done: "file /proof", openedAt: new Date(at).toISOString() } };
};

test.each(["settled", "quoted", "retrying", "stale"] as const)("hosted startup classifies %s errors from structured replies", async (kind) => {
  const f = fixture();
  try {
    writeGoal(f.session, "active");
    f.session.state["isStreaming"] = kind === "quoted";
    f.session.state["retryAttempt"] = kind === "retrying" ? 1 : 0;
    f.session.entries.push({ type: "message", message: { role: "assistant", timestamp: kind === "stale" ? at - 3000 : at + 100, content: "API error: quota exceeded", ...(kind === "quoted" ? { stopReason: "stop" } : { stopReason: "error", errorMessage: "provider refused the request" }) } });
    expect(await hostedStartup(f.deps, f.lane.key, ref)).toStartWith(kind === "settled" ? "STARTUP_ERROR" : "STARTUP_OK");
  } finally { f.state.done(); }
});

test.each([[undefined, "", false], ["dori/other/personal", "", false], ["dori/dori/lane", "", true], ["dori/team/lane", "team", true], ["dori/dori/lane", "team", false]] as const)("adoption scopes hosted name %s to group %s", async (name, group, accepted) => {
  const f = fixture(name, group);
  try {
    await Bun.write(f.lane.brief, "# Task\n- Done = file /proof\n");
    const adopting = adoptLane(f.deps, f.lane);
    if (accepted) expect((await adopting).pane).toBe(pane);
    else await expect(adopting).rejects.toThrow("refusing to adopt");
  } finally { f.state.done(); }
});

// review 6 of PR 527: a delivery is one send, never matched to an earlier one by its words
test("two objections with the same reasons both reach the hosted lane", async () => {
  const f = fixture();
  try {
    await f.deps.registry.write(f.lane);
    const sends = () => f.host.calls.filter(([verb]) => verb === "steer" || verb === "prompt").length;
    f.host.refuseNext.set("steer", "transport_gone");
    f.host.refuseNext.set("prompt", "transport_gone");
    await objectDone(f.deps, f.lane, ["tests fail"]);
    const said = "[LEAD] not done: tests fail; keep working, claim again when fixed";
    await Bun.write(String(f.session.state["sessionFile"]), `${JSON.stringify({ type: "message", message: { role: "user", timestamp: at, content: said } })}\n`);
    await objectDone(f.deps, f.lane, ["tests fail"]);
    expect(sends()).toBe(2);
  } finally { f.state.done(); }
});

test.each(["queued", "ambiguous"] as const)("directives apply twice does not resend a %s hosted delivery", async (mode) => {
  const f = fixture();
  try {
    const brief = "Fix the login loop.\n";
    await Bun.write(f.lane.brief, brief);
    await f.deps.registry.write(f.lane);
    f.session.state["isStreaming"] = true;
    const run: Runner = (argv, opts) => {
      if (argv[0] === "omo" && argv[3] === "steer") {
        f.session.state["isStreaming"] = false;
        f.session.state["steering"] = [argv[5]];
        f.session.state["pendingMessageCount"] = 1;
        if (mode === "ambiguous") f.host.refuseNext.set("steer", "transport_gone");
      }
      return f.deps.run(argv, opts);
    };
    const deps = { ...f.deps, run, config: { ...f.deps.config, directives: { ...f.deps.config.directives, common: new URL("../../references/directives.json", import.meta.url).pathname } } };
    const first = await applyDirectives(deps, f.lane);
    const second = await applyDirectives(deps, f.lane);
    expect(f.host.calls.filter(([verb]) => verb === "steer" || verb === "prompt").map(([verb]) => verb)).toEqual(["steer"]);
    expect(first.lines.at(-1)).toContain("PENDING");
    expect(second.lines.at(-1)).toContain("DIRECTIVES_APPLY_NONE");
    expect(await Bun.file(f.lane.brief).text()).not.toBe(brief);
  } finally { f.state.done(); }
});

// a hosted lane's card answer is its watch's to redeliver, not the terminal lead's wait (scope cut after review 7 of PR 527)
test("a card answer for a hosted lane does not count as the owner waiting on the lead; an owner message still does", async () => {
  const f = fixture();
  try {
    const leadPath = join(f.state.dir, "lead.jsonl");
    await Bun.write(leadPath, "");
    const answer = { id: "answer-9", qid: "Q9", tmux: pane, thread: "CARD", at }, owner = { id: "owner-9", at };
    const run: Runner = (argv, opts) => (argv[0] === "omo" ? Promise.reject(new Error("the lead's check must not ask the host")) : f.deps.run(argv, opts));
    const input = { rows: [answer, owner], cards: [], lead: { pane: "lead", path: leadPath, title: "", text: "" }, sessions: [], table: [], deps: { ...f.deps, run } };
    expect((await reconcileRows(input)).waiting).toEqual([owner]);
  } finally { f.state.done(); }
});
