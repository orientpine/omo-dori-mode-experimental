import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dori-superagent issue #48 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/48
// The real install.sh over a clone of a local upstream; a stub bun stands in for bun install and bun link.
const script = resolve(import.meta.dir, "../../../../install.sh");
const gitEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...argv: string[]): string => {
  const r = Bun.spawnSync(["git", ...argv], { cwd, env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "dori-install-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const src = join(root, "src");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const file = "skills/dori-mode/scripts/src/cli.ts";
  mkdirSync(join(upstream, "skills/dori-mode/scripts/src"), { recursive: true });
  mkdirSync(join(upstream, "skills/dori-mode/references"), { recursive: true });
  writeFileSync(join(upstream, file), "v1\n");
  writeFileSync(join(upstream, "skills/dori-mode/references/config.example.json"), "{}\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "v1");
  git(root, "clone", "-q", upstream, src);
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "bun"), 0o755);
  const commitUpstream = (text: string) => {
    writeFileSync(join(upstream, file), text);
    git(upstream, "commit", "-qam", text.trim());
  };
  const install = (env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", script], { env: { ...gitEnv, HOME: home, DORI_REPO: upstream, DORI_SRC: src, SKILLS_DIR: join(home, "skills"), PATH: `${bin}:${gitEnv.PATH}`, ...env } });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return { upstream, src, file, commitUpstream, install };
};

test("install.sh over a clean checkout pulls upstream", () => {
  const { upstream, src, commitUpstream, install } = setup();
  commitUpstream("v2\n");
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

test("a local edit in the way of the pull stops install.sh with the checkout, the file and both ways on", () => {
  const { src, file, commitUpstream, install } = setup();
  commitUpstream("v2\n");
  writeFileSync(join(src, file), "patched\n");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain(`could not update ${src}`);
  expect(r.err).toContain(` M ${file}`);
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(r.err).toContain(`git -C "${src}" fetch && git -C "${src}" reset --hard '@{u}'`);
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});

test("DORI_NO_PULL=1 installs the checkout as it is, local edit and all", () => {
  const { src, file, commitUpstream, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  commitUpstream("v2\n");
  writeFileSync(join(src, file), "patched\n");
  const r = install({ DORI_NO_PULL: "1" });
  expect(r.code).toBe(0);
  expect(r.err).toContain("DORI_NO_PULL=1: installing");
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});
