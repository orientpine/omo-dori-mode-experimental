import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tmux-guard runs as bin/tmux ahead of a stand-in "real" tmux that only prints its arguments, so no case here can reach a
// tmux server: a refused call must never reach the stand-in, a passed one must reach it with its arguments unchanged.
const dir = mkdtempSync(join(tmpdir(), "tmux-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "bin");
const realBin = join(dir, "real");
const tmpDir = join(dir, "tmp");
for (const d of [bin, realBin, tmpDir]) mkdirSync(d);
symlinkSync(join(import.meta.dir, "../../setups/discord-aoe/tmux-guard"), join(bin, "tmux"));
writeFileSync(join(realBin, "tmux"), '#!/usr/bin/env bash\nprintf REAL; for a in "$@"; do printf " [%s]" "$a"; done; echo\n');
chmodSync(join(realBin, "tmux"), 0o755);

const live = `/tmp/tmux-${process.getuid!()}/default`;
const other = join(dir, "test.sock");

const guard = (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync([join(bin, "tmux"), ...args], {
    env: { PATH: `${bin}:${realBin}:/usr/bin:/bin`, HOME: dir, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

const refused: [string, string[], Record<string, string>][] = [
  ["no TMUX, no -L/-S", ["kill-server"], {}],
  ["no TMUX, -L default", ["-L", "default", "kill-server"], {}],
  ["no TMUX, -S the default socket", ["-S", live, "kill-server"], {}],
  ["no TMUX, TMUX_TMPDIR that does not exist", ["kill-server"], { TMUX_TMPDIR: join(dir, "missing") }],
  ["TMUX the live server", ["kill-server"], { TMUX: `${live},1,0` }],
  ["TMUX the live server and TMUX_TMPDIR (the 2026-10-22 cleanup)", ["kill-server"], { TMUX: `${live},1,0`, TMUX_TMPDIR: tmpDir }],
  ["TMUX a test socket, no -L/-S: the server $TMUX names", ["kill-server"], { TMUX: `${other},1,0` }],
  ["-S the $TMUX socket", ["-S", other, "kill-server"], { TMUX: `${other},1,0` }],
  ["-S live before -L: -S wins", ["-S", live, "-L", "qa", "kill-server"], {}],
  ["-L before -S live: -S wins", ["-L", "qa", "-S", live, "kill-ser"], {}],
  ["clustered -uLdefault", ["-uLdefault", "kill-server"], {}],
  ["kill-server after ;", ["new-session", "-d", ";", "kill-server"], {}],
  ["kill-server after an argument ending in ;", ["new-session", "-d", "x;", "kill-server"], {}],
];

for (const [name, args, env] of refused) {
  test(`refuses kill-server on the live server: ${name}`, () => {
    const r = guard(args, env);
    expect(r.code).toBe(1);
    expect(r.err).toContain("TMUX_GUARD_REFUSED");
    expect(r.out).toBe("");
  });
}

const passed: [string, string[], Record<string, string>][] = [
  ["no TMUX, -S a test socket (was: TMUX unbound variable)", ["-S", other, "kill-server"], {}],
  ["TMUX the live server, -S a test socket", ["-S", other, "kill-server"], { TMUX: `${live},1,0` }],
  ["no TMUX, TMUX_TMPDIR a test directory", ["kill-server"], { TMUX_TMPDIR: tmpDir }],
  ["TMUX the live server, -L default under TMUX_TMPDIR: -L skips $TMUX", ["-L", "default", "kill-server"], { TMUX: `${live},1,0`, TMUX_TMPDIR: tmpDir }],
  ["-S a test socket after -L default", ["-L", "default", "-S", other, "kill-server"], {}],
  ["clustered -uL qa", ["-uL", "qa", "kill-server"], { TMUX: `${live},1,0` }],
  ["TMUX starting with a comma is ignored", ["kill-server"], { TMUX: ",1,0", TMUX_TMPDIR: tmpDir }],
  ["not kill-server", ["display-message", "-p", "#{socket_path}"], { TMUX: `${live},1,0` }],
  ["kill-session is not kill-server", ["kill-session", "-t", "x"], {}],
  ["kill-server as an argument", ["send-keys", "-t", "x", "kill-server", "Enter"], { TMUX: `${live},1,0` }],
  ["kill-server after an escaped \\;", ["new-session", "-d", "x\\;", "kill-server"], {}],
  ["no arguments", [], {}],
];

for (const [name, args, env] of passed) {
  test(`passes to the real tmux unchanged: ${name}`, () => {
    const r = guard(args, env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`REAL${args.map((a) => ` [${a}]`).join("")}\n`);
  });
}
