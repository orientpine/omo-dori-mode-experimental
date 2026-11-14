import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { itemCmd } from "../src/heavy-batch.ts";
import { batchCode, batchOf, ctxWith, fakeHelper, fresh, logs, outOf, realHelper, receipts, start, state, stop, work } from "./heavy-batch-fixture.ts";

beforeEach(start);
afterEach(stop);

test("every item of the batch runs once, on this host or a helper, and its output and the host it ran on come back to one folder", async () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const code = await batchCode(ctxWith([realHelper("h1"), realHelper("h2")], false), batchOf(items, ["sh", "-c", "echo item=$0 n=$DORI_HEAVY_ITEM_N; echo made > out-$0.txt", "{item}"]));
  expect(code).toBe(0);
  const rs = receipts();
  expect(rs.map((r) => r.item).sort()).toEqual(items);
  for (const r of rs) {
    expect(r.exit).toBe(0);
    expect(outOf(r)).toBe(`item=${r.item} n=${r.n}\n`);
    expect(readFileSync(join(work, `out-${r.item}.txt`), "utf8")).toBe("made\n");
  }
  // all three hosts took items: this host's one slot, and each helper's three
  expect(new Set(rs.map((r) => r.host))).toEqual(new Set([hostname(), "h1", "h2"]));
  expect(JSON.parse(readFileSync(join(state.dir, "out", "summary.json"), "utf8"))).toMatchObject({ items: 6, ok: 6, failed: 0 });
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_DONE b: 6/6 items exit 0"))).toBe(true);
});

test("an item whose helper dies, or that is killed for memory, runs once more on another host; a second failure is final", async () => {
  const fails = { cut: 'echo "WORKER_ADMIT slot.1 alive=60 run=1-x" >&2; cat >/dev/null; exit 255', oom: 'echo "WORKER_ADMIT slot.1 alive=60 run=1-x" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null' };
  for (const [result, script] of Object.entries(fails)) {
    fresh();
    // the failing helper is first in line, so the item goes there first
    const code = await batchCode(ctxWith([fakeHelper("bad", script), realHelper("ok")]), batchOf(["x"], ["sh", "-c", "echo ran $0", "{item}"]));
    expect(code).toBe(0);
    expect(receipts()).toMatchObject([{ item: "x", host: "ok", exit: 0, tries: [{ host: "bad", result }, { host: "ok", result: "exit 0" }] }]);
    expect(logs.some((l) => l.startsWith("HEAVY_BATCH_RETRY b #1 bad: "))).toBe(true);
  }
  // only failing hosts: the item tries twice and ends failed
  fresh();
  const again = await batchCode(ctxWith([fakeHelper("dead", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; exit 255'), fakeHelper("dead2", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; exit 255')]), batchOf(["z"], ["true"]));
  expect(again).toBe(1);
  expect(receipts()).toMatchObject([{ item: "z", exit: null, tries: [{ result: "cut" }, { result: "cut" }] }]);
});

test("--mem over --mem-per-worker caps the items running at once on each host; a host short of memory starts no new one while its own go on", async () => {
  // admits one item, then answers that memory is short while that one still runs
  const tight = fakeHelper("tight", `if mkdir ${join(state.dir, "tight.lock")} 2>/dev/null; then echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; sleep 1; echo "O ran on tight" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null; else echo "WORKER_BUSY memory: needs 15.0G, 20.0G available -> 4% free (needs 10% free)" >&2; exit 75; fi`);
  const capped = realHelper("capped", 4);
  const code = await batchCode(ctxWith([tight, capped]), batchOf(["1", "2", "3", "4", "5"], ["sh", "-c", "date +%s%N; sleep 0.4; date +%s%N"], { memPerWorker: 1024 ** 3, memCap: 2 * 1024 ** 3 }));
  expect(code).toBe(0);
  expect(logs).toContain("HEAVY_BATCH_HOST b capped: up to 2 worker(s) at once (--mem 2.0G / --mem-per-worker 1.0G)");
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_SHRINK b tight: memory: needs 15.0G") && l.includes("1 running there go on"))).toBe(true);
  // capped (four slots of its own) ran two at once, never three
  const spans = receipts().filter((r) => r.host === "capped").map((r) => outOf(r).trim().split("\n").map(Number) as [number, number]);
  expect(spans.length).toBe(4);
  const most = Math.max(...spans.map(([at]) => spans.filter(([s, e]) => s <= at && at < e).length));
  expect(most).toBe(2);
});

