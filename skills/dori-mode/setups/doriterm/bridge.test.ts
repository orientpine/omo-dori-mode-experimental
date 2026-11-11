import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// a row's argv as hc 0.1.18 shows it: only `hc get --json` has it, `hc ls --json` leaves it out (review 11 of #404)
const ATTACH = ["/bin/sh", join(import.meta.dir, "attach.sh")];
const start = (name: string, account = "", actual = name) => `run --bg --no-parent --name ${actual} --label dori.doriterm=bridge --label dori.row=${name} -- ${ATTACH.join(" ")}${account ? ` ${account}` : ""}`;
const discover = (account = "") => ["exec", "--", ...ATTACH, account, "--lanes"].join(" ");
type Row = { name: string; state: string; address?: string; argv?: string[] };

async function bridgeWithFakeHc(terminals: Row[], args: string[] = [], env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-bridge-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(join(dir, "get"));
  if (args[0] !== "stop") {
    mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
    writeFileSync(join(dir, "run", "herdr-core", "default.sock"), "");
  }
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  writeFileSync(join(dir, ".bun", "bin", "bun"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  writeFileSync(join(dir, "sudo"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  // hc gives every row its address; a row given none here gets t1, t2, ... in list order, as hc numbers this machine's
  const rows = terminals.map((t, i) => (t.address ? t : { ...t, address: `t${i + 1}` }));
  for (const t of rows) {
    if (!t.argv) continue; // no full record: hc get answers not_found
    for (const key of [t.name, t.address].filter(Boolean)) {
      mkdirSync(join(dir, "get", `${key}.json`, ".."), { recursive: true }); // another machine's row is <machine>/tN
      writeFileSync(join(dir, "get", `${key}.json`), JSON.stringify(t));
    }
  }
  writeFileSync(join(dir, "ls.json"), JSON.stringify({ terminals: rows.map(({ argv: _argv, ...short }) => short) }));
  writeFileSync(join(dir, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$1" in
  exec) [ "$2" = -- ] || exit 1; shift 2; exec "$@";;
  ls) cat "$HOME/ls.json";;
  get) if [ -f "$HOME/get/$3.json" ]; then cat "$HOME/get/$3.json"; else echo '{"error":{"kind":"not_found","message":"no such terminal"}}' >&2; exit 1; fi;;
  rm) if [ "$2" = "\${RM_LIVE_NAME:-}" ] && [ "$(grep -c "^rm $2\$" "$HOME/calls")" -le "\${RM_LIVE_TIMES:-0}" ]; then echo '{"error":{"kind":"live","message":"still running"}}' >&2; exit 1; fi;;
  run|server|kill) ;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "bridge.ts"), ...args], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_BRIDGE_NAME: "zzangdori", DORITERM_BRIDGES: "", DORI_CONFIG: "", DORI_RUNTIME: "", DORI_LEAD_PANE: "", HC_SESSION: "", XDG_RUNTIME_DIR: join(dir, "run"), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const recorded = Bun.file(join(dir, "calls"));
  const calls = (await recorded.exists()) ? (await recorded.text()).trim().split("\n") : [];
  return { code, out: out.trim(), err, calls };
}

test("starts the herdr client terminal when the account has none", async () => {
  // Given: hc lists another terminal only
  const r = await bridgeWithFakeHc([{ name: "other", state: "live" }]);
  // Then: one hc run of the attach-only herdr client, nothing typed
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("zzangdori: started");
  expect(r.calls).toEqual([discover(), "ls --all --json", "get --json t1", start("zzangdori")]);
});

test("leaves a live bridge alone", async () => {
  // Given: the bridge is already attached
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "live", argv: ATTACH }]);
  // Then: no second client is started
  expect(r.out).toBe("zzangdori: kept");
  expect(r.calls).toEqual([discover(), "ls --all --json", "get --json t1"]);
});

test("replaces a finished bridge after a core restart", async () => {
  // Given: the herdr client ended (the name stays taken until it is removed)
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "finished", argv: ATTACH }]);
  // Then: removed, then started again under the same name
  expect(r.out).toBe("zzangdori: started");
  expect(r.calls).toEqual([discover(), "ls --all --json", "get --json t1", "rm t1", start("zzangdori")]);
});

test("stop with no hc core running asks hc nothing, so it starts none", async () => {
  // When: the unit's ExecStopPost runs and this account's core has no socket
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "live" }], ["stop"]);
  // Then: no hc call at all (any hc call would start a core)
  expect(`${r.code} ${r.out}`).toBe("0 bridges: stopped");
  expect(r.calls).toEqual([]);
});

