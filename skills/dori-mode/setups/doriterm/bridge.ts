// doriterm (doriface-host) shows herdr-core (hc) terminals only, not herdr 0.9.5 panes. The bridge is one hc terminal
// running a plain herdr client attached to this account's herdr server, so the Dori appears in the doriterm sidebar.
// hc --keep would bring back a shell rather than herdr after a core restart, so this re-creates the terminal instead.
// It never types into herdr and never focuses a pane: attaching is all it does.
import { run, type Runner } from "../../scripts/src/run.ts";

type Terminal = { readonly name?: string; readonly state?: string };

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

if (import.meta.main) {
  const name = process.env.DORITERM_BRIDGE_NAME || "zzangdori";
  console.log(`${name}: ${await ensureBridge(run, name, ["herdr"])}`);
}