test("an item here is measured by its own process, and its slot stays the batch's until the item drained, so a later item never takes it over (review 2 of #476)", async () => {
  // item 1 exits at once but a child holds its output for 2 s; item 2, in the second slot, looks at the first meanwhile
  const heavy = join(state.dir, "heavy");
  const code = await batchCode(ctxWith([], false, undefined, false, 2), batchOf(["1", "2"], ["sh", "-c", `if [ "$0" = 1 ]; then echo pid=$$; (sleep 2) & exit 0; fi; sleep 0.5; cat ${heavy}/slot.1/owner; echo; cat ${heavy}/slot.1/tree`, "{item}"]));
  expect(code).toBe(0);
  const [one, two] = [1, 2].map((n) => outOf(receipts().find((r) => r.n === n)!).trim());
  const [owner = "", tree = ""] = two!.split("\n");
  expect(owner.startsWith(`${process.pid} b.1 `)).toBe(true);
  expect(`pid=${tree}`).toBe(one!);
});

test("a helper that does not answer holds back only itself: the other hosts run the items meanwhile (review 1 of #476)", async () => {
  const hang = fakeHelper("hang", "sleep 30");
  const code = await batchCode(ctxWith([hang, realHelper("ok")], true, 0.05), batchOf(["1", "2", "3"], ["true"]));
  expect(code).toBe(0);
  expect(receipts().every((r) => r.host === "ok")).toBe(true);
  const down = logs.findIndex((l) => l.startsWith("HEAVY_BATCH_WAIT b hang: down"));
  expect(down).toBeGreaterThan(logs.findIndex((l) => l.startsWith("HEAVY_BATCH_START b #2 ok")));
});

