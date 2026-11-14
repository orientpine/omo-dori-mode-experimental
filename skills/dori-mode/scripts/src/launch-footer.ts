import { fileURLToPath } from "node:url";
import type { Backend } from "./config.ts";
import { agentLine } from "./herdr.ts";
import { hasThread, type Lane } from "./registry.ts";
import { type Ledger, uiHits, scopeText } from "./directives.ts";
import { join } from "node:path";
import { type LaunchInput, LaunchError } from "./launch-types.ts";

// The owner's seven UI steps: the block between the markers in references/ui-work.md, the one copy of their wording.
export const UI_WORK_DOC = join(import.meta.dir, "../../references/ui-work.md");
export const uiSteps = async (doc = UI_WORK_DOC): Promise<string> => {
  const m = /<!-- ui-steps:begin -->\n([\s\S]*?)\n<!-- ui-steps:end -->/.exec(await Bun.file(doc).text());
  if (!m?.[1]) throw new LaunchError(`no ui-steps block in ${doc}`);
  return m[1];
};

// The steps right after the first line when it is the ulw line, else at the very top; a brief that already has them is left alone.
export const withUiSteps = (brief: string, steps: string): string => {
  if (brief.includes(steps.split("\n")[0] ?? steps)) return brief;
  const lines = brief.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "")) return [...lines.slice(0, first + 1), "", steps, ...lines.slice(first + 1)].join("\n");
  return `${steps}\n\n${brief}`;
};

// The owner's eight steps (1. 조사 ... 8. 보고) of the brief template in references/sessions.md, the one copy of their wording.
export const SESSIONS_DOC = join(import.meta.dir, "../../references/sessions.md");
export const eightSteps = async (doc = SESSIONS_DOC): Promise<string> => {
  const template = /```text\n(ulw\n[\s\S]*?)```/.exec(await Bun.file(doc).text())?.[1] ?? "";
  const m = /^1\. 조사:[\s\S]*?^8\. 보고:[^\n]*$/m.exec(template);
  if (!m) throw new LaunchError(`no eight-step block (1. 조사: ... 8. 보고:) in the brief template of ${doc}`);
  return m[0];
};

const FIELD = /^\s*\[(?:목표|끝난 상태|사용자와 장면|넘으면 안 되는 선)\]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A brief with none of the eight step headings gets the whole block after the four fields (after the ulw line when it has
// no fields, else at the top); one with all eight is left alone; one with some of them is an edited frame: left as the
// lead wrote it, with a warning.
export const withEightSteps = (brief: string, steps: string): { readonly text: string; readonly added: boolean; readonly missing: readonly number[] } => {
  const heads = [...steps.matchAll(/^([1-8])\. ([^:\n]+):/gm)].map(([, n, name]) => ({ n: Number(n), re: new RegExp(`^\\s*${n}\\.\\s*${escapeRe(name ?? "")}\\s*:`, "m") }));
  const missing = heads.filter((h) => !h.re.test(brief)).map((h) => h.n);
  if (missing.length < heads.length) return { text: brief, added: false, missing };
  const lines = brief.split("\n");
  const lastField = lines.reduce((at, l, i) => (FIELD.test(l) ? i : at), -1);
  let at: number;
  if (lastField >= 0) {
    at = lastField + 1;
    while (at < lines.length && lines[at]?.trim()) at++;
  } else {
    const first = lines.findIndex((l) => l.trim());
    at = first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "") ? first + 1 : 0;
  }
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (after.length && !after[0]?.trim()) after.shift();
  const text = [...before, ...(before.length ? [""] : []), steps, ...(after.length ? ["", ...after] : [])].join("\n");
  return { text, added: true, missing };
};

export const stepsLine = (key: string, r: { readonly added: boolean; readonly missing: readonly number[] }): string | undefined =>
  r.added
    ? `LAUNCH_STEPS_ADDED ${key}: the brief had none of the owner's eight steps (1. 조사 ... 8. 보고, references/sessions.md); added them as written there, after the four fields.`
    : r.missing.length
      ? `LAUNCH_STEPS_PARTIAL ${key}: the brief has only some of the owner's eight steps (missing ${r.missing.join(", ")}); left as the lead wrote it, nothing added. Check that the edit was meant.`
      : undefined;

