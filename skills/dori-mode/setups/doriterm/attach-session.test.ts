import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeRun } from "./bridge.ts";

// Review 9 of #404: doriterm's bridges live in the bridge host's own hc core, whatever core a Dori's dori.env names, and
// doriterm does not show a Dori whose lead runs on hc yet (option B, docs/follow-ups.md): its row says so and attaches nothing.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "doriterm-core-"));
  dirs.push(d);
  return d;
};

test("the bridges' hc calls go to the bridge host's core, not the core the host account's dori.env names", async () => {
  const d = scratch();
  writeFileSync(join(d, "hc"), "#!/bin/sh\nif [ -n \"$HC_SESSION\" ]; then printf '%s' \"$HC_SESSION\"; else printf default; fi\n");
  chmodSync(join(d, "hc"), 0o755);
  writeFileSync(join(d, "dori.env"), "HC_SESSION=agents\n");
  const keep = { env: process.env["DORI_ENV_FILE"], hc: process.env["HC_SESSION"] };
  process.env["DORI_ENV_FILE"] = join(d, "dori.env");
  try {
    delete process.env["HC_SESSION"];
    expect((await bridgeRun([join(d, "hc"), "ls"])).out).toBe("default");
    process.env["HC_SESSION"] = "host";
    expect((await bridgeRun([join(d, "hc"), "ls"])).out).toBe("host");
  } finally {
    for (const [k, v] of [["DORI_ENV_FILE", keep.env], ["HC_SESSION", keep.hc]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("attach.sh shows a Dori whose lead is an hc terminal as not shown yet, and runs neither hc attach nor herdr client", async () => {
  const dir = scratch();
  const user = (await Bun.$`id -un`.text()).trim();
  mkdirSync(join(dir, `.${user}`), { recursive: true });
  writeFileSync(join(dir, `.${user}`, "config.json"), JSON.stringify({ leadPane: "hc:t4" }, null, 2));
  for (const name of ["hc", "herdr"]) writeFileSync(join(dir, name), `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$HOME/calls"\n`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0", DORITERM_LEAD_CHECK_SECONDS: "0.2" },
    stdout: "pipe", stderr: "pipe",
  });
  // read until the row's line arrives (bounded by the test timeout), then stop the loop
  const reader = child.stdout.getReader();
  let said = "";
  while (!said.includes("runs its lead on hc (hc:t4)")) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
  }
  child.kill();
  await child.exited;
  expect(said).toContain("runs its lead on hc (hc:t4)");
  expect(await Bun.file(join(dir, "calls")).exists()).toBe(false);
}, 10_000);