test("an item that failed goes back to the same host when the only other one is down, and the batch ends (review 1 of #476)", async () => {
  const oom = fakeHelper("oom", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null');
  // this host is full for good, so the retry waits RETRY_WAIT_MS for it (the clock skips each poll) and goes back to oom; the down helper never counts
  const code = await batchCode(ctxWith([oom, { name: "down", ssh: ["false"] }], true, 60, true), batchOf(["x"], ["true"]));
  expect(code).toBe(1);
  expect(receipts()).toMatchObject([{ item: "x", exit: 137, tries: [{ host: "oom", result: "oom" }, { host: "oom", result: "oom" }] }]);
});

test("a batch whose --out lies in a --sync path, or whose --mem holds less than one worker, is refused before any item (review 1 of #476)", async () => {
  expect(await batchCode(ctxWith([]), batchOf(["x"], ["true"], { out: join(work, "out") }))).toBe(2);
  expect(await batchCode(ctxWith([]), batchOf(["x"], ["true"], { memPerWorker: 2 * 1024 ** 3, memCap: 1024 ** 3 }))).toBe(2);
  expect(logs.filter((l) => l.startsWith("HEAVY_BATCH_REFUSED b: "))).toHaveLength(2);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_START"))).toBe(false);
});

test("an item whose own command names a path outside the --sync paths runs here; the item text stays literal (review 1 of #476)", async () => {
  writeFileSync(join(work, "a.txt"), "inside\n");
  writeFileSync(join(state.dir, "b.txt"), "outside\n");
  // this host is full for a second, so only its own path keeps the third item off the helper, which takes the first two
  const ctx = ctxWith([realHelper("h1")], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  const code = await batchCode(ctx, batchOf(["a.txt", "a.txt", "../b.txt"], ["cat", `${work}/{item}`]));
  expect(code).toBe(0);
  const two = receipts().find((r) => r.n === 3)!;
  expect(two.host).toBe(hostname());
  expect(outOf(two)).toBe("outside\n");
  expect(itemCmd(["x={item}-{n}"], "a$&b{n}", 3)).toEqual(["x=a$&b{n}-3"]);
});

test("an item here runs with the --tools PATH this host found (review 1 of #476)", async () => {
  const bin = join(state.dir, "offpath");
  mkdirSync(bin);
  writeFileSync(join(bin, "mytool"), "#!/bin/sh\necho tool ran\n");
  chmodSync(join(bin, "mytool"), 0o755);
  // the job's --env PATH (what a helper gets) does not undo it here (review 2 of #476)
  const code = await batchCode(ctxWith([], false), batchOf(["x"], ["mytool"], { env: { PATH: process.env["PATH"] ?? "" }, hereEnv: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` } }));
  expect(code).toBe(0);
  expect(outOf(receipts()[0]!)).toBe("tool ran\n");
});

test("a relative program of a later item that lies outside the --sync paths keeps that item here (review 2 of #476)", async () => {
  for (const [f, say] of [[join(work, "in.sh"), "inside"], [join(state.dir, "out.sh"), "outside"]] as const) {
    writeFileSync(f, `#!/bin/sh\necho ${say}\n`);
    chmodSync(f, 0o755);
  }
  // as in the path test above: this host is full for a second, so only its own path keeps the third item off the helper
  const ctx = ctxWith([realHelper("h1")], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  expect(await batchCode(ctx, batchOf(["in.sh", "in.sh", "../out.sh"], ["./{item}"]))).toBe(0);
  const three = receipts().find((r) => r.n === 3)!;
  expect([three.host, outOf(three)]).toEqual([hostname(), "outside\n"]);
});

test("a later item's bare program found only on the caller's PATH keeps that item here, and each item gets its own plan (review 3 of #476)", async () => {
  const bin = join(state.dir, "mine");
  mkdirSync(bin);
  writeFileSync(join(bin, "private-tool"), "#!/bin/sh\necho private\n", { mode: 0o755 });
  const path = `${bin}:${process.env["PATH"]}`;
  // this host is full for a second, so only its own plan keeps the third item off the helper
  const ctx = ctxWith([realHelper("h1")], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  const code = await batchCode(ctx, batchOf(["true", "true", "private-tool"], ["{item}"], { hereEnv: { ...process.env, PATH: path } }), { uid: process.getuid?.() ?? -1, home: homedir(), path });
  expect(code).toBe(0);
  const three = receipts().find((r) => r.n === 3)!;
  expect([three.host, outOf(three)]).toEqual([hostname(), "private\n"]);
});

test("a pipeline an item puts into a bash -c script fails the item when a stage fails, here and on a helper (review 3 of #476)", async () => {
  expect(await batchCode(ctxWith([], false), batchOf(["false | tail -n 1"], ["bash", "-c", "{item}"]))).toBe(1);
  expect(receipts()).toMatchObject([{ host: hostname(), exit: 1 }]);
  fresh();
  expect(await batchCode(ctxWith([realHelper("h1")]), batchOf(["false | tail -n 1"], ["bash", "-c", "{item}"]))).toBe(1);
  expect(receipts()).toMatchObject([{ host: "h1", exit: 1 }]);
});

test("a failed item waits for the other host at its worker cap and runs there once it frees, its one retry elsewhere (challenge of the review-3 plan)", async () => {
  // y holds the second helper's only worker for 3 s; x fails on the first and waits for it rather than spend its retry there again
  const code = await batchCode(ctxWith([fakeHelper("oom", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null'), realHelper("capped")]), batchOf(["x", "y"], ["sh", "-c", 'if [ "$0" = y ]; then sleep 3; fi', "{item}"], { memPerWorker: 1024 ** 3, memCap: 1024 ** 3 }));
  expect(code).toBe(0);
  const [x, y] = ["x", "y"].map((i) => receipts().find((r) => r.item === i)!);
  expect(x!.tries).toEqual([{ host: "oom", result: "oom" }, { host: "capped", result: "exit 0" }]);
  expect(Date.parse(x!.end)).toBeGreaterThan(Date.parse(y!.end));
});

test("a failed item waits for another host still answering an offer, not only for one that is free (challenge of the review-3 plan)", async () => {
  const f = join(state.dir, "slow-admit.sh");
  writeFileSync(f, '#!/bin/sh\nsleep 2\nexec "$@"\n', { mode: 0o755 });
  const slow = { name: "slow", ssh: [f, ...realHelper("slow").ssh] };
  const code = await batchCode(ctxWith([fakeHelper("oom", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null'), slow]), batchOf(["x", "y"], ["true"]));
  expect(code).toBe(0);
  expect(receipts().find((r) => r.item === "x")!.tries).toEqual([{ host: "oom", result: "oom" }, { host: "slow", result: "exit 0" }]);
});

test("a retry that waited RETRY_WAIT_MS for another host goes back to the one it failed on (challenge of the review-3 plan)", async () => {
  // the clock skips each 15 s poll, so the 10-minute wait passes in about 2 s while y still holds the other host's worker
  const code = await batchCode(ctxWith([fakeHelper("oom", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null'), realHelper("capped")], true, 60, true), batchOf(["x", "y"], ["sh", "-c", 'if [ "$0" = y ]; then sleep 4; fi', "{item}"], { memPerWorker: 1024 ** 3, memCap: 1024 ** 3 }));
  expect(code).toBe(1);
  const [x, y] = ["x", "y"].map((i) => receipts().find((r) => r.item === i)!);
  expect(x!.tries).toEqual([{ host: "oom", result: "oom" }, { host: "oom", result: "oom" }]);
  expect(Date.parse(x!.end) - Date.parse(x!.start)).toBeGreaterThanOrEqual(10 * 60_000);
  expect(y!.exit).toBe(0);
});

test("a batch archives its --sync once: every helper item gets the same bytes and its receipt names their sha256 (lead's condition 1 of #477 H334)", async () => {
  writeFileSync(join(work, "code.py"), "print(1)\n");
  const code = await batchCode(ctxWith([realHelper("h1")]), batchOf(["a", "b"], ["sh", "-c", "cat code.py"]));
  expect(code).toBe(0);
  const rs = receipts();
  expect(rs.map((r) => r.host)).toEqual(["h1", "h1"]);
  const sha = rs[0]!.assets;
  expect(sha).toMatch(/^[0-9a-f]{64}$/);
  expect(rs[1]!.assets).toBe(sha);
  expect(logs.filter((l) => l.startsWith("HEAVY_ASSET b:"))).toHaveLength(1);
  expect(readFileSync(join(state.dir, "h1", "state", "heavy", "heavy.log"), "utf8").match(new RegExp(`ASSET_OK ${sha} `, "g"))).toHaveLength(2);
});
