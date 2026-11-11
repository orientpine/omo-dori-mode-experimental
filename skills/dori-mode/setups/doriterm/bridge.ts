// doriterm (doriface-host) shows herdr-core (hc) terminals only, not herdr 0.9.5 panes. A bridge is one hc terminal
// running attach.sh, which keeps `herdr client` attached to a running herdr server; unlike plain `herdr` it never starts
// one. One row per Dori: DORITERM_BRIDGES lists them as name[:account] (the account's own herdr server through sudo; no
// account = this account's), default the one pilot row DORITERM_BRIDGE_NAME or zzangdori; hc lanes get their own rows.
// hc --keep would bring back a
// shell rather than the client after a core restart, so this re-creates a row that ended or was closed instead; the
// unit runs it when the host starts and the timer every minute. It never types into herdr and never focuses a pane:
// attaching is all it does. hc runs its core as its own systemd user service, outside doriface-host.service, and that core
// may also hold the account's own Dori (its lead and lanes, however the Dori chose hc), so `stop` ends and removes only
// the bridge rows it owns and leaves the core running; with no core running it asks hc nothing, so it starts none
// (reviews 4 and 5 of #404).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Ran, run, type Runner } from "../../scripts/src/run.ts";
import { HC_ADDRESS } from "../../scripts/src/runtime/types.ts";
import { LANE_KEY } from "../../scripts/src/registry.ts";

type Terminal = { readonly name?: string; readonly state?: string; readonly address?: string; readonly argv?: readonly unknown[] | undefined; readonly labels?: Readonly<Record<string, string>> | undefined };
type Local = Terminal & { readonly address: string };

// hc ls --all lists the mesh machines' terminals too, as <machine>/tN under their own unqualified names, and hc forwards a
// kill or rm of such an address to that machine; a bridge is a terminal of this machine, so only a row whose address is a
// local one (HC_ADDRESS) is ever looked at, and a row without an address is none (review 13 of #404)
async function localRows(runner: Runner): Promise<Local[]> {
  const ls = await runner(["hc", "ls", "--all", "--json"]);
  if (ls.code !== 0) throw new Error(`hc ls failed: ${ls.err || ls.out}`);
  const terminals = (JSON.parse(ls.out) as { terminals?: Terminal[] }).terminals ?? [];
  const rows: Local[] = [];
  for (const t of terminals) {
    if (!t.address || !HC_ADDRESS.test(t.address)) continue;
    // Neither labels nor argv are in ls on hc 0.1.18. Keep the listed name occupied even if get cannot read its owner.
    const got = await runner(["hc", "get", "--json", t.address]);
    let full: Terminal = {};
    if (got.code === 0) {
      try { full = JSON.parse(got.out) as Terminal; } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    }
    rows.push({ ...t, argv: full.argv, labels: full.labels, address: t.address });
  }
  return rows;
}

// A bridge runs attach.sh; a name is held by whatever terminal has it now (hc resolves a name to its live holder), so a
// Dori lane named like a bridge is never taken for one (review 10 of #404). hc 0.1.18's ls leaves argv and labels out, so each local row
// is read in full with hc get; only a record whose argv runs attach.sh is a bridge, and a record that cannot
// be read is another terminal's (review 11 of #404). A bridge is the terminal whose argv is exactly the bridge's own command
// (bridgeCommand: this checkout's attach.sh and that bridge's account): a file merely called attach.sh, another account's
// attach or an attach.sh of another checkout is another terminal's (dori challenge on plan-r13 of #404).
function owned(t: Local, bridge: Bridge): boolean {
  // Unlabeled clients already running at upgrade keep their original name and exact command as their ownership proof.
  const tagged = t.labels?.["dori.doriterm"];
  const row = tagged === undefined ? !bridge.lane && t.name === bridge.name : tagged === "bridge" && t.labels?.["dori.row"] === bridge.name && t.labels?.["dori.lane"] === bridge.lane?.key && t.labels?.["dori.core"] === bridge.lane?.core;
  const want = bridgeCommand(bridge);
  return row && Array.isArray(t.argv) && t.argv.length === want.length && want.every((a, i) => t.argv?.[i] === a);
}
export type Bridge = { readonly name: string; readonly account?: string; readonly lane?: HcLane };
// core: the hc core the lane's terminal is in; a Dori whose dori.env names another core can reuse the same tN there, and a
// row of the old core must not be kept for it (review 2 of #456)
type HcLane = { readonly key: string; readonly terminal: string; readonly core: string };
const CORE = /^[A-Za-z0-9_.-]{1,64}$/;

const nameOf = (bridge: Bridge): string => bridge.lane ? `${bridge.name}-${bridge.lane.key}`.replace(/[^a-z0-9_-]/g, "-").slice(0, 32) : bridge.name;

// Closed lanes are absent from discovery. Recover their former target only from labels plus the exact attach argv.
function laneOwner(t: Local, bridge: Bridge): Bridge | undefined {
  const key = t.labels?.["dori.lane"];
  const core = t.labels?.["dori.core"];
  const terminal = t.argv?.at(-1);
  if (!key || !LANE_KEY.test(key) || !core || typeof terminal !== "string" || !HC_ADDRESS.test(terminal)) return undefined;
  const candidate = { ...bridge, lane: { key, terminal, core } };
  return owned(t, candidate) ? candidate : undefined;
}

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
  return ["/bin/sh", join(import.meta.dir, "attach.sh"), ...(bridge.lane ? [bridge.account ?? "", bridge.lane.terminal] : bridge.account ? [bridge.account] : [])];
}

