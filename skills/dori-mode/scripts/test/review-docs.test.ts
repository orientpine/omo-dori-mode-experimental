import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { readReceipt, reviewPr } from "../src/merge-gate.ts";
import { A, cleanup, DIR, deps, PR, world } from "./merge-gate-world.ts";

afterEach(() => { cleanup(); });

const review = async (paths: string[], verdict = "CLEAR", listCode = 0) => {
  const w = world();
  w.verdict = verdict;
  const d = deps(w);
  const original = d.run;
  const run: typeof d.run = async (argv, opts) => argv.includes("--name-only")
    ? { code: listCode, out: paths.join("\n"), err: "" }
    : original(argv, opts);
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    const lines = await reviewPr({ ...d, run }, PR, { dir: DIR });
    return { lines, warnings: stderr.mock.calls.map((c) => c.join(" ")), log: readFileSync(d.config.watchLog, "utf8"), tests: await readReceipt(d.config.stateDir, PR, A, "tests"), receipt: await readReceipt(d.config.stateDir, PR, A, "review") };
  } finally {
    stderr.mockRestore();
  }
};

test("code without docs warns on stderr and review watch log while tests, receipt and CLEAR succeed", async () => {
  const r = await review(["skills/dori-mode/scripts/src/foo.ts"]);
  expect(r.warnings).toEqual(["DOCS_UNTOUCHED acme/app#7: 1 code file(s) changed and no documentation file was touched (directive docs-same-pr; a warning for now, refusal to be reviewed on 2026-12-01)"]);
  expect(r.log).toContain(` review ${r.warnings[0]}`);
  expect(r.tests?.code).toBe(0);
  expect(r.receipt?.verdict).toBe("CLEAR");
  expect(r.tests?.checks?.some((l) => l.includes("DOCS_UNTOUCHED"))).toBe(false);
  expect(r.lines.at(-1)).toContain("verdict=CLEAR");
});

for (const path of ["setups/discord-aoe/dori-file-relay", "src/service.py", "skills/dori-mode/scripts/src/config.json"]) {
  test(`non-test code ${path} warns`, async () => {
    expect((await review([path])).warnings[0]).toContain("DOCS_UNTOUCHED");
  });
}

for (const doc of ["guide.md", "README", "README.rst", "pkg/references/commands.json", "docs/guide.txt"]) {
  test(`code with documentation ${doc} prints nothing new`, async () => {
    const r = await review(["src/main.ts", doc]);
    expect(r.warnings).toEqual([]);
    expect(r.log).not.toContain("DOCS_UNTOUCHED");
    expect(r.lines.at(-1)).toContain("verdict=CLEAR");
  });
}

for (const paths of [[], ["test/foo.test.ts"], ["src/foo.spec.ts"], ["tests/test_app.py"], ["README.md"], ["package.json"]]) {
  test(`no production code in ${JSON.stringify(paths)} prints nothing new`, async () => {
    expect((await review(paths)).warnings).toEqual([]);
  });
}

test("a warning leaves a BLOCK verdict and its receipt unchanged", async () => {
  const r = await review(["src/main.ts"], "BLOCK");
  expect(r.warnings[0]).toContain("directive docs-same-pr");
  expect(r.receipt?.verdict).toBe("BLOCK");
  expect(r.lines.at(-1)).toContain("verdict=BLOCK");
});

test("an unavailable advisory file list does not stop the existing review", async () => {
  const r = await review([], "CLEAR", 1);
  expect(r.warnings).toEqual([]);
  expect(r.lines.at(-1)).toContain("verdict=CLEAR");
});