// The lead's brief reads like UI work (two UI words, one of them not 화면; quoted words and directive names do not count) and
// --ui is missing. added: the directive ledger put the UI steps in anyway (directive ui-steps); without a ledger they are not.
export const uiWarning = (input: LaunchInput, brief: string, ledger: Pick<Ledger, "entries"> = { entries: [] }, added = false): string | undefined => {
  if (input.ui) return undefined;
  const hits = uiHits(scopeText(brief, ledger));
  if (!hits.length) return undefined;
  const words = [...new Set(hits)].slice(0, 4).join(", ");
  return added
    ? `LAUNCH_UI_HINT ${input.key}: the brief reads like UI work (${words}) and has no --ui; the owner's seven UI steps (references/ui-work.md, directive ui-steps) were put in. Launch UI work with --ui; when it is not UI work, --waive ui-steps "<reason>".`
    : `LAUNCH_UI_HINT ${input.key}: the brief reads like UI work (${words}) but has no --ui, so the owner's seven UI steps (references/ui-work.md) are not in it. Launched as is; for UI work, launch with --ui.`;
};

export const cliCommand = (path: string = fileURLToPath(new URL("./cli.ts", import.meta.url)), instance?: { readonly config: string; readonly stateDir: string }, platform: string = process.platform): string => agentLine(["bun", path], instance ? { DORI_CONFIG: instance.config, DORI_STATE_DIR: instance.stateDir } : {}, platform);
const CLI = cliCommand();

export const footer = (lane: Lane, leadPane: string, backend: Backend = "herdr", gated: readonly string[] = [], instance?: { readonly config: string; readonly stateDir: string }): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Persist each milestone, blocker, question, halt and completion with ${instance ? cliCommand(undefined, instance) : CLI} report ${lane.key} --kind milestone|blocker|question|halted|done --text "what, with evidence links"; it appends reports.jsonl and prints the human [REPORT] line to send to the lead as below.`,
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <one plain line: what is done, and what the owner has to do if anything>; the evidence (ids, paths, hashes, numbers, links) goes on the lines below that first line, never in it, and a (fix: ...) tag stays on the first line. Type it into ${backend === "aoe" ? "tmux session" : "pane"} ${leadPane || "(lead pane)"} with dori type, as an argv array, never a shell string: run ["dori","type","${leadPane || "(lead pane)"}","--text","<report line>"]. It prints SUBMITTED once the lead took it; NOT_SUBMITTED <reason> (exit 1) means it did not arrive: send it once more. Keep backticks and $( out of the text (dori type refuses them).`,
  `- A report that is a fix attempt for a failing check or metric carries (fix: <metric> / <hypothesis>). The lead's stuck ladder counts failed attempts on one metric, tagged or not: from the 2nd, competing hypotheses before the next patch; at the 3rd, ulw research and a dori challenge of your next plan (sent to you, in this session); after that, or with one hypothesis tried 3 times, the lead may move you to a new session. A blocker, an impossible or an ambiguous task is a fine report (| blocker |), better than another retry.`,
  `- Stuck after a fix that did not move the metric: before the next patch, write at least 3 competing hypotheses with one cheap discriminating test each, run the tests, and record what they showed (dori tree add|falsify|support --lane ${lane.key}). The lead's dori fix-attempt refuses a second attempt on one metric without them.`,
  `- Big memory work (a large model, a long GPU run) goes through dori heavy <label> --mem <estimate, e.g. 70G> -- <command>, never inside this session's own process (an eval kernel, a shell of this session): there a job over its memory dies alone in its own scope, while inside the session it takes the whole lane down with it.`,
  `- Heavy browser, CPU or build test bundles go through dori heavy <label> --kind browser|cpu --sync <every folder or file the command reads or writes> -- <command>, not a hand-made core lock: the less busy PC runs it and its output, files and exit code come back here (the working folder outside --sync goes along, HEAVY_SHIP; HEAVY_LOCAL_REFUSED <why> means it did not run: add the path it names to --sync, or --local to run it here; HEAVY_LOCAL <why> means it stayed here). Training, simulation and GPU tests (an RL run, a replay test, a GPU check) go through dori heavy <label> --kind gpu --sync <paths> -- <command>: a training spark takes them first, never this PC by default.`,
  `- A child task (task tool) that ends its turn to wait on its own watch or detached cell, with no text, reaches you as a failure: "RPC child turn produced no assistant output" (omo counts a turn with no final text as failed). It is still working, and its watch wakes it. So put this line in every child prompt: "Before you end a turn to wait on a watch or a detached cell, write one line: WAITING: <what you wait for>." When that failure or a WAITING line comes in, read its status with task_output before you send anything. A running child needs no Continue and no new spawn, and its next answer arrives by itself (references/operating-lessons.md, 37).`,
  ...(lane.goal ? [`- Goal (owner words): "${lane.goal}". At each stage change (a new phase, a pivot, before a big step) run dori intent-check ${lane.key} --direction "<what you do now>" --next "<next step>" (a reviewer model reads it against the owner's words) and say in your report how the step serves this goal.`] : []),
  ...(lane.challengeBefore?.length ? [`- Before ${lane.challengeBefore.map((s) => `"${s}"`).join(" or ")}: write the plan to a file and run dori challenge ${lane.key} --plan <file> (a model of another family reviews it); answer its reasons in your next report. A done claim is refused until a challenge is on record.`] : []),
  `- After each finished step run dori checkpoint ${lane.key} --step <unique step> --result <result> --evidence <path or link> [--remote-effect <receipt of a push, merge or deploy it did>] (one flag per receipt). On resume run dori checkpoints ${lane.key} before any work and never repeat a recorded remote effect; after a crash between a remote action and its checkpoint, read the live remote state first.`,
  `- What you learn goes to one place: a standing instruction of the owner to the lead in a [REPORT] for the directive ledger, a lesson, fact or how the work went into your omo memory, and the report stays the record (references/done-protocol.md).`,
  ...(gated.length ? [`- A PR in ${gated.join(", ")} merges only through the review gate: in a clean checkout of the PR's head run dori review <repo>#<N> (it runs the tests there first, then a reviewer of another model family; VERDICT: CLEAR is needed; a PR with GitHub checks or auto-merge is refused as unsupported), then dori merge <repo>#<N>, which merges only that exact head (--match-head-commit). A commit pushed after the review needs dori review again; a PR merged with plain gh pr merge makes claim-done refuse (MERGE_GATE_MISSING).`] : []),
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>"${hasThread(lane) ? ` --summary "<2 to 5 plain lines for the owner, in his language: what changed, what is left, when it reaches where it is used; no paths, hashes or codes>" (your one result post: the close posts it in the work thread; if you already posted your result there yourself in the last 30 minutes, the close posts nothing more, so never post it twice; without --summary and a post the close has a model write one from your last report and REPORT.md)` : ""}. See references/done-protocol.md.`,
  "",
].join("\n");

