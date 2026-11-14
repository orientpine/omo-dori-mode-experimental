import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assetHash, assetsHave, settleAssets } from "../src/heavy-assets.ts";
import { withState } from "./fakes.ts";

// The helper's store of --sync trees on its own (review 1 of #477): what a hash says, who may read a kept copy, what
// pruning may take, two jobs keeping one tree at once, and what a broken copy leaves behind.
let state: ReturnType<typeof withState>;
let lines: string[];
const say = (l: string): void => {
  lines.push(l);
};
const store = (): string => join(state.dir, "heavy", "assets", "tester");

// a tree as an upload leaves it under a job's root, and the assets= word that names it
const arrived = (root: string, p: string, files: Record<string, string>): string[] => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, p, name), text);
  }
  return [`assets=${assetHash(join(root, p))}`];
};

beforeEach(() => {
  state = withState();
  lines = [];
});
afterEach(() => state.done());

test("trees of one size and mtime but other bytes, or single files of other names, hash apart", () => {
  const [a, b] = [join(state.dir, "a"), join(state.dir, "b")];
  for (const [d, text] of [[a, "one"], [b, "two"]] as const) {
    mkdirSync(d);
    writeFileSync(join(d, "f.py"), text);
    utimesSync(join(d, "f.py"), 1e9, 1e9);
  }
  expect(assetHash(a)).not.toBe(assetHash(b));
  writeFileSync(join(state.dir, "x.txt"), "same");
  writeFileSync(join(state.dir, "y.txt"), "same");
  expect(assetHash(join(state.dir, "x.txt"))).not.toBe(assetHash(join(state.dir, "y.txt")));
});

test("a kept copy and its store are the owner's alone whatever the umask", () => {
  const was = process.umask(0o022);
  try {
    const root = join(state.dir, "in");
    const opts = arrived(root, "/w", { "run.py": "print(1)\n" });
    expect(settleAssets(root, ["/w"], opts, join(state.dir, "heavy"), "tester", [], say)).toBe(true);
    expect(lines[0]).toMatch(/^ASSET_OK [0-9a-f]{32} \/w kept$/);
    for (const d of [join(state.dir, "heavy", "assets"), store()]) expect(statSync(d).mode & 0o077).toBe(0);
  } finally {
    process.umask(was);
  }
});

test("an entry offered to an admitted job is not pruned by another job, and a lost copy stops the job", () => {
  mkdirSync(store(), { recursive: true });
  const old = Date.now() / 1000 - 5 * 3600;
  const hashes = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(32, "0"));
  for (const h of hashes) {
    mkdirSync(join(store(), h, "tree"), { recursive: true });
    writeFileSync(join(store(), h, "ok"), "");
    utimesSync(join(store(), h, "ok"), old, old);
  }
  const offered = hashes[0]!;
  expect(assetsHave(join(state.dir, "heavy"), "tester", [`assets=${offered}`])).toEqual([offered]);
  const root = join(state.dir, "in");
  expect(settleAssets(root, ["/w"], arrived(root, "/w", { "a.py": "1\n" }), join(state.dir, "heavy"), "tester", [], say)).toBe(true);
  expect(existsSync(join(store(), offered, "ok"))).toBe(true);
  expect(readdirSync(store()).filter((h) => hashes.includes(h)).length).toBeLessThan(9);
  // a held tree whose copy is gone: the job does not run on part of its inputs
  const gone = hashes[0]!;
  const r2 = join(state.dir, "in2");
  rmSync(join(store(), gone, "tree"), { recursive: true });
  expect(settleAssets(r2, ["/w/sub"], [`assets=${gone}`], join(state.dir, "heavy"), "tester", [gone], say)).toBe(false);
  expect(lines.at(-1)).toBe(`ASSET_BAD /w/sub: the copy of ${gone} kept here could not be copied; the job does not run`);
});

test("two workers keeping one tree at once both end well, and a gone worker's .tmp is swept", async () => {
  const root = join(state.dir, "in");
  const opts = arrived(root, "/w", { "big.bin": "x".repeat(1 << 20) });
  const h = opts[0]!.slice(7);
  mkdirSync(store(), { recursive: true });
  mkdirSync(join(store(), `${h}.999999.tmp`, "tree"), { recursive: true });
  const mod = join(import.meta.dir, "../src/heavy-assets.ts");
  const script = `const { settleAssets } = await import(${JSON.stringify(mod)}); const ok = settleAssets(process.env.ROOT, ["/w"], [${JSON.stringify(opts[0])}], ${JSON.stringify(join(state.dir, "heavy"))}, "tester", [], (l) => console.log(l)); process.exit(ok ? 0 : 1);`;
  const runs = Array.from({ length: 6 }, (_, i) => {
    const r = join(state.dir, `in${i}`);
    cpSync(root, r, { recursive: true });
    return Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ROOT: r }, stdout: "pipe", stderr: "pipe" });
  });
  const out = await Promise.all(runs.map(async (p) => [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()] as const));
  for (const [code, stdout, stderr] of out) {
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe(`ASSET_OK ${h} /w kept\n`);
  }
  expect(readdirSync(store()).sort()).toEqual([h]);
  expect(existsSync(join(store(), h, "ok"))).toBe(true);
});
