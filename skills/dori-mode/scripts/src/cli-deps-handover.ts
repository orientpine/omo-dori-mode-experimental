import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { currentTmuxSession } from "./aoe.ts";
import { jobSignal } from "./job-control.ts";
import { winSignal } from "./win-suspend.ts";
import { accountHome, type HandoverDeps } from "./handover.ts";
import type { LaneHandoverDeps } from "./lane-handover.ts";
import { quietReason } from "./rollover.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { restartService } from "./update-ready.ts";
import { configPath, envFilePath, loadConfig } from "./config.ts";
import { pidAlive } from "./heavy-slot.ts";
import { realClock, run, runtimeChoice } from "./run.ts";
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

export const makeSignal = () => {
  // a shell's foreground job is stopped with its shell and resumed before it, so the tty stays with it (job-control.ts)
  const sendSignal: HandoverDeps["signal"] = jobSignal((pid, sig) => {
    if (process.platform === "win32" && (sig === "SIGSTOP" || sig === "SIGCONT")) return winSignal(pid, sig);
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  });
  return sendSignal;
};

// What a handover run outside the session (systemd-run) keeps of this one's environment: the runtime it opens on included
// (DORI_RUNTIME, DORI_HERDR_SESSION; review 4 of #404) and hc's named core (HC_SESSION; review 6), so the replacement opens
// where this Dori's sessions are; never this terminal's own HC_TERMINAL_ID
export const HANDOVER_ENV = ["PATH", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_LEAD_PANE", "DORI_DISCORD_INBOX", "DORI_DISCORD_STATE_DIR", "DORI_RUNTIME", "DORI_HERDR_SESSION", "HC_SESSION"] as const;

export const makeHandoverDeps = (cli: Pick<Cli, "discordToken" | "config" | "deps" | "sendSignal">) => {
  const { discordToken, config, deps, sendSignal } = cli;
  const { discordClient, env, cardDir } = makeDiscordDeps(cli);
  const realpathOr = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  // the owner's after-the-fact line of a rollover the lead decided: in the given Discord thread, else DORI_DISCORD_CHANNEL
  const reportOwner = discordToken && process.env["DORI_DISCORD_CHANNEL"]?.trim()
    ? { reportOwner: async (thread: string | null, text: string): Promise<string> => discordClient().send(thread ?? env("DORI_DISCORD_CHANNEL"), text) }
    : {};
  const sessionOfPane = async (pane: string, cwd: string): Promise<string> => (await resolveSession(pane, cwd, await procTable(run), { run, sessionsDir: config.sessionsDir, backend: config.backend })).id;
  const freezeDeps = { run, procs: () => procTable(run), signal: sendSignal };
  const laneDepsFor = (print: (line: string) => void = (line) => console.log(line)): LaneHandoverDeps => ({
    ...deps,
    cardDir: cardDir(),
    home: accountHome(),
    sessionOf: sessionOfPane,
    procs: () => procTable(run),
    envOf: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
      } catch {
        return "";
      }
    },
    alive: pidAlive,
    signal: sendSignal,
    realpath: realpathOr,
    nonce: () => crypto.randomUUID().slice(0, 8),
    print,
    inbox: config.handover.inbox || process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
    ownerIds: [process.env["DORI_DISCORD_OWNER"], process.env["DORI_KAKAO_OWNER_ID"]].map((id) => id?.trim() ?? "").filter(Boolean),
    ...reportOwner,
  });
  const leadDepsFor = (print: (line: string) => void): HandoverDeps => ({
    ...deps,
    configPath: configPath(),
    envPath: envFilePath(),
    cardDir: cardDir(),
    inbox: config.handover.inbox || process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
    home: accountHome(),
    sessionOf: sessionOfPane,
    routedPane: async () => (await loadConfig()).leadPane,
    envLeadPane: process.env["DORI_LEAD_PANE"]?.trim() ?? "",
    alive: pidAlive,
    procs: () => procTable(run),
    signal: sendSignal,
    realpath: realpathOr,
    timers: async () => {
      const pattern = new RegExp(config.handover.timers);
      return (await run(["systemctl", "--user", "list-timers", "--all", "--no-legend", "--no-pager"])).out.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && pattern.test(l));
    },
    restart: (unit) => restartService({ systemctl: run, clock: realClock, timeoutSec: config.update.readyTimeoutSec }, config.update.services.find((s) => s.unit === unit) ?? { unit, paths: [], log: "", ready: "" }),
    nonce: () => crypto.randomUUID().slice(0, 8),
    print,
    ownerIds: [process.env["DORI_DISCORD_OWNER"], process.env["DORI_KAKAO_OWNER_ID"]].map((id) => id?.trim() ?? "").filter(Boolean),
    ...reportOwner,
  });
  // dori commands that talk to the owner refuse from a session that a running handover is replacing (no double replies)
  const quietGuard = async (): Promise<void> => {
    const here = await currentTmuxSession(run);
    const why = quietReason(config.stateDir, here, Date.now());
    if (why) die(why, 4);
  };
  const passEnv = (): string[] => {
    // a detached run must open where the caller resolved, even when DORI_RUNTIME itself was unset (upstream #177's
    // detection would otherwise choose hc on PATH again; review 1 of #430)
    const resolved = runtimeChoice(config, process.env).kind;
    const pass = ["HOME", ...HANDOVER_ENV.filter((n) => n !== "DORI_RUNTIME")].filter((n) => process.env[n] !== undefined).map((n) => `--setenv=${n}`);
    return [...pass, `--setenv=DORI_RUNTIME=${resolved}`];
  };
  return { realpathOr, reportOwner, sessionOfPane, sendSignal, freezeDeps, laneDepsFor, leadDepsFor, quietGuard, passEnv };
};
