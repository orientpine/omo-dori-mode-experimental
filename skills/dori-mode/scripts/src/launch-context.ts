import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import { areaLabel, type AreaQuery, areaSignals, pastSignalsSection, tagsOf } from "./lane-signals.ts";
import { laneArea, loadTree, treeSection } from "./explore.ts";
import { headingAt } from "./directives.ts";
import { Lessons } from "./lessons.ts";
import type { LaunchInput } from "./launch-types.ts";

// Earlier lanes in the same repo (a cwd other than the default one) or with a shared tag, for the new brief.
export const pastSignals = async (deps: FlowDeps, input: LaunchInput, cwd: string): Promise<string | undefined> => {
  const q: AreaQuery = { ...(cwd !== deps.config.defaultCwd ? { cwd } : {}), tags: tagsOf({ key: input.key, tags: input.tags }) };
  const list = await areaSignals(await deps.registry.list(), q, deps.config);
  return pastSignalsSection(areaLabel(q), list, deps.config.signals.launchLanes);
};

// The hypothesis trees of the new lane's area (its repo, else its first tag) and of its other tags, in compact form.
export const treeContext = async (deps: FlowDeps, draft: Lane): Promise<string | undefined> => {
  const main = laneArea(draft, deps.config);
  const areas = [main, ...tagsOf(draft).filter((t) => t !== main.tag).map((tag) => ({ tag }))];
  const trees = await Promise.all(areas.map((a) => loadTree(deps.config.stateDir, a)));
  return treeSection(trees, deps.config.explore.treeLines, `dori tree --lane ${draft.key}`);
};

// The lessons (src/lessons.ts, dori lesson add / close --lesson): up to 4 current global rules the lead set for every lane
// (dori lesson add --global, upstream https://github.com/sisyphuslabs/dori-superagent/pull/97), then up to 8 current rules
// earlier lanes in the same cwd learned, each newest first under its own heading. A rule the brief already says word for
// word (a directive of the ledger, the lead's own text) is left out, so the owner's words are not said twice. A damaged
// journal line is a LESSON_WARNING, never a stopped launch.
const GLOBAL_LESSONS_HEADING = "## Lessons for every lane (written by dori launch)";
const LESSONS_HEADING = "## Lessons for this repo (written by dori launch)";

// The lessons blocks an earlier launch wrote into this brief: each heading line and the lines under it up to a blank line or
// the next heading (a rule is one line, so a block has no blank line inside).
export const withoutLessons = (brief: string): string => {
  let text = brief;
  for (const heading of [GLOBAL_LESSONS_HEADING, LESSONS_HEADING]) {
    for (let at = headingAt(text, heading); at >= 0; at = headingAt(text, heading)) {
      const rest = text.slice(at);
      const end = rest.search(/\n(?:[ \t]*\n|## )/);
      text = text.slice(0, at) + (end < 0 ? "" : rest.slice(end + 1));
    }
  }
  return text;
};

export const repoLessons = (deps: Pick<FlowDeps, "config">, cwd: string, brief: string): { readonly section?: string; readonly warnings: string[] } => {
  const { lessons, problems } = new Lessons(deps.config.stateDir).forRepo(cwd);
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  const said = flat(brief);
  const fresh = lessons.filter((l) => !said.includes(flat(l.rule)));
  const warnings = problems.map((p) => `LESSON_WARNING ${p}`);
  const block = (heading: string, note: string, list: typeof fresh): string[] =>
    list.length ? [[heading, note, ...list.map((l) => `- [${l.outcome}; ${l.lane}; ${l.id}] ${l.rule}`)].join("\n")] : [];
  const blocks = [
    ...block(GLOBAL_LESSONS_HEADING, "Rules the lead set for every lane, whatever its repo, newest first. They are the lead's lessons, not the owner's directives. Follow them; when one helped or got in the way, say so in a report (only the lead marks a global lesson: dori lesson mark <id> --outcome helped|no-effect|harmful|encoded).", fresh.filter((l) => l.scope === "global")),
    ...block(LESSONS_HEADING, "Rules earlier lanes in this repo learned, newest first. They are lane lessons, not the owner's directives. Follow them; when one helped or got in the way, say so in a report (the lead marks it: dori lesson mark <id> --outcome helped|no-effect|harmful|encoded).", fresh.filter((l) => l.scope !== "global")),
  ];
  return blocks.length ? { warnings, section: blocks.join("\n\n") } : { warnings };
};
