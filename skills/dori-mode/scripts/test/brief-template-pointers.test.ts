import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Copied from omo-ai 5.1.33 plugin/extensions/omo.js (minified names in brackets):
// the ultrawork keyword [Ufe], the skill pointer patterns [gue, yue, vue] and the
// masking applied to a prompt before they are tested [uue = cue(due(...))].
const before = String.raw`(?<![A-Za-z0-9][-_.]|[/\\])`;
const notPath = String.raw`(?![-_.]?[A-Za-z0-9]*[/\\])`;
const wordEnd = String.raw`(?![-_.]?[A-Za-z0-9])`;
const after = String.raw`(?![-_](?!(?:loop|plan|research|execute|mass)${wordEnd})[A-Za-z0-9]|\.[A-Za-z0-9])`;
const pointer = (body: string) => new RegExp(String.raw`${before}\b${body}\b${after}${notPath}`, "i");
const detectors: Record<string, RegExp> = {
  ultrawork: new RegExp(String.raw`${before}\b(?:ultrawork|ulw)\b${after}${notPath}`, "i"),
  "mass-ulw": pointer(String.raw`(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)`),
  "ulw-loop": pointer(String.raw`ulw[\s-]*loop`),
  "ulw-plan": pointer(String.raw`ulw[\s-]*plan`),
};
const blank = (s: string) => s.replace(/[^\r\n]/g, "\0");
const mask = (text: string) => text
  .replace(/<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi, blank)
  .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
  .replace(/^ {0,3}>[^\n]*/gm, blank)
  .replace(/"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g, blank)
  .replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, blank)
  .replace(/\b(?:do\s+not|don['\u2019]t|dont|never)\s+(?:load|use|run|invoke|start|trigger|arm|enable)\b[^.;:!?\n]*?(?=[.;:!?\n]|\s(?:but|then|instead|however)\b|\s[\u2014\u2013-]\s|$)/gi, blank);

test("the lane brief template arms ultrawork, mass-ulw, ulw-loop and ulw-plan in omo", () => {
  const sessions = readFileSync(join(import.meta.dir, "../../references/sessions.md"), "utf8");
  const template = sessions.match(/```text\n(ulw\n[\s\S]*?)```/)?.[1];
  expect(template).toBeDefined();
  expect(template).not.toContain("```");
  const text = mask(template ?? "");
  expect(Object.keys(detectors).filter((name) => detectors[name]!.test(text))).toEqual(["ultrawork", "mass-ulw", "ulw-loop", "ulw-plan"]);
});
