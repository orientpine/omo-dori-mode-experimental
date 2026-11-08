import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore, pollTelegramInbound, writeLineSync } from "../src/messenger/telegram-inbound.ts";
import { withState } from "./fakes.ts";
import { GROUP, mk, msg, OWNER, telegramFake, type U } from "./telegram-inbound-setup.ts";

setDefaultTimeout(30_000); // load-proof: the CLI tests here start dori inbound telegram (bun src/cli.ts) as a child process; a loaded host (40-67 on 20 cores) slows them several times over, so this file, not the suite, gets 30 s

const state = withState();
afterAll(() => state.done());

// review 1 of #350: dori inbound telegram itself. A line that cannot be written leaves the offset before its message, and
// a blank or out-of-range id is refused before any call.
// review 2 of #350: a Telegram setting in the shell running the tests is not the test's
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_TELEGRAM_")));
const inbound = async (vars: Record<string, string>, tail = "", batch: U[] = [{ update_id: 90, message: msg(OWNER, OWNER, "private", "owner dm") }]) => {
  const dir = mkdtempSync(join(state.dir, "cli-"));
  const log = join(dir, "http.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
  writeFileSync(join(dir, "batch.json"), JSON.stringify(batch));
  const argv = ["bun", "--preload", join(import.meta.dir, "telegram-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "inbound", "telegram"];
  const p = Bun.spawn(["bash", "-c", `"$@"${tail}`, "inbound", ...argv], {
    env: { ...inherited, DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: join(dir, "missing.env"), DORI_STATE_DIR: join(dir, "state"), DORI_TEST_TG_LOG: log, DORI_TEST_TG_BATCH: join(dir, "batch.json"), DORI_TELEGRAM_TOKEN: "fake", DORI_TELEGRAM_OWNER_ID: String(OWNER), ...vars },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const offsetFile = join(dir, "state", "telegram-offset");
  return { code, out: out.trim(), err: err.trim(), calls: readFileSync(log, "utf8").split("\n").filter(Boolean).length, offset: existsSync(offsetFile) ? readFileSync(offsetFile, "utf8") : undefined };
};

test("dori inbound telegram prints the owner's message and then moves the offset past it", async () => {
  expect(await inbound({})).toMatchObject({ code: 0, out: `INBOUND_READY telegram owner=${OWNER} group=- topic=-\nINBOUND dm ${OWNER} - 90 ${OWNER} "owner dm"`, calls: 1, offset: "91" });
});

test("a line that cannot be written (stdout closed) keeps the offset before its message", async () => {
  const closed = join(mkdtempSync(join(state.dir, "closed-")), "stdout-closed");
  const r = await inbound({ DORI_TEST_TG_AFTER: closed }, ` | { exec 0<&-; : > '${closed}'; }`);
  expect({ calls: r.calls, offset: r.offset }).toEqual({ calls: 1, offset: undefined });
});

test.each([
  ["a blank owner id", { DORI_TELEGRAM_OWNER_ID: "" }, 'DORI_TELEGRAM_OWNER_ID must be an integer, got: ""'],
  ["a whitespace owner id", { DORI_TELEGRAM_OWNER_ID: "  " }, 'DORI_TELEGRAM_OWNER_ID must be an integer, got: "  "'],
  ["owner id 0", { DORI_TELEGRAM_OWNER_ID: "0" }, 'DORI_TELEGRAM_OWNER_ID must be a positive user id, got: "0"'],
  ["a blank group id", { DORI_TELEGRAM_GROUP_ID: "" }, 'DORI_TELEGRAM_GROUP_ID must be an integer, got: ""'],
  ["a blank topic id", { DORI_TELEGRAM_GROUP_ID: String(GROUP), DORI_TELEGRAM_TOPIC_ID: "" }, 'DORI_TELEGRAM_TOPIC_ID must be an integer, got: ""'],
  ["topic id 0", { DORI_TELEGRAM_GROUP_ID: String(GROUP), DORI_TELEGRAM_TOPIC_ID: "0" }, 'DORI_TELEGRAM_TOPIC_ID must be a positive topic id, got: "0"'],
] as const)("dori inbound telegram refuses %s before any call", async (_, vars, err) => {
  expect(await inbound(vars)).toEqual({ code: 1, out: "", err, calls: 0, offset: undefined });
});

// review 2 of #350: a write that takes only part of the line is continued until all of it is out; no progress or an
// error throws, so pollTelegramInbound keeps the offset before that message
test("writeLineSync finishes a line written a few bytes at a time", () => {
  const out: string[] = [];
  const n = writeLineSync("INBOUND dm 1 - 2 3 \"héllo\"\n", 1, (_fd, buf, off, len) => { const k = Math.min(3, len); out.push(Buffer.from(buf.subarray(off, off + k)).toString("latin1")); return k; });
  expect(Buffer.from(out.join(""), "latin1").toString("utf8")).toBe("INBOUND dm 1 - 2 3 \"héllo\"\n");
  expect(n).toBe(Buffer.byteLength("INBOUND dm 1 - 2 3 \"héllo\"\n"));
});

test.each([
  ["no progress", "tg-off-short-1", (_fd: number, _buf: Uint8Array, off: number): number => (off === 0 ? 4 : 0)],
  ["an error after part of the line", "tg-off-short-2", (_fd: number, _buf: Uint8Array, off: number): number => { if (off > 0) throw new Error("EIO"); return 4; }],
] as const)("a line cut short by %s keeps the offset before its message", async (_, file, write) => {
  const { http } = telegramFake([[{ update_id: 95, message: msg(OWNER, OWNER, "private", "cut short") }]]);
  const store = fileTgInboundStore(join(state.dir, file));
  store.save(95);
  await expect(pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) => { writeLineSync(`${i.text}\n`, 1, write); })).rejects.toThrow();
  expect(store.load()).toBe(95);
});

// the fork's addition: dori inbound telegram itself prints the edit kind and the media file id on the line
test("dori inbound telegram prints an edit as edit:dm and a media message with file=<kind>:<file_id>", async () => {
  const batch: U[] = [
    { update_id: 120, edited_message: { ...msg(OWNER, OWNER, "private", "fixed typo"), edit_date: 1730 } },
    { update_id: 121, message: { message_id: 57, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" }, voice: { file_id: "FID_VOICE" } } },
    { update_id: 122, message: { message_id: 58, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" }, photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }], caption: "look" } },
  ];
  expect(await inbound({}, "", batch)).toMatchObject({
    code: 0,
    out: [
      `INBOUND_READY telegram owner=${OWNER} group=- topic=-`,
      `INBOUND edit:dm ${OWNER} - 120 ${OWNER} "fixed typo"`,
      `INBOUND dm ${OWNER} - 121 ${OWNER} "" file=voice:FID_VOICE`,
      `INBOUND dm ${OWNER} - 122 ${OWNER} "look" file=photo:LARGE`,
    ].join("\n"),
    calls: 1,
    offset: "123",
  });
});

test("dori inbound telegram refuses an id written as 1e3 or 0x10 before any call", async () => {
  expect(await inbound({ DORI_TELEGRAM_OWNER_ID: "1e3" })).toEqual({ code: 1, out: "", err: 'DORI_TELEGRAM_OWNER_ID must be an integer, got: "1e3"', calls: 0, offset: undefined });
  expect(await inbound({ DORI_TELEGRAM_GROUP_ID: "0x10" })).toEqual({ code: 1, out: "", err: 'DORI_TELEGRAM_GROUP_ID must be an integer, got: "0x10"', calls: 0, offset: undefined });
});
