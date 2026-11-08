import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkedLedger, DirectiveError, type Ledger } from "./directives.ts";
import { memoryRepoFor } from "./directive-audit.ts";
import type { Cli } from "./cli-context.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

export const makeDirectiveDeps = (cli: Pick<Cli, "config" | "discordToken" | "deps">) => {
  const { config, discordToken } = cli;
  const { ownDiscord } = makeDiscordDeps(cli);
  // The ledger an owner message and a lead's thread are read against: both layers, a bad local line left out (as the audit
  // reads it). No ledger configured is not "no directives": it throws, like a ledger that cannot be read.
  const hintLedger = (opts: { readonly strict?: boolean } = {}): Ledger => {
    if (!config.directives.common && !config.directives.local) throw new DirectiveError("no directive ledger is configured (config directives.common and directives.local are empty)");
    return checkedLedger(config, { tolerant: !opts.strict });
  };
  // The omo memory repo of this Dori's lead that dori directive-audit reads for DIRECTIVE_DUPLICATE: directives.memory, else
  // the repo omo keeps for its cwd (handover.cwd, else defaultCwd) under this account's home.
  const leadMemoryRepo = (): string => config.directives.memory || memoryRepoFor(config.handover.cwd || config.defaultCwd, homedir());
  // the owner's message a thread starts from, as the inbox has it (text or voice transcript); empty when it is not there
  const inboxText = (id: string): string => {
    const file = process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
    if (!existsSync(file)) return "";
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(id)) continue;
      try {
        const row = JSON.parse(line) as { id?: string; content?: string; transcript?: string | null };
        if (row.id === id) return row.transcript || row.content || "";
      } catch {
        // a torn line is not the message
      }
    }
    return "";
  };
  // the inbox dori directive-audit reads the owner's messages from and leaves its notices for the lead in
  const auditInbox = (): string => config.handover.inbox || process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
  // why a Discord message link is not the owner's word (his account or his registered webhook), or undefined when it is
  const ownerLinkProblem = async (url: string, maxAgeMs?: number): Promise<string | undefined> => {
    const m = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)$/.exec(url.trim());
    if (!m) return `${url} is not a Discord message link`;
    if (!discordToken) return "DORI_DISCORD_TOKEN is not set, so the link cannot be read";
    const msg = await ownDiscord(discordToken).call<{ author?: { id?: string }; webhook_id?: string; timestamp?: string }>("GET", `/channels/${m[1]}/messages/${m[2]}`).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (typeof msg === "string") return `the message could not be read (${msg.slice(0, 120)})`;
    const owner = process.env["DORI_DISCORD_OWNER"]?.trim() ?? "";
    const hook = process.env["DORI_DISCORD_OWNER_WEBHOOK"]?.trim() ?? "";
    if (!(owner && msg.author?.id === owner) && !(hook && msg.webhook_id === hook)) return "the message is not the owner's";
    if (maxAgeMs !== undefined && Date.now() - Date.parse(msg.timestamp ?? "") > maxAgeMs) return `the owner's message is older than ${Math.round(maxAgeMs / 3_600_000)} hours`;
    return undefined;
  };
  return { hintLedger, leadMemoryRepo, inboxText, auditInbox, ownerLinkProblem };
};