test("start with no host core socket asks hc nothing", async () => {
  const r = await bridgeWithFakeHc([], [], { HC_SESSION: "missing" });
  expect(r.calls).toEqual([]);
  expect(r.code).toBe(0);
});

test("stop ends only the bridge rows and never the core, whatever the Dori's config or environment says (reviews 4 and 5 of #404)", async () => {
  // Given: a running core (its socket) holding a live bridge, an ended one and the lead's terminal; no Dori config at all,
  // then one naming herdr while the environment chose hc
  for (const env of [{}, { DORI_RUNTIME: "hc", DORI_LEAD_PANE: "hc:t4" }]) {
    const r = await bridgeWithFakeHc(
      [{ name: "zzangdori", state: "live", argv: ATTACH }, { name: "okdori", state: "finished", argv: [...ATTACH, "okdori"] }, { name: "lead", state: "live" }],
      ["stop"],
      { DORITERM_BRIDGES: "zzangdori okdori:okdori", ...env },
      { "run/herdr-core/default.sock": "", ".dori/config.json": JSON.stringify({ runtime: "herdr" }) },
    );
    // Then: the live bridge is ended and both bridge rows removed; the lead's terminal and the core are left running
    expect(`${r.code} ${r.out}`).toBe("0 bridges: stopped");
    expect(r.calls).toEqual(["ls --all --json", "get --json t1", "get --json t2", "get --json t3", "kill t1", "rm t1", "rm t2"]);
  }
});

test("a live terminal that holds a bridge's name but is no bridge (an hc lane named zzangdori) is left alone by start and stop (review 10 of #404)", async () => {
  // Given: the name zzangdori held by a Dori lane, not by attach.sh
  const lane = { name: "zzangdori", state: "live", address: "t3", argv: ["env", "A=1", "/bin/sh"] };
  const started = await bridgeWithFakeHc([lane]);
  // Then: the row starts under a fallback name; stop on a running core kills and removes no foreign terminal
  expect(started.out).toBe("zzangdori: started");
  expect(started.calls).toEqual([discover(), "ls --all --json", "get --json t3", start("zzangdori", "", "zzangdori-row")]);
  const stopped = await bridgeWithFakeHc([lane], ["stop"], {}, { "run/herdr-core/default.sock": "" });
  expect(`${stopped.code} ${stopped.out}`).toBe("0 bridges: stopped");
  expect(stopped.calls).toEqual(["ls --all --json", "get --json t3"]);
});

test("an older finished terminal of another program under a bridge's name does not hide the live bridge listed after it (review 12 of #404)", async () => {
  // Given: hc lists rows in terminal-id order, so the finished foreign t1 comes before the live bridge t2 that took its name
  const rows = [
    { name: "zzangdori", state: "finished", address: "t1", argv: ["/bin/sh", "-c", "exit 0"] },
    { name: "zzangdori", state: "live", address: "t2", argv: ATTACH },
  ];
  // Then: start keeps the live bridge and starts no second one
  const started = await bridgeWithFakeHc(rows);
  expect(`${started.code} ${started.out}`).toBe("0 zzangdori: kept");
  expect(started.calls.filter((c) => c.startsWith("run "))).toEqual([]);
  // Then: stop ends and removes the live bridge t2 and leaves the foreign t1's record
  const stopped = await bridgeWithFakeHc(rows, ["stop"], {}, { "run/herdr-core/default.sock": "" });
  expect(`${stopped.code} ${stopped.out}`).toBe("0 bridges: stopped");
  expect(stopped.calls.filter((c) => /^(kill|rm) /.test(c))).toEqual(["kill t2", "rm t2"]);
});

test("only the exact bridge command is a bridge: an unrelated attach.sh or another account's attach is left alone (dori challenge on plan-r13 of #404)", async () => {
  // Given: zzangdori held by an unrelated program that happens to run a file called attach.sh, okdori held by the attach of
  // another account
  const rows = [
    { name: "zzangdori", state: "live", address: "t1", argv: ["/bin/sh", "/tmp/unrelated/attach.sh"] },
    { name: "okdori", state: "live", address: "t2", argv: [...ATTACH, "moodori"] },
  ];
  const env = { DORITERM_BRIDGES: "zzangdori okdori:okdori" };
  // Then: start uses fallback names; stop on a running core kills and removes neither foreign terminal
  const started = await bridgeWithFakeHc(rows, [], env);
  expect(started.out.split("\n")).toEqual([
    "zzangdori: started",
    "okdori: started",
  ]);
  expect(started.calls.filter((c) => /^(run|kill|rm) /.test(c))).toEqual([start("zzangdori", "", "zzangdori-row"), start("okdori", "okdori", "okdori-row")]);
  const stopped = await bridgeWithFakeHc(rows, ["stop"], env, { "run/herdr-core/default.sock": "" });
  expect(`${stopped.code} ${stopped.out}`).toBe("0 bridges: stopped");
  expect(stopped.calls.filter((c) => /^(kill|rm) /.test(c))).toEqual([]);
});

