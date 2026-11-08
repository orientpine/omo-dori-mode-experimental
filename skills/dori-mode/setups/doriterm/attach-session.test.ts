import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Review 8 of #404: hc terminal ids are per core, so attach.sh attaches in the target Dori's own core - the HC_SESSION its
// dori.env names, else the default core - never in the one the bridge host's environment happens to select.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function attachHc(dotenv: string | undefined, inherited: Record<string, string>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-core-"));
  dirs.push(dir);
  const user = (await Bun.$`id -un`.text()).trim();
  mkdirSync(join(dir, `.${user}`), { recursive: true });
  writeFileSync(join(dir, `.${user}`, "config.json"), JSON.stringify({ leadPane: "hc:t4" }, null, 2));
  if (dotenv !== undefined) writeFileSync(join(dir, `.${user}`, "dori.env"), dotenv);
  writeFileSync(join(dir, "hc"), `#!/bin/sh
printf 'core=%s hc %s\\n' "\${HC_SESSION:-default}" "$*" >> "$HOME/calls"
kill -TERM $(ps -o ppid= -p $PPID)
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, ...inherited, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  return (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
}

test("attach.sh attaches in the named core the target Dori's dori.env sets, quoted or exported", async () => {
  expect(await attachHc("TOKEN=x\nHC_SESSION=named\n", { HC_SESSION: "host" })).toEqual(["core=named hc attach t4"]);
  expect(await attachHc("export HC_SESSION='named'\n", {})).toEqual(["core=named hc attach t4"]);
});

test("attach.sh attaches in the default core when the target's dori.env names none, whatever HC_SESSION the bridge host has", async () => {
  expect(await attachHc("TOKEN=x\n", { HC_SESSION: "host" })).toEqual(["core=default hc attach t4"]);
  expect(await attachHc(undefined, { HC_SESSION: "host" })).toEqual(["core=default hc attach t4"]);
});
