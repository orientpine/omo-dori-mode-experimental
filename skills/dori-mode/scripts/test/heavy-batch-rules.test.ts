import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { batchCode, batchOf, ctxWith, fakeHelper, fresh, logs, outOf, realHelper, receipts, start, state, stop, work } from "./heavy-batch-fixture.ts";

// review 4 of #476: the three rules of the batch (the lead, 2026-11-14): a helper leaves only for a helper-level failure, OOM is the runner's word, --out is real and outside every upload
beforeEach(start);
afterEach(stop);

// review 4 of #476, rule 1: only a helper-level failure takes a helper out of the batch; one item's refusal bars that item from it alone
test("a helper that refuses one item stays in the batch for the others, and the refused item runs elsewhere (rule 1, review 4 of #476)", async () => {
  // picky refuses the first item it is offered (a program it lacks) and runs every later one
  const picky = fakeHelper("picky", `if mkdir ${join(state.dir, "picky.once")} 2>/dev/null; then echo "WORKER_REFUSED program python3.99 not found" >&2; exit 1; fi; echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "O ran on picky" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null`);
  const ctx = ctxWith([picky], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  const code = await batchCode(ctx, batchOf(["1", "2", "3"], ["true"]));
  expect(code).toBe(0);
  const rs = receipts();
  expect(rs.find((r) => r.n === 1)).toMatchObject({ host: hostname(), exit: 0, refused: [{ host: "picky", why: "program python3.99 not found" }] });
  expect(rs.filter((r) => r.host === "picky").map((r) => r.n).sort()).toEqual([2, 3]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_GONE"))).toBe(false);
  expect(logs).toContain("HEAVY_BATCH_ITEM_REFUSED b #1 picky: program python3.99 not found; it goes to another host, picky stays in the batch");
});

// rule 2: OOM and the retry are decided from the runner's own state, never from what the command printed
test("a command that prints an OOM-looking line and succeeds runs once, here and on a helper (rule 2, review 4 of #476)", async () => {
  const line = "HEAVY_OOM b.1: killed at MemoryMax=1.0G";
  const talker = fakeHelper("talker", `echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "E ${line}" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null`);
  expect(await batchCode(ctxWith([talker, realHelper("ok")]), batchOf(["x"], ["true"]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: "talker", exit: 0, tries: [{ host: "talker", result: "exit 0" }] }]);
  expect(readFileSync(receipts()[0]!.err, "utf8")).toBe(`${line}\n`);
  fresh();
  expect(await batchCode(ctxWith([], false), batchOf(["x"], ["sh", "-c", `echo "${line}" >&2`]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: hostname(), exit: 0, tries: [{ result: "exit 0" }] }]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_RETRY"))).toBe(false);
});

// rule 3: --out is read through realpath and refused (fail closed) when it goes through a link or lies in an upload
test("an --out that goes through a link is refused before any item, wherever the link points (rule 3, review 4 of #476)", async () => {
  mkdirSync(join(work, "results"));
  mkdirSync(join(state.dir, "elsewhere"));
  symlinkSync(join(work, "results"), join(state.dir, "into-work"));
  symlinkSync(join(state.dir, "elsewhere"), join(state.dir, "out-link"));
  for (const out of [join(state.dir, "into-work"), join(state.dir, "into-work", "new", "deeper"), join(state.dir, "out-link")]) expect(await batchCode(ctxWith([]), batchOf(["x"], ["true"], { out }))).toBe(2);
  expect(logs.filter((l) => l.startsWith("HEAVY_BATCH_REFUSED b: --out ") && l.includes("goes through a link"))).toHaveLength(3);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_START"))).toBe(false);
});

// rule 3 again (review 5 of #476): what every item may upload counts, not the first item's plan alone
test("an --out inside a --tools tree that only later items upload is refused, though the first item stays here", async () => {
  const install = join(state.dir, "caller", "rv-video-tool");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "rv"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(install, "rv"), 0o755);
  writeFileSync(join(install, "VERSION"), "0.2.1\n");
  mkdirSync(join(state.dir, "caller", "bin"));
  symlinkSync(join(install, "rv"), join(state.dir, "caller", "bin", "rv"));
  writeFileSync(join(work, "a.txt"), "inside\n");
  writeFileSync(join(state.dir, "b.txt"), "outside\n");
  const who = { uid: process.getuid?.() ?? -1, home: homedir(), path: `${join(state.dir, "caller", "bin")}:/usr/bin:/bin` };
  // item 1 names a file outside the --sync paths (it stays here); item 2 may go to a helper with the rv tree
  const code = await batchCode(ctxWith([]), batchOf(["../b.txt", "a.txt"], ["cat", `${work}/{item}`], { tools: ["rv"], out: join(install, "batch-results") }), who);
  expect(code).toBe(2);
  expect(logs.some((l) => l.startsWith(`HEAVY_BATCH_REFUSED b: --out ${join(install, "batch-results")} and the --sync path ${install}`))).toBe(true);
});

// PR C: a batch whose items would leave a no-ship folder behind runs no item at all
test("a batch whose working folder is a heavyNoShip path runs no item (HEAVY_LOCAL_REFUSED)", async () => {
  const data = join(state.dir, "data");
  mkdirSync(join(data, "raw"), { recursive: true });
  const ship = { noShip: [data], maxBytes: 1024 ** 3, heavyLog: join(state.dir, "heavy.log") };
  expect(await batchCode(ctxWith([realHelper("h1")], false), batchOf(["x"], ["true"], { cwd: join(data, "raw"), ship }))).toBe(2);
  expect(logs.some((l) => l.startsWith("HEAVY_LOCAL_REFUSED b: 1 item(s) would run here, #1: the working folder ") && l.endsWith("no item ran (--local runs them on this host)"))).toBe(true);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_START"))).toBe(false);
});

// gongdori 2026-11-14 (#dori-pair 1571035412586168382): pick the hosts of a batch
test("--on and --not-on keep a batch on the hosts named, and a name that is no host refuses it", async () => {
  expect(await batchCode(ctxWith([realHelper("h1"), realHelper("h2")], false), batchOf(["1", "2", "3"], ["true"], { onHosts: ["h1"] }))).toBe(0);
  expect(receipts().every((r) => r.host === "h1")).toBe(true);
  fresh();
  expect(await batchCode(ctxWith([realHelper("h1"), realHelper("h2")], false), batchOf(["1", "2", "3"], ["true"], { notOn: [hostname(), "h1"] }))).toBe(0);
  expect(receipts().every((r) => r.host === "h2")).toBe(true);
  fresh();
  expect(await batchCode(ctxWith([realHelper("h1")], false), batchOf(["1"], ["true"], { onHosts: ["h9"] }))).toBe(2);
  expect(logs).toContain(`HEAVY_BATCH_REFUSED b: --on/--not-on name h9, which is no host here (known: h1, ${hostname()})`);
  // an item that can run only here (it names a path outside --sync) and a batch kept off this host
  fresh();
  writeFileSync(join(state.dir, "b.txt"), "outside\n");
  expect(await batchCode(ctxWith([realHelper("h1")], false), batchOf(["../b.txt"], ["cat", `${work}/{item}`], { onHosts: ["h1"] }))).toBe(2);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_REFUSED b: item #1 can run only on this host (") && l.endsWith("), which --on/--not-on leave out"))).toBe(true);
});

// the documented way to bring a venv along (references/scripts.md): --sync it, so each item's box has it
test("a venv given with --sync runs each item on a helper, whose box has no /home of its own", async () => {
  mkdirSync(join(work, ".venv", "bin"), { recursive: true });
  symlinkSync("/usr/bin/python3", join(work, ".venv", "bin", "python"));
  writeFileSync(join(work, "run.py"), "import sys; print('item', sys.argv[1])\n");
  expect(await batchCode(ctxWith([realHelper("h1", 1)]), batchOf(["1", "2"], [join(work, ".venv", "bin", "python"), join(work, "run.py"), "{item}"]))).toBe(0);
  const rs = receipts().sort((a, b) => a.n - b.n);
  expect(rs.map((r) => [r.host, outOf(r)])).toEqual([["h1", "item 1\n"], ["h1", "item 2\n"]]);
});

// review 1 of #479
test("an item every host left to it refuses ends the batch as failed instead of waiting for ever", async () => {
  const bad = fakeHelper("bad", 'echo "WORKER_REFUSED program python3.99 not found" >&2; exit 1');
  expect(await batchCode(ctxWith([bad]), batchOf(["1", "2"], ["true"], { onHosts: ["bad"] }))).toBe(1);
  expect(receipts().map((r) => [r.n, r.host, r.exit]).sort()).toEqual([[1, "-", null], [2, "-", null]]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_ITEM b #1 -: no host left: bad refused it (program python3.99 not found)"))).toBe(true);
});

test("a batch whose working folder goes along makes one archive for all its items; a path an item names outside --sync stops the batch", async () => {
  const cwd = join(state.dir, "ext-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "data.txt"), "data\n");
  const ship = { noShip: [], maxBytes: 1024 ** 3, heavyLog: join(state.dir, "heavy.log") };
  expect(await batchCode(ctxWith([realHelper("h1")]), batchOf(["1", "2"], ["cat", "data.txt"], { cwd, ship }))).toBe(0);
  const rs = receipts();
  expect(rs.map(outOf)).toEqual(["data\n", "data\n"]);
  expect(rs[0]!.assets).toMatch(/^[0-9a-f]{64}$/);
  expect(rs[1]!.assets).toBe(rs[0]!.assets);
  expect(logs.filter((l) => l.startsWith("HEAVY_ASSET b:"))).toHaveLength(1);
  fresh();
  writeFileSync(join(state.dir, "outside.txt"), "x\n");
  expect(await batchCode(ctxWith([realHelper("h1")]), batchOf(["1"], ["cat", join(state.dir, "outside.txt")], { ship: { ...ship, heavyLog: join(state.dir, "heavy.log") } }))).toBe(2);
  expect(logs.some((l) => l.startsWith("HEAVY_LOCAL_REFUSED b: 1 item(s) would run here, #1: ") && l.includes(`(add --sync ${join(state.dir, "outside.txt")})`))).toBe(true);
});
