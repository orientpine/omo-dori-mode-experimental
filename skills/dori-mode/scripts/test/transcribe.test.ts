import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/transcribe.sh");
let asr = "";

const exe = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

// ffmpeg writes FAKE_SECS seconds of 16 kHz mono silence; whisper-cli prints plain text without -oj, and with -oj
// a JSON whose first pass loops on one line five times; the retry pass (-tp) hears two different lines.
beforeEach(() => {
  asr = mkdtempSync(join(tmpdir(), "dori-asr-"));
  exe(join(asr, "bin/ffmpeg"), `#!/usr/bin/env python3
import os, sys, wave
w = wave.open(sys.argv[-1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"\\0\\0" * 16000 * int(os.environ["FAKE_SECS"])); w.close()
`);
  exe(join(asr, "whisper.cpp/build/bin/whisper-cli"), `#!/usr/bin/env python3
import json, sys
a = sys.argv
if "-oj" not in a:
    print(" hello there"); sys.exit(0)
seg = lambda f, t, x: {"offsets": {"from": f, "to": t}, "text": x}
if "-tp" in a:
    rows = [seg(0, 4000, " fixed one"), seg(4000, 9000, " fixed two")]
else:
    rows = [seg(0, 5000, " opening words"), seg(5000, 10000, " reply words")]
    rows += [seg(10000 + i * 2000, 12000 + i * 2000, " stuck line") for i in range(5)]
json.dump({"transcription": rows}, open(a[a.index("-of") + 1] + ".json", "w"))
`);
});
afterEach(() => rmSync(asr, { recursive: true, force: true }));

const diarizer = () =>
  exe(join(asr, "diar/venv/bin/python"), `#!/usr/bin/env python3
import json, sys
json.dump([[0, 5, "SPEAKER_07"], [5, 10, "SPEAKER_02"], [10, 30, "SPEAKER_07"]], open(sys.argv[-1], "w"))
`);

const run = async (secs: number) => {
  const audio = join(asr, "in.ogg");
  writeFileSync(audio, "x");
  const p = Bun.spawn(["bash", SCRIPT, audio], {
    env: { ...process.env, DORI_ASR_DIR: asr, DORI_ASR_LANG: "ko", FAKE_SECS: String(secs) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err };
};

test("a short voice note stays one plain line, with no speaker labels", async () => {
  diarizer();
  expect(await run(20)).toMatchObject({ code: 0, out: "hello there" });
});

test("a long recording gets one line per speaker turn and a looping span transcribed again", async () => {
  diarizer();
  const r = await run(400);
  expect({ code: r.code, lines: r.out.split("\n") }).toEqual({
    code: 0,
    lines: ["[00:00:00] 화자1: opening words", "[00:00:05] 화자2: reply words", "[00:00:10] 화자1: fixed one fixed two"],
  });
  expect(r.err).toContain("REPEAT_FIXED 10.0-20.0s 5 lines -> 2 lines, 0 loop(s) left");
});

test("a long recording without the diarization install keeps its text, unlabeled", async () => {
  const r = await run(400);
  expect({ code: r.code, lines: r.out.split("\n") }).toEqual({
    code: 0,
    lines: ["[00:00:00] opening words reply words fixed one fixed two"],
  });
  expect(r.err).toContain("run setup-diarize.sh");
});