test("another machine's terminal under a bridge's name (<machine>/tN in hc ls --all) neither keeps the local bridge from coming back nor is ended by stop (review 13 of #404)", async () => {
  // Given: the local bridge t1 ended, and a live terminal on the mesh machine peer holds the same name, even running the
  // same command
  const remote = { name: "zzangdori", state: "live", address: "peer/t5", argv: ATTACH };
  const started = await bridgeWithFakeHc([{ name: "zzangdori", state: "finished", address: "t1", argv: ATTACH }, remote]);
  // Then: start removes the local record and starts the bridge here again, asking hc nothing about peer/t5
  expect(`${started.code} ${started.out}`).toBe("0 zzangdori: started");
  expect(started.calls).toEqual([discover(), "ls --all --json", "get --json t1", "rm t1", start("zzangdori")]);
  // Then: stop with the local bridge t2 live ends and removes t2 only, never the other machine's terminal
  const stopped = await bridgeWithFakeHc([{ name: "zzangdori", state: "live", address: "t2", argv: ATTACH }, remote], ["stop"], {}, { "run/herdr-core/default.sock": "" });
  expect(`${stopped.code} ${stopped.out}`).toBe("0 bridges: stopped");
  expect(stopped.calls).toEqual(["ls --all --json", "get --json t2", "kill t2", "rm t2"]);
});

test("a row whose full record cannot be read is taken for another terminal: start and stop leave it alone (review 11 of #404)", async () => {
  // Given: hc lists a live zzangdori, but hc get gives no record of it
  const row = { name: "zzangdori", state: "live", address: "t5" };
  const started = await bridgeWithFakeHc([row]);
  expect(started.out).toBe("zzangdori: started");
  expect(started.calls).toEqual([discover(), "ls --all --json", "get --json t5", start("zzangdori", "", "zzangdori-row")]);
  const stopped = await bridgeWithFakeHc([row], ["stop"], {}, { "run/herdr-core/default.sock": "" });
  expect(`${stopped.code} ${stopped.out}`).toBe("0 bridges: stopped");
  expect(stopped.calls).toEqual(["ls --all --json", "get --json t5"]);
});

test("stop waits for a bridge that takes a moment to exit, and one that never does still lets the others close (review 6 of #404)", async () => {
  const live = [{ name: "zzangdori", state: "live", argv: ATTACH }, { name: "okdori", state: "live", argv: [...ATTACH, "okdori"] }];
  const files = { "run/herdr-core/default.sock": "" };
  // Given: zzangdori's (t1) rm answers live once after its kill
  const slow = await bridgeWithFakeHc(live, ["stop"], { DORITERM_BRIDGES: "zzangdori okdori:okdori", RM_LIVE_NAME: "t1", RM_LIVE_TIMES: "1" }, files);
  // Then: retried until removed, then okdori closed too
  expect(`${slow.code} ${slow.out}`).toBe("0 bridges: stopped");
  expect(slow.calls).toEqual(["ls --all --json", "get --json t1", "get --json t2", "kill t1", "rm t1", "rm t1", "kill t2", "rm t2"]);
  // Given: zzangdori never leaves
  const stuck = await bridgeWithFakeHc(live, ["stop"], { DORITERM_BRIDGES: "zzangdori okdori:okdori", RM_LIVE_NAME: "t1", RM_LIVE_TIMES: "99" }, files);
  // Then: okdori is still closed, and the stop fails naming zzangdori
  expect(stuck.code).not.toBe(0);
  expect(stuck.err).toContain("zzangdori");
  expect(stuck.calls.slice(-2)).toEqual(["kill t2", "rm t2"]);
}, 15_000);

