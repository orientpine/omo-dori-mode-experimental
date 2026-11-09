import { existsSync } from "node:fs";
import { join } from "node:path";
import { envFileEntries, envFilePath, configPath, loadEnvFile } from "./config-env.ts";

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
  if (!lead.startsWith("hc:")) {
    console.log(lead ? ` ${lead}` : "");
  } else {
    const socket = hcCoreSocket(core);
    if (!existsSync(socket)) {
      console.error(`dori: no hc core ${core || "default"} at ${socket}; not starting one`);
      process.exit(1);
    }
    console.log(`${core} ${lead}`);
  }
}
