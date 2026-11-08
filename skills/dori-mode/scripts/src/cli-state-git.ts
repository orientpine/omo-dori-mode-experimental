import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { paneActivity } from "./aoe.ts";
import { accountHome } from "./handover.ts";
import { configPath, envFilePath } from "./config.ts";
import { checkRepo, commitDir, initRepo, logDir, restoreDir, type StateGitDeps, stateGitDirs } from "./state-git.ts";
import { approve, backupTick, type BackupDeps, envFilesIn, guardDir, loadSecrets, msToNextSlot, previewDir, pushAll, pushCheck } from "./state-backup.ts";
import { backupRemoteUrl, backupVisibility } from "./backup-visibility.ts";
import { pidAlive } from "./heavy-slot.ts";
import { run } from "./run.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";

const stateGitCommand: Command = async (context) => {
  const { config, many, key, opt, deps, flags, need } = context;
  const sg = config.stateGit;
  const sgDeps: StateGitDeps = { settings: sg, timeZone: sg.timeZone || config.scorecard.timeZone, now: () => Date.now(), print: (line) => console.log(line) };
  const inbox = process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
  const picked = many("dir").map((d) => resolve(d));
  const dirs = picked.length ? picked : stateGitDirs({ configFile: configPath(), stateDir: config.stateDir, inbox, home: process.env["HOME"] ?? "", dirs: sg.dirs }).filter((d) => existsSync(d));
  const sub = key ?? "log";
  const show = (lines: readonly string[]): void => {
    for (const line of lines) console.log(line);
  };
  const bk = sg.backup;
  // the repos the backup pushes: the state-git ones and the Dori's docs repos (stateGit.backup.dirs)
  const backupDirs = [...new Set([...dirs, ...bk.dirs.filter((d) => existsSync(join(d, ".git")))])];
  const clockAt = opt("clock") ? Date.parse(opt("clock") ?? "") : undefined;
  if (clockAt !== undefined && !Number.isFinite(clockAt)) die(`--clock takes an ISO time with its offset, e.g. 2026-10-18T06:00+09:00`);
  const backupDeps = (): BackupDeps => ({
    ...sgDeps,
    now: clockAt === undefined ? () => Date.now() : () => clockAt,
    backup: bk,
    stateDir: config.stateDir,
    home: accountHome(),
    visibility: (repo) => backupVisibility(repo, { run, fetch }),
    remoteUrl: backupRemoteUrl,
    secrets: async () => {
      const gh = await run(["gh", "auth", "token"]);
      const ghToken = gh.code === 0 && gh.out.trim() ? [{ value: gh.out.trim(), from: "gh auth token" }] : [];
      const ownerIds = [process.env["DORI_DISCORD_OWNER"], process.env["DORI_KAKAO_OWNER_ID"]].map((v) => v?.trim() ?? "").filter(Boolean);
      const messageFiles = [...bk.messageFiles, inbox, process.env["DORI_KAKAO_INBOX"]?.trim() ?? ""].filter(Boolean);
      const secretFiles = bk.secretFiles.flatMap((f) => (existsSync(f) && statSync(f).isDirectory() ? envFilesIn(f) : [f]));
      return loadSecrets([...secretFiles, envFilePath(), ...backupDirs.flatMap(envFilesIn)], messageFiles, ownerIds, bk.ownerMinChars, ghToken);
    },
    busy: async () => {
      const why: string[] = [];
      const lanes = (await deps.registry.open()).filter((l) => l.pane);
      const panes = [...new Set([config.leadPane, ...lanes.map((l) => l.pane ?? "")].filter(Boolean))];
      try {
        for (const [pane, a] of await paneActivity(run, panes)) if (a === "busy") why.push(`turn:${lanes.find((l) => l.pane === pane)?.key ?? (pane === config.leadPane ? "lead" : pane)}`);
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        why.push(`pane check failed (${e.message.slice(0, 80)})`);
      }
      const heavy = join(config.stateDir, "heavy");
      for (const slot of existsSync(heavy) ? readdirSync(heavy).filter((n) => n.startsWith("slot.")) : []) {
        const owner = existsSync(join(heavy, slot, "owner")) ? readFileSync(join(heavy, slot, "owner"), "utf8").split(" ") : [];
        if (pidAlive(Number(owner[0]), Date.parse(owner.at(-1) ?? "") || undefined)) why.push(`heavy:${owner[1] ?? slot}`);
      }
      for (const d of backupDirs) if (["index.lock", "dori-state.lock"].some((f) => existsSync(join(d, ".git", f)))) why.push(`git-lock:${d}`);
      return why;
    },
  });
  if (sub === "push-check") {
    // the pre-push hook: refuse unless the remote is this Dori's private backup and the pushed commits are clean
    const refused = await pushCheck(backupDeps(), resolve(many("repo")[0] ?? process.cwd()), opt("remote") ?? "", opt("url") ?? "", await new Response(Bun.stdin.stream()).text());
    for (const line of refused) console.error(`STATE_GIT_PUSH_REFUSED ${line}`);
    process.exit(refused.length ? 1 : 0);
  }
  if (sub === "backup") {
    const step = flags.positionals[1] ?? "preview";
    if (!bk.repo) die("BACKUP_OFF stateGit.backup.repo is empty in this Dori's config");
    const bd = backupDeps();
    if (step === "create") {
      let vis = await bd.visibility(bk.repo);
      if (vis === "missing") {
        const made = await run(["gh", "repo", "create", bk.repo, "--private", "--description", "Dori local backup (private; pushed by dori state-git)"]);
        if (made.code !== 0) die(`BACKUP_REPO_FAILED ${bk.repo}: ${(made.err || made.out).slice(0, 200)}`);
        vis = await bd.visibility(bk.repo);
      }
      if (vis !== "private") die(`BACKUP_REPO_NOT_PRIVATE ${bk.repo} is ${vis}: nothing will be pushed there`);
      console.log(`BACKUP_REPO_OK ${bk.repo} private`);
    } else if (step === "preview") {
      const secrets = await bd.secrets();
      console.log(`BACKUP_SECRETS ${secrets.values.length} secret values (never printed), ${secrets.ownerTexts.length} owner messages to look for`);
      for (const d of backupDirs) show(await previewDir(bd, d, secrets));
    } else if (step === "approve") {
      console.log(approve(bd, need("by"), many("history-ok")));
    } else if (step === "push") {
      for (const d of backupDirs) show(await guardDir(bd, d, dirs.includes(d)));
      show(await pushAll(bd, backupDirs));
    } else if (step === "tick") {
      show(await backupTick(bd, backupDirs));
    } else die(`state-git backup: unknown step ${step} (create, preview, approve, push, tick)`);
    return;
  }
  if (sub === "check") {
    const lines = await checkRepo(sgDeps, resolve(many("repo")[0] ?? process.cwd()));
    for (const line of lines) console.error(line);
    process.exit(lines.length ? 1 : 0);
  }
  if (sub === "loop") {
    // dori-lanes runs this beside the other sweeps; it must never exit (wait -n would restart them all)
    if (sg.everyMin <= 0) {
      console.log("STATE_GIT_OFF stateGit.everyMin is 0");
      for (;;) await Bun.sleep(3_600_000);
    }
    console.log(`STATE_GIT_READY ${dirs.join(" ")} every ${sg.everyMin} min${bk.repo ? `; backup to ${bk.repo} at ${bk.at} ${sgDeps.timeZone} when quiet (${backupDirs.join(" ")})` : ""}`);
    if (bk.repo) for (const d of backupDirs.filter((x) => !dirs.includes(x))) await guardDir(backupDeps(), d, false);
    for (;;) {
      for (const d of dirs) {
        try {
          show((await commitDir(sgDeps, d)).lines.filter((l) => !l.startsWith("STATE_GIT_NOCHANGE")));
        } catch (e) {
          console.log(`STATE_GIT_WARN ${d} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
      if (bk.repo) {
        try {
          show(await backupTick(backupDeps(), backupDirs));
        } catch (e) {
          console.log(`STATE_GIT_PUSH_WARN ${bk.repo} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
      // wake for the next backup try when it comes before the next commit tick
      await Bun.sleep(bk.repo ? Math.max(1000, Math.min(sg.everyMin * 60_000, msToNextSlot(Date.now(), sgDeps.timeZone, bk))) : sg.everyMin * 60_000);
    }
  }
  for (const d of dirs) {
    if (sub === "init") show(await initRepo(sgDeps, d));
    else if (sub === "commit") show((await commitDir(sgDeps, d, undefined, 30_000)).lines);
    else if (sub === "log") show(await logDir(sgDeps, d, Number(flags.positionals[1] ?? 15)));
    else if (sub === "restore") show(await restoreDir(sgDeps, d, flags.positionals[1] ?? die("state-git restore needs a time or a commit, e.g. \"yesterday 21:00\""), many("file")));
    else die(`state-git: unknown step ${sub} (init, commit, log, restore, loop, check)`);
  }
  if (!dirs.length) console.log("STATE_GIT_NO_DIRS none of this Dori's directories exists");
  return;
};

export const stateGitCommands: Readonly<Record<string, Command>> = {
  "state-git": stateGitCommand,
};