test("one row per listed Dori, in order: a live one kept, an ended one replaced, a missing one started as its account", async () => {
  // Given: this host's list, with zzangdori live and okdori ended
  const r = await bridgeWithFakeHc(
    [{ name: "zzangdori", state: "live", argv: ATTACH }, { name: "okdori", state: "finished", argv: [...ATTACH, "okdori"] }],
    [],
    { DORITERM_BRIDGES: "zzangdori okdori:okdori yoodori:yoodori" },
  );
  // Then: one hc ls, nothing for zzangdori, okdori removed and started again, yoodori started; each other Dori's row
  // attaches as that account
  expect(r.err).toBe("");
  expect(r.out.split("\n")).toEqual(["zzangdori: kept", "okdori: started", "yoodori: started"]);
  expect(r.calls).toEqual([
    discover(), discover("okdori"), discover("yoodori"),
    "ls --all --json",
    "get --json t1",
    "get --json t2",
    "rm t2",
    start("okdori", "okdori"),
    start("yoodori", "yoodori"),
  ]);
});

test("a malformed list starts nothing", async () => {
  // Given: a name hc would refuse and a name listed twice
  for (const spec of ["Okdori:okdori", "okdori:okdori okdori:moodori", "okdori:ok:dori"]) {
    const r = await bridgeWithFakeHc([], [], { DORITERM_BRIDGES: spec });
    // Then: it fails before asking hc anything
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual([]);
  }
});

test("attach.sh with an account attaches to that account's herdr through sudo -n, never starting a server", async () => {
  // Given: a fake sudo that records its argv on one line and ends the loop on the second call
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-acct-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sudo"), `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$HOME/calls"; echo >> "$HOME/calls"
n=$(wc -l < "$HOME/calls")
[ "$n" -ge 2 ] && kill -TERM "$PPID"
exit 1
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh"), "okdori"], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  // Then: retried, each time as okdori with its own HOME, focusing its lead with its own doriterm focus-lead.ts and then
  // running the attach-only client
  const calls = (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.startsWith("-n -u okdori -H /bin/sh -c ")).toBe(true);
    expect(c).toContain('"$HOME/.bun/bin/bun" "$HOME/.dori/src/skills/dori-mode/setups/doriterm/focus-lead.ts"');
    expect(c.trim().endsWith("exec herdr client")).toBe(true);
  }
});

async function attachWithFakes(files: Record<string, string> = {}) {
  // a fake bun (records which config it focused the lead from) and a fake herdr whose server answers on the third attach
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  // bun only under ~/.bun/bin, where the account's own bun lives; the units' PATH does not include it
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  writeFileSync(join(dir, ".bun", "bin", "bun"), `#!/bin/sh
printf 'focus %s %s\\n' "$DORI_CONFIG" "$1" >> "$HOME/calls"
`, { mode: 0o700 });
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
n=$(grep -c '^client$' "$HOME/calls")
[ "$n" -ge 3 ] || exit 1
kill -TERM "$PPID"
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  return { dir, calls: (await Bun.file(join(dir, "calls")).text()).trim().split("\n") };
}

test("attach.sh focuses the lead's tab, then keeps trying herdr client until the server is up, and never starts one", async () => {
  // Given: no instance config, so the account's own ~/.dori/config.json
  const { dir, calls } = await attachWithFakes();
  const focus = `focus ${dir}/.dori/config.json ${dir}/.dori/src/skills/dori-mode/setups/doriterm/focus-lead.ts`;
  const preflight = `focus ${dir}/.dori/config.json ${dir}/.dori/src/skills/dori-mode/scripts/src/hc-lead-core.ts`;
  // Then: each attach first checks whether an hc lead needs a core, then focuses the herdr lead and runs the client
  expect(calls).toEqual([preflight, focus, "client", preflight, focus, "client", preflight, focus, "client"]);
});

test("attach.sh takes an instance account's ~/.<user>/config.json for the lead", async () => {
  // Given: the account keeps its Dori config under ~/.<its user name>/ (okdori: ~/.okdori/config.json)
  const user = (await Bun.$`id -un`.text()).trim();
  const { dir, calls } = await attachWithFakes({ [`.${user}/config.json`]: "{}" });
  // Then: that config, not ~/.dori/config.json
  expect(calls[0]).toBe(`focus ${dir}/.${user}/config.json ${dir}/.dori/src/skills/dori-mode/scripts/src/hc-lead-core.ts`);
  expect(calls[1]).toBe(`focus ${dir}/.${user}/config.json ${dir}/.dori/src/skills/dori-mode/setups/doriterm/focus-lead.ts`);
});
