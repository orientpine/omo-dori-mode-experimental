// doriterm (doriface-host) shows herdr-core (hc) terminals only, not herdr 0.9.5 panes. A bridge is one hc terminal
// running attach.sh, which keeps `herdr client` attached to a running herdr server; unlike plain `herdr` it never starts
// one. One row per Dori: DORITERM_BRIDGES lists them as name[:account] (the account's own herdr server through sudo; no
// account = this account's), default the one pilot row DORITERM_BRIDGE_NAME or zzangdori. hc --keep would bring back a
// shell rather than the client after a core restart, so this re-creates a row that ended or was closed instead; the
// unit runs it when the host starts and the timer every minute. It never types into herdr and never focuses a pane:
// attaching is all it does. hc runs its core as its own systemd user service, outside doriface-host.service, and that core
// may also hold the account's own Dori (its lead and lanes, however the Dori chose hc), so `stop` ends and removes only
// the bridge rows it owns and leaves the core running; with no core running it asks hc nothing, so it starts none
// (reviews 4 and 5 of #404).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Ran, run, type Runner } from "../../scripts/src/run.ts";

type Terminal = { readonly name?: string; readonly state?: string; readonly address?: string; readonly argv?: readonly unknown[] };

// A bridge runs attach.sh; a name is held by whatever terminal has it now (hc resolves a name to its live holder), so a
// Dori lane named like a bridge is never taken for one (review 10 of #404). hc 0.1.18's ls leaves argv out, so each row of
// a bridge's name is read in full with hc get; only a record whose argv runs attach.sh is a bridge, and a record that cannot
// be read is another terminal's (review 11 of #404).
async function owned(runner: Runner, t: Terminal, name: string): Promise<boolean> {
  const got = await runner(["hc", "get", "--json", t.address ?? name]);
  if (got.code !== 0) return false;
  try {
    const argv = (JSON.parse(got.out) as Terminal).argv;
    return Array.isArray(argv) && argv.some((a) => typeof a === "string" && a.endsWith("/attach.sh"));
  } catch {
    return false;
  }
}
const heldBy = (bridge: Bridge, t: Terminal): string => `${bridge.name}: the name is held by another terminal (${t.address ?? "?"}), not a bridge; left alone`;
export type Bridge = { readonly name: string; readonly account?: string };

const NAME = /^[a-z0-9_-]{1,32}$/; // hc's terminal name rule
const ACCOUNT = /^[a-z_][a-z0-9_-]*$/;

export function parseBridges(spec: string): Bridge[] {
  const bridges = spec.split(/\s+/).filter(Boolean).map((item) => {
    const [name = "", account, extra] = item.split(":");
    if (extra !== undefined || !NAME.test(name) || (account !== undefined && !ACCOUNT.test(account))) {
      throw new Error(`bad bridge ${JSON.stringify(item)}: want name[:account], name 1-32 of a-z 0-9 - _`);
    }
    return account ? { name, account } : { name };
  });
  const names = bridges.map((b) => b.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`bridge ${twice} is listed twice`);
  if (bridges.length === 0) throw new Error("no bridges listed");
  return bridges;
}

export function bridgeCommand(bridge: Bridge): string[] {
  return ["/bin/sh", join(import.meta.dir, "attach.sh"), ...(bridge.account ? [bridge.account] : [])];
}

