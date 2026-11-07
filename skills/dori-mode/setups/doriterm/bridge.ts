// doriterm (doriface-host) shows herdr-core (hc) terminals only, not herdr 0.9.5 panes. The bridge is one hc terminal
// running `herdr client`, which attaches to this account's running herdr server and, unlike plain `herdr`, never starts
// one (with no server it exits 1). hc --keep would bring back a shell rather than the client after a core restart, so
// this re-creates the terminal instead. It never types into herdr and never focuses a pane: attaching is all it does.
// hc runs its core as its own systemd user service, outside doriface-host.service, so `stop` stops the core, which ends
// the bridge (not a kept terminal) with it; with no core running it starts none. On this account hc exists only for
// the pilot.
import { run, type Runner } from "../../scripts/src/run.ts";

type Terminal = { readonly name?: string; readonly state?: string };

export const bridgeCommand = ["herdr", "client"] as const;

export async function ensureBridge(runner: Runner, name: string, command: readonly string[]): Promise<"kept" | "started"> {
  const ls = await runner(["hc", "ls", "--all", "--json"]);
  if (ls.code !== 0) throw new Error(`hc ls failed: ${ls.err || ls.out}`);
  const terminals = (JSON.parse(ls.out) as { terminals?: Terminal[] }).terminals ?? [];
  const found = terminals.find((t) => t.name === name);
  if (found?.state === "live") return "kept";
  if (found) {
    const rm = await runner(["hc", "rm", name]);
    if (rm.code !== 0) throw new Error(`hc rm ${name} failed: ${rm.err || rm.out}`);
  }
  const started = await runner(["hc", "run", "--bg", "--no-parent", "--name", name, "--", ...command]);
  if (started.code !== 0) throw new Error(`hc run ${name} failed: ${started.err || started.out}`);
  return "started";
}

export async function stopCore(runner: Runner): Promise<void> {
  const stopped = await runner(["hc", "server", "stop"]);
  if (stopped.code !== 0) throw new Error(`hc server stop failed: ${stopped.err || stopped.out}`);
}

if (import.meta.main) {
  const name = process.env.DORITERM_BRIDGE_NAME || "zzangdori";
  if (process.argv[2] === "stop") {
    await stopCore(run);
    console.log(`${name}: stopped`);
  } else {
    console.log(`${name}: ${await ensureBridge(run, name, bridgeCommand)}`);
  }
}
