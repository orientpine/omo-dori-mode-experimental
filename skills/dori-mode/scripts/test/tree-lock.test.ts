import { afterEach, beforeEach, expect, test } from "bun:test";

import { addNode, loadTree, updateTree } from "../src/explore.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("two tree adds at once on one area get two numbers and both stay (worklog 7d68e5b0: F183 twice)", async () => {
  const area = { cwd: "/work/rl" };
  const add = (text: string) => updateTree(state.dir, area, (t) => addNode(t, { kind: "finding", text, source: "dori tree add" }, "t").tree);
  await Promise.all([add("first source says x"), add("second source says y")]);
  const found = (await loadTree(state.dir, area)).nodes.filter((n) => n.kind === "finding");
  expect(found.map((n) => n.id).sort()).toEqual(["F1", "F2"]);
  expect(found.map((n) => n.text).sort()).toEqual(["first source says x", "second source says y"]);
});
