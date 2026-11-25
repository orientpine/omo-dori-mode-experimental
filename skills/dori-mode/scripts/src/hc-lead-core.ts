import { homedir } from "node:os";
import { join } from "node:path";
import { envFileEntries, envFilePath, configPath, expandHome, loadEnvFile } from "./config-env.ts";
import { defaultConfig } from "./config-defaults.ts";
import { Registry, statusOf } from "./registry.ts";
import { hcCoreRunning, run } from "./run.ts";
import { HC_ADDRESS } from "./runtime/types.ts";

export const hcCore = (text: string): string => envFileEntries(text).get("HC_SESSION") ?? "";

export const hcCoreSocket = (core: string, env: Readonly<Record<string, string | undefined>> = process.env): string =>
  join(env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid?.() ?? 0}`, "herdr-core", `${core || "default"}.sock`);

if (import.meta.main) {
  const file = Bun.file(envFilePath());
  const core = hcCore((await file.exists()) ? await file.text() : "");
  let lead = "";
  await loadEnvFile(envFilePath());
  lead = process.env["DORI_LEAD_TMUX"]?.trim() || process.env["DORI_LEAD_PANE"]?.trim() || "";
  if (!lead) {
    try {
      const config = (await Bun.file(configPath()).json()) as { leadPane?: unknown };
      lead = typeof config.leadPane === "string" ? config.leadPane : "";
    } catch {
      lead = "";
    }
  }
  const mode = process.argv[2];
  const target = mode === "terminal" ? process.argv[3] : undefined;
  if (mode === "terminal" && (!target || !HC_ADDRESS.test(target))) throw new Error("dori: invalid hc terminal");
  const socket = hcCoreSocket(core);
  const hcRun = (args: readonly string[]) => run(["hc", ...args], { env: { HC_SESSION: core || undefined, HC_SOCKET: undefined } });
  if (mode === "lanes") {
    // every open hc lane counts, whatever runtime the lead is on: a lane opened on hc while the lead is still on herdr
    // (a Dori moving over) is no herdr tab (review 1 of #456)
    if (!(await hcCoreRunning(core || undefined))) {
      console.log("[]");
    } else {
      // no config.json is an empty config, as loadConfig reads it; a malformed one still fails
      const configFile = Bun.file(configPath());
      const config: unknown = (await configFile.exists()) ? await configFile.json() : {};
      const state = process.env["DORI_STATE_DIR"] ?? (config && typeof config === "object" && "stateDir" in config && typeof config.stateDir === "string" ? config.stateDir : defaultConfig(homedir()).stateDir);
      const scanned = await new Registry(expandHome(state)).scan();
      if (scanned.unreadable.length) throw new Error(`dori: unreadable lanes: ${scanned.unreadable.join(", ")}`);
      const ls = await hcRun(["ls", "--json"]);
      if (ls.code) throw new Error(`dori: hc ls failed: ${ls.err}`);
      const raw: unknown = JSON.parse(ls.out);
      if (!raw || typeof raw !== "object" || !("terminals" in raw) || !Array.isArray(raw.terminals)) throw new Error("dori: invalid hc terminal list");
      const live = new Set(raw.terminals.flatMap((t: unknown) => t && typeof t === "object" && "address" in t && typeof t.address === "string" && "state" in t && t.state === "live" ? [t.address] : []));
      const lanes = scanned.lanes.flatMap((lane) => {
        const terminal = lane.pane?.startsWith("hc:") ? lane.pane.slice(3) : "";
        return statusOf(lane) !== "closed" && HC_ADDRESS.test(terminal) && live.has(terminal) ? [{ key: lane.key, terminal, core: core || "default" }] : [];
      });
      console.log(JSON.stringify(lanes));
    }
  } else if (!target && !lead.startsWith("hc:")) {
    console.log(lead ? ` ${lead}` : "");
  } else {
    // A path left by a killed core is no core; lead and lane attachments use the same connection guard.
    if (!(await hcCoreRunning(core || undefined))) {
      console.error(`dori: no hc core ${core || "default"} at ${socket}; not starting one`);
      process.exit(1);
    }
    if (target) {
      const got = await hcRun(["get", "--json", target]);
      const terminal: unknown = got.code === 0 ? JSON.parse(got.out) : undefined;
      if (!terminal || typeof terminal !== "object" || !("state" in terminal) || terminal.state !== "live") {
        console.error(`dori: hc terminal ${target} is no longer live`);
        process.exit(1);
      }
    }
    console.log(`${core} ${target ? `hc:${target}` : lead}`);
  }
}
