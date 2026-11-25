// From upstream dori-superagent test/runtime-exec.test.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/test/runtime-exec.test.ts).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec, ToolError } from "../src/runtime/exec.ts";
import { groupId } from "../src/runtime/group.ts";
import { execOf, type RunOptions } from "../src/run.ts";

describe("groupId", () => {
  test("is 8 lowercase hex chars and stable for one store root", () => {
    const id = groupId("/some/dori/home");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(groupId("/some/dori/home")).toBe(id);
  });

  test("hashes the resolved path: relative and trailing-slash spellings agree, other roots differ", () => {
    expect(groupId("/some/dori/home/")).toBe(groupId("/some/dori/home"));
    expect(groupId("/some/dori/./home")).toBe(groupId("/some/dori/home"));
    expect(groupId(".")).toBe(groupId(process.cwd()));
    expect(groupId("/other/home")).not.toBe(groupId("/some/dori/home"));
  });

  test("a symlinked store root shares the target's group", () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-group-"));
    symlinkSync(dir, `${dir}-link`);
    expect(groupId(`${dir}-link`)).toBe(groupId(dir));
  });
});

describe("exec", () => {
  test("ToolError names the tool, argv, exit code and the tool's own reason", () => {
    const err = new ToolError(["get", "t7"], { code: 3, stdout: "out", stderr: " not found \n" }, "hc");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("hc get t7 failed (3): not found");
    expect(err.argv).toEqual(["get", "t7"]);
    expect(err.result.code).toBe(3);
    expect(new ToolError(["x"], { code: 1, stdout: "from stdout", stderr: "" }, "herdr").message).toBe(
      "herdr x failed (1): from stdout",
    );
  });

  test("spawnExec returns code, stdout and stderr of a real process", async () => {
    const r = await spawnExec("sh", ["-c", "printf out; printf err >&2; exit 4"]);
    expect(r).toEqual({ code: 4, stdout: "out", stderr: "err" });
  });

  test("spawnExec's per-call env removes a variable named undefined and sets a named one, the rest inherited", async () => {
    const names = (await spawnExec("env", [], { HOME: undefined, DORI_EXEC_SET: "1" })).stdout.split("\n");
    expect(names.some((line) => line.startsWith("HOME="))).toBe(false);
    expect(names).toContain("DORI_EXEC_SET=1");
    expect(names.some((line) => line.startsWith("PATH="))).toBe(true);
  });

  test("execOf hands a call's env to the Runner, and no env when the call has none", async () => {
    const seen: (RunOptions | undefined)[] = [];
    const exec = execOf(async (_argv, opts) => {
      seen.push(opts);
      return { code: 0, out: "", err: "" };
    });
    await exec("hc", ["--json", "send"], { HC_TERMINAL_ID: undefined });
    await exec("hc", ["--json", "get"]);
    expect(seen).toEqual([{ env: { HC_TERMINAL_ID: undefined } }, undefined]);
    expect(Object.hasOwn(seen[0]?.env ?? {}, "HC_TERMINAL_ID")).toBe(true);
  });
});
