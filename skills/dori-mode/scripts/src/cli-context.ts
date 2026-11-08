import { currentTmuxSession } from "./aoe.ts";
import type { BudgetLimits } from "./supervision.ts";
import { literalNewlineProblem } from "./messenger/literal-newline.ts";
import { areaSignals, hasSignals, oneLine, tagsOf } from "./lane-signals.ts";
import { statusOf } from "./registry.ts";
import { run } from "./run.ts";
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { HandoverDeps } from "./handover.ts";
import { USAGE } from "./cli-usage.ts";

export const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

export const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

type StringFlag = "title" | "brief" | "done" | "thread" | "model" | "cwd" | "pane" | "note" | "loop" | "to" | "text" | "edit" | "status" | "ping" | "session" | "tmux" | "from" | "first" | "lane" | "metric" | "hypothesis" | "date" | "no-hypotheses" | "goal" | "plan" | "kind" | "result" | "direction" | "next" | "mode" | "minutes" | "summary" | "wait-idle" | "request-at" | "request-pane" | "state" | "text-file" | "thinking" | "approved-by" | "window" | "answer" | "since" | "until" | "no-thread" | "why-new" | "remote" | "url" | "by" | "clock" | "rule" | "outcome" | "job" | "out" | "mem" | "want" | "caller" | "reply" | "channel" | "reply-to" | "posted" | "rollover-outcome" | "step" | "wall-minutes" | "token-limit" | "cost-limit" | "no-test" | "log" | "priority" | "ask" | "owner-link" | "hash" | "question" | "source";
type BooleanFlag = "write" | "no-typing" | "open" | "open-card" | "done-weak-ok" | "post" | "pull" | "push" | "dry-run" | "help" | "use-gpu" | "ui" | "improved" | "template" | "gpu-all" | "all" | "check" | "send" | "keep-old" | "no-monitors" | "force" | "reread" | "backtest" | "static" | "global" | "rl" | "again" | "post-summary" | "rollover-unresolved" | "stuck" | "delete-branch" | "install-task" | "read-only";
type MultipleFlag = "evidence" | "reason" | "option" | "tag" | "hypotheses" | "test" | "challenge-before" | "gpu" | "file" | "repo" | "dir" | "history-ok" | "lesson" | "in" | "sync" | "env" | "tools" | "back" | "remote-effect" | "activity-path" | "only" | "except";
type Flags = {
  readonly values: Partial<Record<StringFlag | BooleanFlag, string | boolean> & Record<MultipleFlag, (string | boolean)[]>> & Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: string[];
};

// `dori <command> --help`: that command's lines of USAGE
export const helpFor = (cmd: string): string => {
  const lines = USAGE.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^  ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(l));
  if (!cmd || at < 0) return USAGE;
  const out = [lines[at] ?? ""];
  for (const l of lines.slice(at + 1)) {
    if (/^  \S/.test(l)) break;
    out.push(l);
  }
  return `dori ${out.join("\n").trim()}`;
};

