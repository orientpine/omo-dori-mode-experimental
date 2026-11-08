// doriterm (doriface-host) shows herdr-core (hc) terminals only, not herdr 0.9.5 panes. A bridge is one hc terminal
// running attach.sh, which keeps `herdr client` attached to a running herdr server; unlike plain `herdr` it never starts
// one. One row per Dori: DORITERM_BRIDGES lists them as name[:account] (the account's own herdr server through sudo; no
// account = this account's), default the one pilot row DORITERM_BRIDGE_NAME or zzangdori. hc --keep would bring back a
// shell rather than the client after a core restart, so this re-creates a row that ended or was closed instead; the
// unit runs it when the host starts and the timer every minute. It never types into herdr and never focuses a pane:
// attaching is all it does. hc runs its core as its own systemd user service, outside doriface-host.service, so `stop`
// stops the core, which ends the bridges (not kept terminals) with it; with no core running it starts none. On an account
// whose own Dori runs on hc (its config chooses hc or its lead is an hc terminal) that core also holds the lead and the
// lanes, so `stop` ends and removes only the bridge rows and leaves the core running (review 4 of #404).
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { run, type Runner, runtimeChoice } from "../../scripts/src/run.ts";

type Terminal = { readonly name?: string; readonly state?: string };
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
    const found = terminals.find((t) => t.name === bridge.name);
    if (found?.state === "live") { results.push(`${bridge.name}: kept`); continue; }
    if (found) {
      const rm = await runner(["hc", "rm", bridge.name]);
      if (rm.code !== 0) throw new Error(`hc rm ${bridge.name} failed: ${rm.err || rm.out}`);
    }
    const started = await runner(["hc", "run", "--bg", "--no-parent", "--name", bridge.name, "--", ...bridgeCommand(bridge)]);
    if (started.code !== 0) throw new Error(`hc run ${bridge.name} failed: ${started.err || started.out}`);
    results.push(`${bridge.name}: started`);
  }
  return results;
}

export async function stopCore(runner: Runner): Promise<void> {
  const stopped = await runner(["hc", "server", "stop"]);
  if (stopped.code !== 0) throw new Error(`hc server stop failed: ${stopped.err || stopped.out}`);
}

// The account's Dori config, where attach.sh reads it: DORI_CONFIG, else ~/.<user>/config.json (an instance account), else
// ~/.dori/config.json. hc is in use when the config chooses it or its lead is an hc terminal; an unreadable config is read
// as in use, so a stop never ends an hc lead it could not rule out.
export function doriOnHc(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const own = join(homedir(), `.${userInfo().username}`, "config.json");
  const path = env["DORI_CONFIG"] || (existsSync(own) ? own : join(homedir(), ".dori", "config.json"));
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as { runtime?: "herdr" | "hc"; leadPane?: unknown };
    return String(config.leadPane ?? "").startsWith("hc:") || runtimeChoice({ runtime: config.runtime }, env).kind === "hc";
  } catch {
    return true;
  }
}

// ends each listed bridge that still runs and removes its row; every other terminal of the core is left alone
export async function stopBridges(runner: Runner, bridges: readonly Bridge[]): Promise<void> {
  const ls = await runner(["hc", "ls", "--all", "--json"]);
  if (ls.code !== 0) throw new Error(`hc ls failed: ${ls.err || ls.out}`);
  const terminals = (JSON.parse(ls.out) as { terminals?: Terminal[] }).terminals ?? [];
  for (const bridge of bridges) {
    const found = terminals.find((t) => t.name === bridge.name);
    if (!found) continue;
    for (const step of found.state === "live" ? ["kill", "rm"] : ["rm"]) {
      const r = await runner(["hc", step, bridge.name]);
      if (r.code !== 0) throw new Error(`hc ${step} ${bridge.name} failed: ${r.err || r.out}`);
    }
  }
}

if (import.meta.main) {
  const bridges = () => parseBridges(process.env["DORITERM_BRIDGES"] || process.env["DORITERM_BRIDGE_NAME"] || "zzangdori");
  if (process.argv[2] === "stop") {
    if (doriOnHc()) await stopBridges(run, bridges());
    else await stopCore(run);
    console.log("bridges: stopped");
  } else {
    for (const line of await ensureBridges(run, bridges())) console.log(line);
  }
}