// What a compaction must keep of the lane's task, said in the lane's first message. omo's summary prompt quotes the user's
// requests word for word and keeps them unchanged through later compactions (senpi's builtin compaction, prompts.js R1/R3
// and its task intent), while the brief is only a file the lane read: 2 of 5 lane compactions in the week to 2026-11-07
// kept the brief path and none its goal or Done line (owner Q530). One line, since the message is typed into a pane or
// passed as one argument; backticks and $( are changed so dori type takes it.
const ANCHOR_CAP = 1200;
const anchorPart = (s: string): string => {
  const flat = s.replace(/\s+/g, " ").trim().replace(/`/g, "'").replaceAll("$(", "$ (");
  return flat.length > ANCHOR_CAP ? `${flat.slice(0, ANCHOR_CAP)}... (cut here, the rest is in the brief)` : flat;
};
export const briefAnchor = (lane: Pick<Lane, "brief" | "done" | "goal">, briefText: string): string => {
  const target = briefText.split("\n").find((l) => /^\s*\[(목표|Goal)\]/.test(l));
  const parts = [...(target ? [anchorPart(target)] : []), `Done = ${anchorPart(lane.done)}`, ...(lane.goal ? [`Owner's words: "${anchorPart(lane.goal)}"`] : [])];
  return `Keep these word for word through every context compaction, and after a compaction re-read the brief at ${lane.brief} before your next step: ${parts.join(" | ")}`;
};


// The lane's brief with its footer's Done line set to the new one and a line under it saying what it was and why it
// changed (newest first). A brief without that line (adopted lanes) gets both at its end.
export const briefWithDone = (brief: string, done: string, change: { readonly at: string; readonly from: string; readonly reason: string }): string => {
  const doneLine = `- Done = ${done}. The lane closes only when every signal reads back live.`;
  const changed = `- Done changed ${change.at} (dori done-set): ${change.reason}. Earlier: Done = ${change.from}`;
  const lines = brief.split("\n");
  const i = lines.findIndex((l) => l.startsWith("- Done = "));
  if (i < 0) return `${brief.replace(/\n*$/, "")}\n\n## Done changed (written by dori done-set)\n${doneLine}\n${changed}\n`;
  return [...lines.slice(0, i), doneLine, changed, ...lines.slice(i + 1)].join("\n");
};
