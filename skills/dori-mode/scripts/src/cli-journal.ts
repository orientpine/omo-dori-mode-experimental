import { currentTmuxSession } from "./aoe.ts";
import { isLessonOutcome, Lessons } from "./lessons.ts";
import { Worklog } from "./worklog.ts";
import { realClock, run } from "./run.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";

const lessonCommand: Command = async (context) => {
  const { config, deps, key, flags, opt, need, evidence } = context;
  const lessons = new Lessons(config.stateDir);
  // The open lane that owns this pane, found the way claim-done finds its lane (upstream dori-superagent#97). This is a
  // convenience check: it stops a lane from adding or reviving a global lesson by accident or on routine instruction.
  // It is not a security boundary: it reads only $HC_TERMINAL_ID, $HERDR_PANE_ID or $TMUX (env -u gets past it), and a direct write to
  // lessons.jsonl skips the CLI.
  const paneLane = async () => {
    const here = await currentTmuxSession(run).catch(() => "");
    return here ? await deps.registry.byPane(here) : null;
  };
  switch (key) {
    case "add": {
      if (flags.values.global) {
        // A global lesson reaches every future brief, so it is the lead's: no lane key, no cwd, recorded as the lead's.
        if (flags.positionals[1] !== undefined) die("a --global lesson is the lead's: give no lane key");
        if (opt("cwd") !== undefined) die("a --global lesson has no --cwd");
        const caller = await paneLane();
        if (caller) die(`a --global lesson is the lead's; this pane is lane ${caller.key}`);
        console.log(JSON.stringify(lessons.add({ lane: "lead", scope: "global", rule: need("rule"), evidence: evidence() }, realClock.now())));
        break;
      }
      const laneKey = flags.positionals[1] ?? die("usage: dori lesson add <key> --rule TEXT --evidence PATH [--cwd DIR], or dori lesson add --global --rule TEXT --evidence REF");
      // a closed lane may still add what it learned, so the registry is read directly, not through lane()
      const target = (await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`);
      console.log(JSON.stringify(lessons.add({ lane: laneKey, cwd: opt("cwd") ?? target.cwd ?? config.defaultCwd, rule: need("rule"), evidence: evidence() }, realClock.now())));
      break;
    }
    case "list": {
      const read = lessons.read(opt("cwd"));
      for (const problem of read.problems) console.error(`LESSON_WARNING ${problem}`);
      console.log(JSON.stringify(read.lessons, null, 2));
      break;
    }
    case "mark": {
      const id = flags.positionals[1] ?? die("usage: dori lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded");
      // Marking a global lesson helped or pending puts it back into every brief, so a lane cannot mark one; repo lessons
      // stay markable from lanes.
      if (lessons.read().lessons.find((lesson) => lesson.id === id)?.scope === "global") {
        const caller = await paneLane();
        if (caller) die(`a global lesson is the lead's to mark; this pane is lane ${caller.key}`);
      }
      const outcome = need("outcome");
      if (isLessonOutcome(outcome)) console.log(JSON.stringify(lessons.mark(id, outcome)));
      else die("--outcome must be pending, helped, no-effect, harmful or encoded");
      break;
    }
    default:
      die("usage: dori lesson add|list|mark");
  }
  return;
};

const worklogCommand: Command = async (context) => {
  const { config, flags, key, need } = context;
  const worklog = new Worklog(config.stateDir);
  const id = () => flags.positionals[1] ?? die(`worklog ${key} needs an item id`);
  const text = () => flags.positionals.slice(2).join(" ").trim() || die(`worklog ${key} needs text`);
  const now = realClock.now();
  switch (key) {
    case "add":
      console.log(JSON.stringify(worklog.add(flags.positionals.slice(1).join(" ").trim() || die("worklog add needs a title"), need("source"), now)));
      break;
    case "next":
      console.log(JSON.stringify(worklog.next(id(), text(), now)));
      break;
    case "note":
      console.log(JSON.stringify(worklog.note(id(), text(), now)));
      break;
    case "close":
      console.log(JSON.stringify(worklog.close(id(), need("result"), now)));
      break;
    case "list": {
      const read = worklog.read();
      for (const problem of [...read.problems, ...read.warnings]) console.error(`WORKLOG_WARNING ${problem}`);
      console.log(JSON.stringify(flags.values.open ? read.items.filter((item) => item.closedAt === undefined) : read.items, null, 2));
      break;
    }
    default:
      die("worklog needs add, next, note, close or list");
  }
  return;
};

export const journalCommands: Readonly<Record<string, Command>> = {
  "lesson": lessonCommand,
  "worklog": worklogCommand,
};
