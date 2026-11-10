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

test("exec before the interpreter still selects the script operand", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`exec bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
});

test("shell options before the script operand are skipped", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash -e ${script}`)], inbox, 0, () => true)).toBeUndefined();
});

test("shell stdin mode does not treat its positional script argument as executed", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash -s ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
});

test("an init-file option operand is not mistaken for the executed script", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash --init-file ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
});

test("the noexec option does not count as executing the script", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash -o noexec ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
});

test("grouped shell options with an o operand still select the script", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`bash -euo pipefail ${script}`)], inbox, 0, () => true)).toBeUndefined();
});

test("a monitor restored with leading environment setup is still inspected", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`export SENPI_MONITOR_RESTORED=1; bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
});

test("an assignment before a direct script or interpreter is skipped", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const script = join(state.dir, "watch.sh");
  writeFileSync(script, `#!/bin/sh\ntail -n 0 -F ${inbox}\n`);
  expect(watchProblem([monitor(`SENPI_MONITOR_RESTORED=1 ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`SENPI_MONITOR_RESTORED=1 bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`SENPI_MONITOR_RESTORED=1 exec bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`export SENPI_MONITOR_RESTORED=1;bash -e ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`LABEL='owner;pair' bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`LABEL="owner;pair" ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`HOST=$(hostname) bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`HOST=$(hostname) ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`HOST=$(hostname -s) bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`BASH_ENV= bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`export BASH_ENV=;bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`LABEL=owner\\ pair bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`HOST=$(hostname $(printf nested)) bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`SEP='\\' bash ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`SEP='\\' bash -e ${script}`)], inbox, 0, () => true)).toBeUndefined();
  expect(watchProblem([monitor(`bash -c -e ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
  expect(watchProblem([monitor(`bash -c -o pipefail ${script}`)], inbox, 0, () => true)).toBe("no monitor on inbox.jsonl");
  expect(watchProblem([monitor(`bash -c 'exec ${script}' -e`)], inbox, 0, () => true)).toBeUndefined();
});
