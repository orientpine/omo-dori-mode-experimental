import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { leadDownTick } from "../src/lead-down.ts";
import { leadResumeNoticeTick } from "../src/lead-resume.ts";
import { EYES_OFF_FILE } from "../src/owner-waiting.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// LEAD_DOWN_NOTICE and LEAD_RESUME_NOTICE go where the owner's newest message still waiting on this lead is, as
// LEAD_OWNER_WAITING does (owner-waiting.ts): not to a message the lead took its eyes off.
const T0 = Date.parse("2026-11-12T04:00:00Z");
const MIN = 60_000;
const PANE = "aoe_Dori_mode_2f5789f9";
const OWNER = "100000000000000001";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const row = (id: string, min: number, channel: string, scope: string) => JSON.stringify({ ts: new Date(T0 + min * MIN).toISOString(), id, channel_id: channel, scope, author_id: OWNER, called: true, content: id });

const world = (offIds: readonly string[]) => {
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, `${[row("m-wait", 1, "C-WAIT", "channel"), row("m-off", 2, "C-OFF", "thread")].join("\n")}\n`);
  writeFileSync(join(state.dir, EYES_OFF_FILE), offIds.map((id) => `${JSON.stringify({ ts: new Date(T0).toISOString(), channel: "C-OFF", id })}\n`).join(""));
  const posts: string[] = [];
  const w = newWorld();
  const deps = (ms: number): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { leadPane: PANE });
    return {
      ...base,
      run: async (argv, opts) => {
        if (argv[0] === "tmux" && argv[1] === "has-session") return { code: 1, out: "", err: "no server running" };
        if (argv[0] === "systemd-run") return { code: 0, out: "", err: "" };
        return base.run(argv, opts);
      },
      ownerInbox: { path: inbox, ownerId: OWNER, ownerChannel: "C-OWNER" },
      postOwner: async (channel) => `p${posts.push(channel)}`,
    };
  };
  return { posts, deps };
};

test("a revived lead's notice goes where the owner still waits, not to his newer message it took its eyes off", async () => {
  const { posts, deps } = world(["m-off"]);
  const env = { DORI_LEAD_AOE_ID: "2f5789f93ea54d8b" };
  await leadDownTick(deps(T0 + 3 * MIN), env);
  expect(await leadDownTick(deps(T0 + 6 * MIN), env)).toContain(`LEAD_DOWN_NOTICE ${PANE} POSTED C-WAIT p1`);
  expect(posts).toEqual(["C-WAIT"]);
});

test("a resumed lead's notice goes where the owner still waits; with every message eyes-off it goes to his own channel", async () => {
  const notice = { key: "200:resumed", pane: PANE, pid: 200, kind: "resumed", text: "runs again" };
  for (const [off, place] of [[["m-off"], "C-WAIT"], [["m-off", "m-wait"], "C-OWNER"], [[], "C-OFF"]] as const) {
    writeFileSync(join(state.dir, "lead-resume-notices.json"), `${JSON.stringify([notice])}\n`);
    const { posts, deps } = world(off);
    expect(await leadResumeNoticeTick(deps(T0 + 3 * MIN), PANE)).toEqual([`LEAD_RESUME_NOTICE ${PANE} POSTED ${place} p1`]);
    expect(posts).toEqual([place]);
  }
});