export async function ensureBridges(runner: Runner, bridges: readonly Bridge[]): Promise<string[]> {
  const ls = await runner(["hc", "ls", "--all", "--json"]);
  if (ls.code !== 0) throw new Error(`hc ls failed: ${ls.err || ls.out}`);
  const terminals = (JSON.parse(ls.out) as { terminals?: Terminal[] }).terminals ?? [];
  const results: string[] = [];
  for (const bridge of bridges) {
    // hc lists every record of a name, in terminal-id order: a finished record of another program may come before the live
    // bridge that took its name, so the live holder decides (review 12 of #404)
    const rows = terminals.filter((t) => t.name === bridge.name);
    const live = rows.find((t) => t.state === "live");
    if (live) { results.push((await owned(runner, live, bridge.name)) ? `${bridge.name}: kept` : heldBy(bridge, live)); continue; }
    // a finished bridge's record is removed, a finished foreign one keeps its record; the name is free for the bridge anyway
    for (const t of rows) {
      if (!(await owned(runner, t, bridge.name))) continue;
      const rm = await runner(["hc", "rm", t.address ?? bridge.name]);
      if (rm.code !== 0) throw new Error(`hc rm ${bridge.name} failed: ${rm.err || rm.out}`);
    }
    const started = await runner(["hc", "run", "--bg", "--no-parent", "--name", bridge.name, "--", ...bridgeCommand(bridge)]);
    if (started.code !== 0) throw new Error(`hc run ${bridge.name} failed: ${started.err || started.out}`);
    results.push(`${bridge.name}: started`);
  }
  return results;
}

// hc's core makes its socket at $XDG_RUNTIME_DIR/herdr-core/<session>.sock (HC_SESSION, else default) and removes it when
// it stops; read without an hc call, since any hc call starts a core
export function coreRunning(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const dir = env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid?.() ?? 0}`;
  return existsSync(join(dir, "herdr-core", `${env["HC_SESSION"] || "default"}.sock`));
}

const kindOf = (r: Ran): string | undefined => /"kind"\s*:\s*"([a-z_]+)"/.exec(`${r.err}${r.out}`)?.[1];
const RM_TRIES = 10;
const RM_WAIT_MS = 300;

// ends each listed bridge that still runs and removes its row, waiting for a program that takes a moment to exit (rm answers
// live meanwhile); one that will not go is named after every other bridge was tried; every other terminal is left alone
export async function stopBridges(runner: Runner, bridges: readonly Bridge[], sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<void> {
  const ls = await runner(["hc", "ls", "--all", "--json"]);
  if (ls.code !== 0) throw new Error(`hc ls failed: ${ls.err || ls.out}`);
  const terminals = (JSON.parse(ls.out) as { terminals?: Terminal[] }).terminals ?? [];
  const failed: string[] = [];
  // every record of a bridge's name is looked at, since another program's older record may come first (review 12 of #404)
  for (const bridge of bridges) {
    for (const found of terminals.filter((t) => t.name === bridge.name)) {
      if (!(await owned(runner, found, bridge.name))) continue;
      const target = found.address ?? bridge.name;
      if (found.state === "live") {
        const k = await runner(["hc", "kill", target]);
        if (k.code !== 0 && kindOf(k) !== "not_found") {
          failed.push(`hc kill ${bridge.name} failed: ${k.err || k.out}`);
          continue;
        }
      }
      for (let i = 1; ; i++) {
        const r = await runner(["hc", "rm", target]);
        if (r.code === 0 || kindOf(r) === "not_found") break;
        if (kindOf(r) !== "live" || i >= RM_TRIES) {
          failed.push(`hc rm ${bridge.name} failed: ${r.err || r.out}`);
          break;
        }
        await sleep(RM_WAIT_MS);
      }
    }
  }
  if (failed.length) throw new Error(failed.join("; "));
}

// The bridges live in this host's own hc core (its HC_SESSION, else the default core), the one coreRunning checks and
// doriface-host connects to, never the core a Dori's dori.env names for that Dori's sessions (review 9 of #404).
export const bridgeRun: Runner = (argv, opts = {}) => run(argv, { ...opts, env: { HC_SESSION: process.env["HC_SESSION"], ...opts.env } });

if (import.meta.main) {
  const bridges = () => parseBridges(process.env["DORITERM_BRIDGES"] || process.env["DORITERM_BRIDGE_NAME"] || "zzangdori");
  if (process.argv[2] === "stop") {
    if (coreRunning()) await stopBridges(bridgeRun, bridges());
    console.log("bridges: stopped");
  } else {
    for (const line of await ensureBridges(bridgeRun, bridges())) console.log(line);
  }
}
