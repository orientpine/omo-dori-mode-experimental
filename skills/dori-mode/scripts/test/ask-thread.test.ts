import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

// 2026-10-29 the owner (22:07 KST): "이러고 나서 카드는 밖에다 만들었는데 스레드 내에 카드 만드는게 강제가 아닌가?" - a Dori
// working in his thread said it would ask with a card below and posted the card at the bottom of its channel, and the lead
// posted Q386-Q388 there too: dori ask without --thread went to the channel. Now a card goes into the asking work's thread,
// or is refused unless it says why it belongs in the channel (--channel "<reason>") or answers his channel message (--reply-to).

const CHANNEL = "500";
const THREAD = "300000000000000003";
const OWNER = "42";
const lane = (fields: Partial<Lane> = {}): Lane => ({ key: "fix-a", title: "fix-a", thread: `discord:${THREAD}`, pane: "aoe_fix_a_1", brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: "2026-10-29T13:00:00.000Z", ...fields });

type Call = { method: string; path: string; body: Record<string, unknown> };
const askCli = async (dir: string, args: readonly string[], env: readonly string[] = []) => {
  const file = join(dir, "http.json");
  const r = await run(["env", "-u", "TMUX", "-u", "HERDR_PANE_ID", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
    `DORI_DISCORD_CHANNEL=${CHANNEL}`, `DORI_DISCORD_OWNER=${OWNER}`, `DORI_DISCORD_INBOX=${join(dir, "inbox.jsonl")}`, ...env,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "ask", "--text", "Ship the fix today?", "--option", "Ship it", "--option", "Wait", ...args]);
  const calls = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).calls as Call[]) : [];
  const cards = join(dir, "discord", "questions.json");
  return {
    code: r.code,
    out: r.out,
    err: r.err,
    posted: calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).map((c) => c.path.split("/")[2]),
    reference: calls.find((c) => c.method === "POST" && c.path.endsWith("/messages"))?.body.message_reference,
    questions: existsSync(cards) ? (JSON.parse(readFileSync(cards, "utf8")).questions as Record<string, unknown>[]) : [],
  };
};
const inbox = (dir: string, rows: readonly Record<string, unknown>[]) => writeFileSync(join(dir, "inbox.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

test("a lane with a work thread asks without --thread: the card goes into that thread (ASK_THREAD_AUTO), from --tmux, --session or its own pane", async () => {
  for (const how of ["tmux", "session", "pane"] as const) {
    const state = withState();
    try {
      await new Registry(state.dir).write(lane({ session: "sess-9" }));
      const bin = join(state.dir, "bin");
      mkdirSync(bin);
      // the lane's own pane on the aoe backend: tmux display-message -p '#S' names its session
      writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho aoe_fix_a_1\n");
      chmodSync(join(bin, "tmux"), 0o755);
      writeFileSync(join(state.dir, "aoe.json"), JSON.stringify({ backend: "aoe" }));
      const args = how === "tmux" ? ["--tmux", "aoe_fix_a_1"] : how === "session" ? ["--session", "sess-9"] : [];
      const env = how === "pane" ? [`DORI_CONFIG=${join(state.dir, "aoe.json")}`, "TMUX=/tmp/fake,1,0", `PATH=${bin}:${process.env.PATH}`] : [];
      const r = await askCli(state.dir, args, env);
      expect({ how, code: r.code, posted: r.posted, auto: r.out.includes(`ASK_THREAD_AUTO discord:${THREAD} lane fix-a`), thread: r.questions[0]?.thread, tmux: r.questions[0]?.tmux })
        .toEqual({ how, code: 0, posted: [THREAD], auto: true, thread: THREAD, tmux: "aoe_fix_a_1" });
    } finally {
      state.done();
    }
  }
});

test("a thread dori thread open mapped to the asking session takes the card when no lane is found", async () => {
  const state = withState();
  try {
    mkdirSync(join(state.dir, "discord"), { recursive: true });
    writeFileSync(join(state.dir, "discord", "threads.json"), JSON.stringify({ [THREAD]: { session: "aoe_lead_1", title: "H200" } }));
    const r = await askCli(state.dir, ["--tmux", "aoe_lead_1"]);
    expect({ code: r.code, posted: r.posted, auto: r.out.includes(`ASK_THREAD_AUTO discord:${THREAD} mapped to aoe_lead_1`) }).toEqual({ code: 0, posted: [THREAD], auto: true });
  } finally {
    state.done();
  }
});

for (const [name, setup] of [
  ["no lane at all", async () => {}],
  ["a closed lane's thread", async (dir: string) => new Registry(dir).write(lane({ closedAt: "2026-10-29T13:05:00.000Z" }))],
  ["a lane without a thread", async (dir: string) => new Registry(dir).write(lane({ thread: "none", noThread: "internal" }))],
] as const) {
  test(`no thread found (${name}) and no reason: refused with ASK_THREAD_REQUIRED, exit 2, nothing posted or recorded`, async () => {
    const state = withState();
    try {
      await setup(state.dir);
      const r = await askCli(state.dir, ["--tmux", "aoe_fix_a_1"]);
      expect({ code: r.code, refused: r.err.includes("ASK_THREAD_REQUIRED"), posted: r.posted, questions: r.questions.length }).toEqual({ code: 2, refused: true, posted: [], questions: 0 });
    } finally {
      state.done();
    }
  });
}

test("--channel with a reason posts in the channel and keeps the reason on the card; an empty or bare --channel is refused", async () => {
  const state = withState();
  try {
    const r = await askCli(state.dir, ["--channel", "the owner asked this short question in the channel"]);
    expect({ code: r.code, posted: r.posted, line: r.out.includes("ASK_CHANNEL Q1: the owner asked this short question in the channel"), why: r.questions[0]?.channelWhy, thread: r.questions[0]?.thread })
      .toEqual({ code: 0, posted: [CHANNEL], line: true, why: "the owner asked this short question in the channel", thread: null });
    for (const bad of [["--channel", " "], ["--channel"]]) {
      const s = withState();
      try {
        const b = await askCli(s.dir, bad);
        expect({ bad, code: b.code, posted: b.posted }).toEqual({ bad, code: 2, posted: [] });
      } finally {
        s.done();
      }
    }
  } finally {
    state.done();
  }
});

test("--reply-to the owner's channel message answers it in the channel as a reply; his message in a thread sends the card there; anything else is refused", async () => {
  const state = withState();
  try {
    inbox(state.dir, [
      { ts: "2026-10-29T13:07:50Z", id: "777000000000000001", channel_id: CHANNEL, scope: "channel", author_id: OWNER, content: "누가 맡을까?" },
      { ts: "2026-10-29T13:08:00Z", id: "777000000000000002", channel_id: THREAD, scope: "thread", author_id: OWNER, content: "이건?" },
      { ts: "2026-10-29T13:08:10Z", id: "777000000000000003", channel_id: CHANNEL, scope: "channel", author_id: "99", content: "not him" },
    ]);
    const asChannel = await askCli(state.dir, ["--reply-to", "https://discord.com/channels/1/500/777000000000000001"]);
    expect({ code: asChannel.code, posted: asChannel.posted, reference: asChannel.reference, replyTo: asChannel.questions[0]?.replyTo, line: asChannel.out.includes("ASK_REPLY Q1 777000000000000001") })
      .toEqual({ code: 0, posted: [CHANNEL], reference: { message_id: "777000000000000001", fail_if_not_exists: false }, replyTo: "777000000000000001", line: true });
    const inThread = await askCli(state.dir, ["--reply-to", "777000000000000002"]);
    expect({ code: inThread.code, posted: inThread.posted.at(-1), thread: inThread.questions.at(-1)?.thread, line: inThread.out.includes(`ASK_REPLY Q2 777000000000000002 in thread discord:${THREAD}`) }).toEqual({ code: 0, posted: THREAD, thread: THREAD, line: true });
    for (const id of ["777000000000000003", "777000000000000009", "not-an-id"]) {
      const s = withState();
      try {
        inbox(s.dir, [{ ts: "2026-10-29T13:08:10Z", id: "777000000000000003", channel_id: CHANNEL, scope: "channel", author_id: "99", content: "not him" }]);
        const b = await askCli(s.dir, ["--reply-to", id]);
        expect({ id, code: b.code, posted: b.posted, said: b.err.includes("ASK_REPLY_TO_UNKNOWN") }).toEqual({ id, code: 2, posted: [], said: true });
      } finally {
        s.done();
      }
    }
  } finally {
    state.done();
  }
});

test("--thread posts where it says as before, even with a lane thread; two places at once are refused", async () => {
  const state = withState();
  try {
    await new Registry(state.dir).write(lane({ thread: "discord:300000000000000099" }));
    const r = await askCli(state.dir, ["--thread", `discord:${THREAD}`, "--tmux", "aoe_fix_a_1"]);
    expect({ code: r.code, posted: r.posted, auto: r.out.includes("ASK_THREAD_AUTO") }).toEqual({ code: 0, posted: [THREAD], auto: false });
    const both = await askCli(state.dir, ["--thread", `discord:${THREAD}`, "--channel", "why"]);
    expect({ code: both.code, posted: both.posted.length }).toEqual({ code: 2, posted: 1 });
  } finally {
    state.done();
  }
});
