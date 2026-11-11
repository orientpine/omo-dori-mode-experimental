import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeRun } from "./bridge.ts";

// Review 9 of #404 left an hc lead unshown; the follow-up PR attaches it in the Dori's own core.
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// a running core's socket accepts connections; a plain file at the path is what a killed core leaves
const listen = (path: string): Promise<void> => new Promise((resolve) => {
  const server = createServer();
  servers.push(server);
  server.listen(path, () => resolve());
});
const until = async (stream: ReadableStream<Uint8Array>, text: string): Promise<string> => {
  const reader = stream.getReader();
  let said = "";
  while (!said.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return said;
};
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "doriterm-core-"));
  dirs.push(d);
  return d;
};
const bunAndSource = (dir: string): void => {
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(dir, ".bun", "bin", "bun"));
  mkdirSync(join(dir, ".dori"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../.."), join(dir, ".dori", "src"));
};

test("the bridges' hc calls go to the bridge host's core, not the core the host account's dori.env names", async () => {
  const d = scratch();
  writeFileSync(join(d, "hc"), "#!/bin/sh\nif [ -n \"$HC_SOCKET\" ]; then printf 'wrong socket'; elif [ -n \"$HC_SESSION\" ]; then printf '%s' \"$HC_SESSION\"; else printf default; fi\n");
  chmodSync(join(d, "hc"), 0o755);
  writeFileSync(join(d, "dori.env"), "HC_SESSION=agents\n");
  const keep = { env: process.env["DORI_ENV_FILE"], hc: process.env["HC_SESSION"], socket: process.env["HC_SOCKET"] };
  process.env["DORI_ENV_FILE"] = join(d, "dori.env");
  process.env["HC_SOCKET"] = "/tmp/another-core.sock";
  try {
    delete process.env["HC_SESSION"];
    expect((await bridgeRun([join(d, "hc"), "ls"])).out).toBe("default");
    process.env["HC_SESSION"] = "host";
    expect((await bridgeRun([join(d, "hc"), "ls"])).out).toBe("host");
  } finally {
    for (const [k, v] of [["DORI_ENV_FILE", keep.env], ["HC_SESSION", keep.hc], ["HC_SOCKET", keep.socket]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("attach.sh attaches an hc lead in the Dori's own core, so the owner can type into it as into a herdr lead, never through herdr", async () => {
  const user = (await Bun.$`id -un`.text()).trim();
  for (const [core, envText, expectedLead] of [
    ["default", "", "t4"],
    ["agents", "HC_SESSION=agents\nDORI_LEAD_TMUX=hc:t7\n", "t7"],
    ["agents", "HC_SESSION=agents\nDORI_LEAD_PANE=hc:t7\n", "t7"],
    ["agents", "HC_SESSION=agents\nDORI_LEAD_TMUX=hc:t7\nDORI_LEAD_PANE=hc:t8\n", "t7"],
  ]) {
    // Given: the config's lead is hc:t4, the account's dori.env chooses a named core (or none: the default core), and the
    // caller's HC_SESSION names another core
    const dir = scratch();
    mkdirSync(join(dir, `.${user}`), { recursive: true });
    writeFileSync(join(dir, `.${user}`, "config.json"), JSON.stringify({ leadPane: "hc:t4" }, null, 2));
    if (envText) writeFileSync(join(dir, `.${user}`, "dori.env"), envText);
    writeFileSync(join(dir, "wrong.env"), "HC_SESSION=inherited-env\n");
    bunAndSource(dir);
    mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
    await listen(join(dir, "run", "herdr-core", `${core}.sock`));
    writeFileSync(join(dir, "hc"), `#!/bin/sh\nif [ -n "$HC_SOCKET" ]; then printf 'unexpected socket %s\\n' "$HC_SOCKET"; fi\nprintf 'hc session=%s %s\\n' "\${HC_SESSION:-default}" "$*"\n`, { mode: 0o700 });
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf 'herdr %s\\n' "$*"\n`, { mode: 0o700 });
    const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
      env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_ENV_FILE: join(dir, "wrong.env"), DORI_LEAD_PANE: "w1:p999", HC_SESSION: "inherited-host", HC_SOCKET: "/tmp/inherited.sock", DORITERM_RETRY_SECONDS: "0.2" },
      stdout: "pipe", stderr: "pipe",
    });
    // When: the fake hc prints the attach; stop after that exact event, never after a delay
    const expected = `hc session=${core} attach ${expectedLead}\n`;
    const reader = child.stdout.getReader();
    let said = "";
    while (!said.includes(expected)) {
      const { value, done } = await reader.read();
      if (done) break;
      said += new TextDecoder().decode(value);
    }
    child.kill();
    await child.exited;
    // Then: the lead is attached for typing (no --observe), as a herdr row attaches its client; no herdr client is started
    expect(said).toContain(expected);
    expect(said).not.toContain("unexpected socket");
    expect(said).not.toContain("herdr ");
  }
}, 10_000);

test("attach.sh never starts a missing hc core: without its socket hc is not called", async () => {
  // Given: an hc lead but no socket for its named core
  const dir = scratch();
  const user = (await Bun.$`id -un`.text()).trim();
  mkdirSync(join(dir, `.${user}`), { recursive: true });
  writeFileSync(join(dir, `.${user}`, "config.json"), JSON.stringify({ leadPane: "hc:t4" }));
  writeFileSync(join(dir, `.${user}`, "dori.env"), "HC_SESSION=agents\n");
  bunAndSource(dir);
  writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf 'unexpected hc %s\\n' "$*"\n`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_LEAD_PANE: "w1:p999", DORITERM_RETRY_SECONDS: "0.2" },
    stdout: "pipe", stderr: "pipe",
  });
  // When: the helper reports the missing core; stop on that exact line
  const reader = child.stderr.getReader();
  let said = "";
  while (!said.includes("not starting one")) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
  }
  child.kill();
  await child.exited;
  // Then
  expect(said).toContain("agents");
  expect(said).toContain("not starting one");
  expect(await new Response(child.stdout).text()).not.toContain("unexpected hc");
}, 10_000);

test("attach.sh treats a socket a killed core left as no core", async () => {
  // Given: an hc lead and a plain file, no listener, where its core's socket would be
  const dir = scratch();
  const user = (await Bun.$`id -un`.text()).trim();
  mkdirSync(join(dir, `.${user}`), { recursive: true });
  writeFileSync(join(dir, `.${user}`, "config.json"), JSON.stringify({ leadPane: "hc:t4" }));
  bunAndSource(dir);
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  writeFileSync(join(dir, "run", "herdr-core", "default.sock"), "");
  writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf 'unexpected hc %s\\n' "$*"\n`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_LEAD_PANE: "w1:p999", DORITERM_RETRY_SECONDS: "0.2" },
    stdout: "pipe", stderr: "pipe",
  });
  // When: stop on the refusal line
  const said = await until(child.stderr, "not starting one");
  child.kill();
  await child.exited;
  // Then: hc is never called, so it cannot start a core on that path
  expect(said).toContain("not starting one");
  expect(await new Response(child.stdout).text()).not.toContain("unexpected hc");
}, 10_000);

test("attach.sh moves to the new lead when a handover replaces it while the row is attached, leaving both terminals alone", async () => {
  // Given: a row attached to hc:t4; the fake hc attach stays attached until its client is ended (or the test dir goes), as a
  // real client does
  const dir = scratch();
  const user = (await Bun.$`id -un`.text()).trim();
  const config = join(dir, `.${user}`, "config.json");
  mkdirSync(join(dir, `.${user}`), { recursive: true });
  writeFileSync(config, JSON.stringify({ leadPane: "hc:t4" }));
  bunAndSource(dir);
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  await listen(join(dir, "run", "herdr-core", "default.sock"));
  writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf 'hc %s\\n' "$*"\nwhile [ -d "$HOME" ]; do sleep 0.2; done\n`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_LEAD_PANE: "w1:p999", DORITERM_RETRY_SECONDS: "0.2" },
    stdout: "pipe", stderr: "pipe",
  });
  const first = await until(child.stdout, "hc attach t4\n");
  // When: a handover points the config at the new lead hc:t9 (the old t4 is frozen, not ended, so its attach would stay)
  writeFileSync(config, JSON.stringify({ leadPane: "hc:t9" }));
  const then = await until(child.stdout, "hc attach t9\n");
  child.kill();
  await child.exited;
  // Then: the row attached t9; only attach clients ran, never a kill or rm of a terminal
  expect(first).toContain("hc attach t4");
  expect(then).toContain("hc attach t9");
  expect(`${first}${then}`).not.toMatch(/hc (kill|rm|interrupt)/);
}, 10_000);
