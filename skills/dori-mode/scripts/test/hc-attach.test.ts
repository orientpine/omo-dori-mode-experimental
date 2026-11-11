import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hcCore } from "../src/hc-lead-core.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// a core's socket that accepts connections, as a running core's does; a plain file at the path is a socket a killed core left
const listen = (path: string): Promise<void> => new Promise((resolve) => {
  const server = createServer();
  servers.push(server);
  server.listen(path, () => resolve());
});

const rig = (lead: string): { dir: string; bin: string } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-hc-attach-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, ".dori"));
  writeFileSync(join(dir, ".dori", "dori.env"), "HC_SESSION=agents\n");
  writeFileSync(join(dir, ".dori", "config.json"), JSON.stringify({ runtime: "hc", leadPane: "hc:t7" }));
  writeFileSync(join(dir, "wrong.env"), "HC_SESSION=foreign\n");
  writeFileSync(join(dir, "wrong-config.json"), JSON.stringify({ runtime: "hc", leadPane: "hc:t999" }));
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  // this checkout's CLI, run by dori.sh as \`bun .../scripts/src/cli.ts\`, is faked; every other bun run is the real bun
  writeFileSync(join(dir, ".bun", "bin", "bun"), `#!/bin/sh\ncase "$1" in */scripts/src/cli.ts) shift; printf '%s state=%s config=%s\\n' "$1" "\${DORI_STATE_DIR:-unset}" "$DORI_CONFIG" >> "$HOME/cli-calls"; if [ "$1" = lead ]; then printf '%s\\n' '${lead}'; else printf 'dori %s\\n' "$*"; fi ;; *) exec '${process.execPath}' "$@" ;; esac\n`, { mode: 0o700 });
  symlinkSync(join(import.meta.dir, "../../../.."), join(dir, ".dori", "src"));
  const executable = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
  // a wrapper on PATH that picks another instance's files, as the documented ~/.second/bin/dori does
  executable("dori", `printf 'wrapper dori %s\\n' "$*"; if [ "$1" = lead ]; then printf 'other-session hc:t999\\n'; fi`);
  executable("systemctl", `printf 'systemctl %s\\n' "$*"`);
  executable("hc", `if [ -n "$HC_SOCKET" ]; then printf 'unexpected socket %s\\n' "$HC_SOCKET"; fi\nprintf 'hc session=%s %s\\n' "\${HC_SESSION:-default}" "$*"`);
  executable("herdr", `printf 'unexpected herdr %s\\n' "$*"`);
  executable("aoe", `printf 'unexpected aoe %s\\n' "$*"`);
  return { dir, bin };
};

const runLauncher = (dir: string, bin: string) => Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/dori.sh")], {
  env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_ENV_FILE: join(dir, "wrong.env"), DORI_CONFIG: join(dir, "wrong-config.json"), DORI_STATE_DIR: join(dir, "other-instance-state"), DORI_LEAD_PANE: "w1:p999", HC_SESSION: "inherited-host", HC_SOCKET: "/tmp/inherited.sock" },
  stdout: "pipe", stderr: "pipe",
});

test("dori.sh revives a stopped hc lead and attaches it in the Dori's named core", async () => {
  // Given: a stopped hc lead and its named core's socket
  const { dir, bin } = rig("session hc:t7 stopped");
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  await listen(join(dir, "run", "herdr-core", "agents.sock"));
  await listen(join(dir, "run", "herdr-core", "foreign.sock"));
  const child = runLauncher(dir, bin);
  // When
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: services start, the recorded lead is revived, and hc attaches it in agents, never herdr or aoe
  expect({ code, err, lines: out.trim().split("\n") }).toEqual({
    code: 0,
    err: "",
    lines: ["systemctl --user start dori-inbound.service dori-google-watch.service", "dori revive hc:t7", "hc session=agents attach t7"],
  });
  // and the lead was looked up and revived by this checkout's CLI with the account's own files: neither another instance's
  // state dir nor a wrapper on PATH chose the session (review 1 of #453)
  const config = join(dir, ".dori", "config.json");
  expect(readFileSync(join(dir, "cli-calls"), "utf8")).toBe(`lead state=unset config=${config}\nrevive state=unset config=${config}\n`);
});

test("dori.sh treats a socket a killed core left as no core", async () => {
  // Given: a live hc lead and a plain file where its named core's socket would be, with no listener
  const { dir, bin } = rig("session hc:t7");
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  writeFileSync(join(dir, "run", "herdr-core", "agents.sock"), "");
  const child = runLauncher(dir, bin);
  // When
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: refused before any lead lookup or hc call, so hc cannot start a core there
  expect(code).not.toBe(0);
  expect(err).toContain("not starting one");
  expect(out).not.toContain("hc session=");
  expect(await Bun.file(join(dir, "cli-calls")).exists()).toBe(false);
});

test("dori.sh never starts a missing hc core", async () => {
  // Given: a live hc lead but no named-core socket
  const { dir, bin } = rig("session hc:t7");
  const child = runLauncher(dir, bin);
  // When
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: the helper refuses before hc attach, and there is no revive of a live lead
  expect(code).not.toBe(0);
  expect(err).toContain("agents");
  expect(err).toContain("not starting one");
  expect(out).not.toContain("hc session=");
  expect(out).not.toContain("dori revive");
});

test("dori.sh checks the core before the real dori CLI can call hc", async () => {
  for (const leadOverride of ["", "DORI_LEAD_TMUX=hc:t7\n", "DORI_LEAD_PANE=hc:t7\n"]) {
    // Given: the real dori CLI on PATH, an hc lead selected by config or by the account's dori.env, and no core socket
    const dir = mkdtempSync(join(tmpdir(), "dori-hc-real-cli-"));
    dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, ".dori"));
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(dir, ".bun", "bin", "bun"));
  symlinkSync(join(import.meta.dir, "../../../.."), join(dir, ".dori", "src"));
  writeFileSync(join(dir, ".dori", "config.json"), JSON.stringify({ runtime: "hc", leadPane: leadOverride ? "w1:p2" : "hc:t7" }));
  writeFileSync(join(dir, ".dori", "dori.env"), `HC_SESSION=agents\n${leadOverride}`);
  writeFileSync(join(dir, "wrong.env"), "HC_SESSION=foreign\n");
  writeFileSync(join(bin, "dori"), `#!/bin/sh\nexec "$HOME/.bun/bin/bun" "$HOME/.dori/src/skills/dori-mode/scripts/src/cli.ts" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nprintf 'systemctl %s\\n' "$*"\n`, { mode: 0o700 });
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/hc-calls"\ncase "$2" in ls) printf '{"terminals":[]}' ;; get) printf '{"error":{"kind":"not_found","message":"no such terminal"}}' >&2; exit 3 ;; esac\n`, { mode: 0o700 });
  const child = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/dori.sh")], {
    env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_STATE_DIR: join(dir, "state"), DORI_ENV_FILE: join(dir, "wrong.env") },
    stdout: "pipe", stderr: "pipe",
  });
  // When
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  // Then: the guard runs before lead resolution or revival, so the real CLI never gets to call hc
  expect(code).not.toBe(0);
  expect(err).toContain("not starting one");
    expect(await Bun.file(join(dir, "hc-calls")).exists()).toBe(false);
  }
});

test("the hc core name uses the dori.env parser: whitespace, quotes and the first value", () => {
  // Given / When / Then
  expect(hcCore("  HC_SESSION= \"agents\"\nHC_SESSION=other\n")).toBe("agents");
  expect(hcCore("HC_SESSION='agents'\n")).toBe("agents");
  expect(hcCore("OTHER=x\n")).toBe("");
});
