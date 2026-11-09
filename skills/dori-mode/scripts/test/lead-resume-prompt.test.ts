import { expect, test } from "bun:test";

import { atEmptyPrompt } from "../src/lead-resume.ts";
import { AT_PROMPT, RESIDUE, screenWith } from "./lead-resume-screen.ts";

test("the prompt is empty only on the line right under the newest job line, in the whole-prompt shape", () => {
  expect(atEmptyPrompt(AT_PROMPT)).toBe(true);
  expect(atEmptyPrompt(screenWith("(venv) soodori@ori0a83:~/a$"))).toBe(true);
  expect(atEmptyPrompt(screenWith("root@ori0a83:/tmp#"))).toBe(true);
  // as herdr gives it with colours: bash left omo's status text after the prompt, in omo's colours
  expect(atEmptyPrompt(screenWith(RESIDUE))).toBe(true);
  // the same row with something typed over its start, in no colour
  expect(atEmptyPrompt(screenWith(RESIDUE.replace("$ \u001b[0m\u001b[38;2;103;113;118mto)", "$ git\u001b[0m\u001b[38;2;103;113;118m)")))).toBe(false);
  // typed input, a fragment of omo's status line bash has not cleared yet, mouse report bytes
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ git push"))).toBe(false);
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ to)     (anthropic-subscription)"))).toBe(false);
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ 65;57;24M"))).toBe(false);
  // no job line: an ordinary screen, omo's own input box
  expect(atEmptyPrompt("soodori@ori0a83:/tmp$\n")).toBe(false);
  expect(atEmptyPrompt("────\n❯ \n────\n")).toBe(false);
  // a later prompt holds the cursor, and may hold input this check cannot see
  expect(atEmptyPrompt(`${AT_PROMPT}soodori@ori0a83:/tmp$ rm -rf x\n`)).toBe(false);
  expect(atEmptyPrompt(`${AT_PROMPT}soodori@ori0a83:/tmp$\n`)).toBe(false);
  // something ran after the stop
  expect(atEmptyPrompt(["[1]+  Stopped   omo", "hello", "soodori@ori0a83:/tmp$", ""].join("\n"))).toBe(false);
  // a command typed by someone that ends in the prompt's last character, on a prompt with no user@host
  expect(atEmptyPrompt(screenWith("$ echo cost$"))).toBe(false);
});