export async function ensureBridges(runner: Runner, bridges: readonly Bridge[]): Promise<string[]> {
  const desired: Bridge[] = [];
  for (const bridge of bridges) {
    // The host units keep NoNewPrivileges; sudo discovery runs in their independent, already-running hc core.
    const got = await runner(["hc", "exec", "--", ...bridgeCommand(bridge), ...(bridge.account ? [] : [""]), "--lanes"]);
    if (got.code !== 0) throw new Error(`lane discovery ${bridge.name} failed: ${got.err || got.out}`);
    // Parse the account-side protocol here; no config or credentials cross back to the host.
    const value: unknown = JSON.parse(got.out);
    if (!Array.isArray(value)) throw new Error("dori: expected an hc lane list");
    const lanes = value.map((lane: unknown): HcLane => {
      if (!lane || typeof lane !== "object" || !("key" in lane) || typeof lane.key !== "string" || !LANE_KEY.test(lane.key) ||
        !("terminal" in lane) || typeof lane.terminal !== "string" || !HC_ADDRESS.test(lane.terminal)) throw new Error("dori: invalid hc lane");
      const core = "core" in lane ? lane.core : "default";
      if (typeof core !== "string" || !CORE.test(core)) throw new Error("dori: invalid hc lane core");
      return { key: lane.key, terminal: lane.terminal, core };
    });
    desired.push(bridge, ...lanes.map((lane) => ({ ...bridge, lane })));
  }
  const terminals = await localRows(runner);
  const stale = terminals.filter((t) => bridges.some((b) => laneOwner(t, b)) && !desired.some((b) => owned(t, b)));
  await removeRows(runner, stale);
  const active = terminals.filter((t) => !stale.includes(t));
  const held = new Set(active.filter((t) => t.state === "live").map((t) => t.name));
  const reserved = new Set(desired.map(nameOf));
  // a lane row never takes a listed row's own name, even as its preferred one (rows aa and aa-bb, lane bb of aa)
  const listed = new Set(bridges.map((b) => b.name));
  const results: string[] = [];
  for (const bridge of desired) {
    // hc lists every record of a name, in terminal-id order: a finished record of another program may come before the live
    // bridge that took its name, so the live holder decides (review 12 of #404)
    const rows = active.filter((t) => owned(t, bridge));
    const live = rows.find((t) => t.state === "live");
    if (live) { results.push(`${bridge.name}: kept`); continue; }
    // a finished bridge's record is removed, a finished foreign one keeps its record; the name is free for the bridge anyway
    for (const t of rows) {
      const rm = await runner(["hc", "rm", t.address]);
      if (rm.code !== 0) throw new Error(`hc rm ${bridge.name} failed: ${rm.err || rm.out}`);
    }
    const preferred = nameOf(bridge);
    let name = preferred;
    // Keep the preferred name when free; otherwise suffix -row, then -row-2, etc., truncating only the prefix to 32.
    // Row labels find a fallback again without renaming it, and reserved names leave other configured rows their names.
    for (let n = 1; held.has(name) || (name !== preferred && reserved.has(name)) || (bridge.lane !== undefined && listed.has(name)); n++) {
      const suffix = n === 1 ? "-row" : `-row-${n}`;
      name = `${preferred.slice(0, 32 - suffix.length)}${suffix}`;
    }
    const started = await runner(["hc", "run", "--bg", "--no-parent", "--name", name, "--label", "dori.doriterm=bridge", "--label", `dori.row=${bridge.name}`, ...(bridge.lane ? ["--label", `dori.lane=${bridge.lane.key}`, "--label", `dori.core=${bridge.lane.core}`] : []), "--", ...bridgeCommand(bridge)]);
    if (started.code !== 0) throw new Error(`hc run ${bridge.name} failed: ${started.err || started.out}`);
    held.add(name);
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
  const terminals = await localRows(runner);
  await removeRows(runner, terminals.filter((t) => bridges.some((b) => owned(t, b) || laneOwner(t, b))), sleep);
}

async function removeRows(runner: Runner, terminals: readonly Local[], sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<void> {
  const failed: string[] = [];
  for (const found of terminals) {
    const target = found.address;
    if (found.state === "live") {
      const k = await runner(["hc", "kill", target]);
      if (k.code !== 0 && kindOf(k) !== "not_found") {
        failed.push(`hc kill ${found.name} failed: ${k.err || k.out}`);
        continue;
      }
    }
    for (let i = 1; ; i++) {
      const r = await runner(["hc", "rm", target]);
      if (r.code === 0 || kindOf(r) === "not_found") break;
      if (kindOf(r) !== "live" || i >= RM_TRIES) {
        failed.push(`hc rm ${found.name} failed: ${r.err || r.out}`);
        break;
      }
      await sleep(RM_WAIT_MS);
    }
  }
  if (failed.length) throw new Error(failed.join("; "));
}

// The bridges live in this host's own hc core (its HC_SESSION, else the default core), the one coreRunning checks and
// doriface-host connects to, never the core a Dori's dori.env names for that Dori's sessions (review 9 of #404).
export const bridgeRun: Runner = (argv, opts = {}) => run(argv, { ...opts, env: { HC_SESSION: process.env["HC_SESSION"], HC_SOCKET: undefined, ...opts.env } });

if (import.meta.main) {
  const bridges = () => parseBridges(process.env["DORITERM_BRIDGES"] || process.env["DORITERM_BRIDGE_NAME"] || "zzangdori");
  if (process.argv[2] === "stop") {
    if (coreRunning()) await stopBridges(bridgeRun, bridges());
    console.log("bridges: stopped");
  } else if (coreRunning()) {
    for (const line of await ensureBridges(bridgeRun, bridges())) console.log(line);
  }
}