export const makeCli = (command: string, rest: string[], flags: Flags, config: DoriConfig, deps: FlowDeps, waive: Record<string, string>, discordToken: string | undefined, cliPath: string, cliUrl: string, sendSignal: HandoverDeps["signal"]) => {
  const opt = (name: string): string | undefined => {
    const v = flags.values[name];
    return typeof v === "string" ? v.trim() : undefined;
  };
  const need = (name: string): string => opt(name) || die(`--${name} is required`);
  // Every text dori posts for a person: a literal \n with no real line break is refused (messenger/literal-newline.ts).
  const postable = (text: string, what: string): string => {
    const problem = literalNewlineProblem(text);
    return problem ? die(`SEND_LITERAL_NEWLINE ${what}: ${problem}`, 2) : text;
  };
  // --text-file FILE (read as it is, trimmed) or the inline text
  const textOrFile = async (inline: string | undefined, usage: string): Promise<string> => {
    const file = opt("text-file");
    if (file && inline) die(`${usage}: give --text-file or the text, not both`);
    return file ? (await Bun.file(file).text()).trim() || die(`${usage}: ${file} is empty`) : inline || die(usage);
  };
  // a bare --thread (no value) is a thread ref that came out empty, not a lane without a thread
  const threadOpt = (): string | undefined => (flags.values.thread === true ? "" : opt("thread"));
  // a bare --no-thread is a reason that came out empty, refused like --no-thread ""
  const noThreadOpt = (): string | undefined => (flags.values["no-thread"] === true ? "" : opt("no-thread"));
  const whyNewOpt = (): string | undefined => (flags.values["why-new"] === true ? "" : opt("why-new"));
  const key = flags.positionals[0];
  // One option table serves every command (strict: false), so a command that posts checks its own: an option it does not
  // take, or a stray word, is refused before anything is sent instead of dropped (2026-10-20: --reply was dropped and the
  // lead's post went out as no reply).
  const onlyOptions = (what: string, allowed: readonly string[], positionals: number): void => {
    const extra = Object.keys(flags.values).filter((k) => !allowed.includes(k));
    if (extra.length) die(`UNKNOWN_OPTION ${what}: ${extra.map((k) => `--${k}`).join(", ")} is not an option of ${what}; nothing was sent`, 2);
    if (flags.positionals.length > positionals) die(`UNKNOWN_OPTION ${what}: unexpected ${JSON.stringify(flags.positionals.slice(positionals).join(" "))}; nothing was sent`, 2);
  };
  const tags = (): string[] => ((flags.values.tag as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
  const many = (name: string): string[] => ((flags.values[name] as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
  // every --evidence, trimmed, an empty one kept (close pairs them with --lesson by place); the other commands take the
  // last one, as they did when --evidence was a single option
  const evidences = (): string[] => ((flags.values.evidence as string[] | undefined) ?? []).map((t) => t.trim());
  const evidence = (): string => evidences().at(-1) || die("--evidence is required");
  // --wall-minutes N|none, --token-limit N|none, --cost-limit N|none: a number >= 0 is a cap, none turns it off, an absent
  // flag leaves the cap below it; a bad value is refused, so a typo cannot turn a cap off
  const budgetOpts = (): BudgetLimits => {
    const out: Record<string, number | null> = {};
    for (const [flag, name] of [["wall-minutes", "wallMinutes"], ["token-limit", "tokens"], ["cost-limit", "costUsd"]] as const) {
      const v = flags.values[flag];
      if (v === undefined) continue;
      const text = typeof v === "string" ? v.trim() : "";
      if (text === "none") out[name] = null;
      else if (text !== "" && Number.isFinite(Number(text)) && Number(text) >= 0) out[name] = Number(text);
      else die(`--${flag} takes a number >= 0 or none, not ${JSON.stringify(v)}`, 2);
    }
    return out;
  };
  // upstream dori-superagent #131 (https://github.com/sisyphuslabs/dori-superagent/pull/131): Bun.sleep(NaN) returns at
  // once, so a --loop such as "5m" would run a watch's ticks back to back; a bare or empty --loop would read as 0, so only a
  // missing flag means one pass. #130/#134 (https://github.com/sisyphuslabs/dori-superagent/pull/134) found Bun.sleep under
  // 1 ms returns at once too, so a positive --loop under 1 ms is refused as well. Called before a watch prints its ready line.
  const loopMinutes = (): number => {
    if (flags.values.loop === undefined) return 0;
    const value = opt("loop");
    const minutes = Number(value);
    return value && Number.isFinite(minutes) && (minutes === 0 || minutes * 60_000 >= 1) ? minutes : die("--loop must be a number of minutes: 0 for one pass, or 1 ms (0.0000167) or more");
  };
  const lane = async (k: string | undefined) => {
    const here = await currentTmuxSession(run);
    const found = k ? await deps.registry.read(k) : await deps.registry.byPane(here);
    if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
    if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
    return found;
  };
  // --posted: a message id or its Discord link
  const postedId = (): string | undefined => {
    const raw = opt("posted")?.trim();
    if (raw === undefined) return undefined;
    return /(?:^|\/)(\d{5,25})\/?$/.exec(raw)?.[1] ?? die(`--posted takes the id or link of the message that holds the result, not ${JSON.stringify(raw)}`);
  };
  // one SIGNALS line per open lane that has a record, for the lead's status view (dori sync, dori signals)
  const openSignals = async (): Promise<string[]> => {
    const open = await deps.registry.open();
    return (await areaSignals(open, { tags: [...new Set(open.flatMap((l) => tagsOf(l)))] }, config)).filter(hasSignals).map(oneLine);
  };
  return { command, rest, flags, config, deps, waive, discordToken, cliPath, cliUrl, sendSignal, opt, need, postable, textOrFile, threadOpt, noThreadOpt, whyNewOpt, key, onlyOptions, tags, many, evidences, evidence, helpFor, budgetOpts, loopMinutes, lane, postedId, openSignals };
};

export type Cli = ReturnType<typeof makeCli>;
export type Command = (cli: Cli) => Promise<void>;
