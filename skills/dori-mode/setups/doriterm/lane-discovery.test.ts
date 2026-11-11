import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(lead = "hc:t4", socket: boolean | "stale" = true) {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-lanes-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".dori"), { recursive: true });
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  mkdirSync(join(dir, "state", "lanes"), { recursive: true });
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  symlinkSync(process.execPath, join(dir, ".bun", "bin", "bun"));
  symlinkSync(join(import.meta.dir, "../../../.."), join(dir, ".dori", "src"));
  writeFileSync(join(dir, ".dori", "config.json"), JSON.stringify({ leadPane: lead, stateDir: join(dir, "state") }));
  writeFileSync(join(dir, ".dori", "dori.env"), "HC_SESSION=agents\n");
  const path = join(dir, "run", "herdr-core", "agents.sock");
  if (socket === "stale") writeFileSync(path, "");
  else if (socket) {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
  }
  writeFileSync(join(dir, "hc"), `#!/bin/sh
printf '%s %s\\n' "\${HC_SESSION:-default}" "$*" >> "$HOME/hc-calls"
case "$1" in
  ls) printf '{"terminals":[{"address":"t7","state":"live"},{"address":"t8","state":"finished"},{"address":"t1b","state":"live"}]}' ;;
  get) case "$3" in t7) printf '{"state":"live"}' ;; *) printf '{"state":"finished"}' ;; esac ;;
  attach) printf 'attached %s %s\\n' "$HC_SESSION" "$2" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), '#!/bin/sh\necho unexpected-retry >&2\nkill -TERM "$PPID"\n', { mode: 0o755 });
  const env = {
    ...process.env, HOME: dir, PATH: `${dir}:${process.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"),
    DORI_CONFIG: join(dir, ".dori", "config.json"), DORI_ENV_FILE: join(dir, ".dori", "dori.env"),
    DORI_STATE_DIR: undefined, DORI_LEAD_TMUX: undefined, DORI_LEAD_PANE: undefined, HC_SESSION: "foreign", HC_SOCKET: "/tmp/foreign.sock",
  };
  const lane = (key: string, pane: string, status = "working") => writeFileSync(join(dir, "state", "lanes", `${key}.json`), JSON.stringify({ key, pane, status, title: key, thread: "none", brief: "", done: "", openedAt: "" }));
  const invoke = async (args: readonly string[]) => {
    const child = Bun.spawn([...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const calls = Bun.file(join(dir, "hc-calls"));
    return { code, out: out.trim(), err, calls: await calls.exists() ? (await calls.text()).trim().split("\n") : [] };
  };
  const helper = (...args: string[]) => invoke([process.execPath, join(import.meta.dir, "../../scripts/src/hc-lead-core.ts"), ...args]);
  const attach = (target: string) => invoke(["/bin/sh", join(import.meta.dir, "attach.sh"), "", target]);
  return { dir, env, lane, helper, attach };
}

test("lanes mode reads open live hc lanes from this Dori's configured state and core", async () => {
  const f = await fixture();
  f.lane("live-one", "hc:t7");
  f.lane("paused-one", "hc:t1b", "paused");
  f.lane("ended-one", "hc:t8");
  f.lane("closed-one", "hc:t7", "closed");
  f.lane("herdr-one", "w1:p2");
  f.lane("remote-one", "hc:peer/t7");
  const r = await f.helper("lanes");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual([{ key: "live-one", terminal: "t7" }, { key: "paused-one", terminal: "t1b" }]);
  expect(r.calls).toEqual(["agents ls --json"]);
});

test.each([["hc:t4", false], ["hc:t4", "stale"], ["w1:p2", true]] as const)("lanes mode asks hc nothing for lead %s with socket %s", async (lead, socket) => {
  const f = await fixture(lead, socket);
  f.lane("live-one", "hc:t7");
  const r = await f.helper("lanes");
  expect({ code: r.code, rows: JSON.parse(r.out), calls: r.calls }).toEqual({ code: 0, rows: [], calls: [] });
});

test("lanes mode honors the account's environment state directory and effective hc lead", async () => {
  const f = await fixture("w1:p2");
  mkdirSync(join(f.dir, "other", "lanes"), { recursive: true });
  writeFileSync(join(f.dir, "other", "lanes", "other-one.json"), JSON.stringify({ key: "other-one", pane: "hc:t7", status: "working" }));
  writeFileSync(join(f.dir, ".dori", "dori.env"), `HC_SESSION=agents\nDORI_LEAD_TMUX=hc:t4\nDORI_STATE_DIR=${join(f.dir, "other")}\n`);
  f.lane("wrong-one", "hc:t7");
  const r = await f.helper("lanes");
  expect(JSON.parse(r.out)).toEqual([{ key: "other-one", terminal: "t7" }]);
});

test("a lane attach selects that terminal in the Dori core and exits without retrying", async () => {
  const f = await fixture();
  const r = await f.attach("t7");
  expect({ code: r.code, out: r.out, err: r.err, calls: r.calls }).toEqual({
    code: 0, out: "doriterm: lane hc:t7; attaching\nattached agents t7", err: "",
    calls: ["agents get --json t7", "agents attach t7"],
  });
});

test.each([["t8", true], ["t7", false], ["t7", "stale"]] as const)("a lane attach exits when %s is unavailable with socket %s", async (terminal, socket) => {
  const f = await fixture("hc:t4", socket);
  const r = await f.attach(terminal);
  expect(r.code).not.toBe(0);
  expect(r.calls).toEqual(socket === true ? [`agents get --json ${terminal}`] : []);
  expect(r.err).not.toContain("unexpected-retry");
});

test("the host units retain NoNewPrivileges while discovery runs in the hc core", async () => {
  // Machine-consumed systemd policy: discovery must not require weakening either shipped unit.
  for (const unit of ["doriface-host.service", "doriterm-bridges.service"]) {
    const policy = (await Bun.file(join(import.meta.dir, unit)).text()).split("\n").filter((line) => line.startsWith("NoNewPrivileges="));
    expect(policy).toEqual(["NoNewPrivileges=true"]);
  }
});
