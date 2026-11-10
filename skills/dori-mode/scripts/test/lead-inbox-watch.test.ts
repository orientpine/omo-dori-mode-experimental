import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchProblem } from "../src/lead-inbox-watch.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const monitor = (command: string) => ({ description: "받은편지", command, runtime: { pid: process.pid } });

test("a quoted absolute script path containing spaces is inspected", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "inbox watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash "${script}"`)], inbox, 0, () => true)).toBeUndefined();
});

test("a .sh.log command does not read the .sh prefix as a script", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`tail -F ${script}.log`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
});

test("a shell -c command string is inspected for the executed script", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash -lc 'exec ${script}'`)], inbox, 0, () => true)).toBeUndefined();
});

test("tailing a script file does not count as running its inbox watcher", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`tail -n 0 -F ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
});
