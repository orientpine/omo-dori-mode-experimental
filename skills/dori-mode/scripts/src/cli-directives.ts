import { hintDirectives } from "./directive-hints.ts";
import { directiveLine, ledgerProblems, ledgerTable, loadLedger, promptTable } from "./directives.ts";
import { applyDirectives, auditOrReport, checkMeaning, linkRows, pushLinks, sinceIso } from "./directive-audit.ts";
import { threads } from "./messenger/thread-map.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

const directivesCommand: Command = async (context) => {
  const { key, flags, config, deps, lane } = context;
  const { hintLedger } = makeDirectiveDeps(context);
  // the owner's message links of fork entries in this Dori's local ledger, and with --push to directives.linkPeers
  if (key === "links") {
    if (!flags.values.push) {
      console.log(JSON.stringify(linkRows(config), null, 2));
      return;
    }
    const r = await pushLinks(deps);
    for (const line of r.lines) console.log(line);
    if (!r.ok) process.exit(1);
    return;
  }
  const ledger = loadLedger(config);
  if ((key ?? "table") === "check") {
    const problems = ledgerProblems(ledger);
    for (const p of problems) console.log(`DIRECTIVES_BAD ${p}`);
    if (problems.length) process.exit(1);
    if (!flags.values.static) {
      const meaning = await checkMeaning(deps, ledger);
      for (const line of meaning.lines) console.log(line);
      if (!meaning.ok) process.exit(1);
    }
    console.log(`DIRECTIVES_OK ${ledger.entries.length} directives (${ledger.entries.filter((e) => e.layer === "common").length} fork, ${ledger.entries.filter((e) => e.layer === "local").length} local) in ${ledger.files.join(", ") || "no ledger"}`);
    return;
  }
  if (key === "apply") {
    const r = await applyDirectives(deps, await lane(flags.positionals[1] ?? die("usage: dori directives apply <key> [--dry-run]")), { dryRun: Boolean(flags.values["dry-run"]) });
    for (const line of r.lines) console.log(line);
    if (flags.values["dry-run"] && r.message) console.log(r.message);
    if (!r.ok) process.exit(1);
    return;
  }
  if (key === "prompts") {
    console.log(promptTable(ledger));
    return;
  }
  // what an owner message carries in the inbox row (the listener's hints), for a text the lead gives
  if (key === "hint") {
    const text = flags.positionals.slice(1).join(" ").trim() || die("usage: dori directives hint <text>");
    const hl = hintLedger();
    const found = hintDirectives(text, hl);
    for (const line of hl.skipped ?? []) console.log(line);
    for (const { e, why } of found) console.log(`DIRECTIVE_HINT ${e.id} (${why}): ${directiveLine(e)}`);
    if (!found.length) console.log("DIRECTIVE_HINT_NONE: no directive's keyword, kind of work or UI words in the text");
    return;
  }
  if (key !== undefined && key !== "table") die("usage: dori directives [table|prompts|check [--static]|apply <key> [--dry-run]|hint <text>|links [--push]]");
  console.log(ledgerTable(ledger));
  return;
};

const directiveAuditCommand: Command = async (context) => {
  const { opt, deps, flags } = context;
  const { auditInbox, leadMemoryRepo } = makeDirectiveDeps(context);
  const { cardDir } = makeDiscordDeps(context);
  const since = sinceIso(opt("since") ?? "24h", Date.now());
  const r = await auditOrReport(deps, { since, inbox: auditInbox(), owner: process.env["DORI_DISCORD_OWNER"]?.trim() ?? "", threads: threads(cardDir()), memory: leadMemoryRepo(), dryRun: Boolean(flags.values["dry-run"]) });
  for (const line of r.lines) console.log(line);
  if (r.failed) process.exit(1);
  return;
};

export const directivesCommands: Readonly<Record<string, Command>> = {
  "directives": directivesCommand,
  "directive-audit": directiveAuditCommand,
};
