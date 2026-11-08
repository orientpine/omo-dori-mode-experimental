// From upstream dori-superagent test/runtime-hc-misc.test.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/test/runtime-hc-misc.test.ts).
import { describe, expect, test } from "bun:test";
import { type HcError, hcCall } from "../src/runtime/hc/exec.ts";
import { terminal } from "./fake-hc.ts";
import { rig, T1 } from "./hc-rig.ts";

describe("typed text, shells, keys", () => {
  test("submitTyped is always changed and touches nothing (hc sends paste+Enter atomically)", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    expect(await rt.submitTyped(T1, { agent: "omo", pgid: 4242 })).toBe("changed");
    expect(fake.calls).toEqual([]);
  });

  test("typeIntoShell sends into an unreported shell without a status gate", async () => {
    const { fake, rt } = rig({
      t1: terminal({ status: null, reported: false, foreground: { name: "zsh", argv: ["-zsh"], pid: 2 } }),
    });
    expect(await rt.typeIntoShell(T1, "ls -la")).toBe(true);
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--", "ls -la"]]);
  });

  test("typeIntoShell refuses when an agent is in front", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    expect(await rt.typeIntoShell(T1, "rm -rf x")).toBe(false);
    expect(fake.sent).toEqual([]);
  });

  test("keys map escape to esc in one call", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    await rt.keys(T1, ["escape", "enter"]);
    expect(fake.calls).toEqual([["keys", "t1", "esc", "enter"]]);
  });

  test("read asks for history lines and returns the text", async () => {
    const { fake, rt } = rig({ t1: terminal({ screen: "line a\nline b" }) });
    expect(await rt.read(T1, 40)).toBe("line a\nline b");
    expect(fake.calls).toEqual([["read", "t1", "--lines", "40"]]);
  });
});

describe("close, list, self", () => {
  test("close kills then removes, whatever the scope", async () => {
    const { fake, rt, sleeps } = rig({ t1: terminal() });
    await rt.close(T1, "container");
    expect(fake.calls).toEqual([
      ["kill", "t1"],
      ["rm", "t1"],
    ]);
    expect(sleeps).toEqual([]);
    expect(fake.terminals.has("t1")).toBe(false);
  });

  test("rm answering live is retried every 200 ms until it goes", async () => {
    const { fake, rt, sleeps } = rig({ t1: terminal() });
    fake.knobs.liveAfterKill = 2;
    await rt.close(T1);
    expect(fake.calls.filter((c) => c[0] === "rm")).toHaveLength(3);
    expect(sleeps).toEqual([200, 200]);
  });

  test("still live after 5 retries is logged, not thrown", async () => {
    const { fake, rt, sleeps, logs } = rig({ t1: terminal() });
    fake.knobs.liveAfterKill = 99;
    await rt.close(T1);
    expect(fake.calls.filter((c) => c[0] === "rm")).toHaveLength(6);
    expect(sleeps).toEqual([200, 200, 200, 200, 200]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("t1");
  });

  test("closing a terminal hc no longer knows is a no-op", async () => {
    const { rt } = rig();
    await rt.close(T1);
  });

  test("list filters by the dori.group label and keeps only this core's terminals", async () => {
    const { fake, rt } = rig({
      t1: terminal({ labels: { "dori.group": "g1" } }),
      t2: terminal({ labels: { "dori.group": "g2" } }),
      t3: terminal({ labels: { "dori.group": "g1" } }),
    });
    expect(await rt.list({ group: "g1" })).toEqual([
      { ref: { runtime: "hc", id: "t1", group: "g1" }, cwd: "/w", status: "idle", agent: "omo" },
      { ref: { runtime: "hc", id: "t3", group: "g1" }, cwd: "/w", status: "idle", agent: "omo" },
    ]);
    expect(fake.calls).toEqual([["ls", "--label", "dori.group=g1"]]);
  });

  test("list without a group lists every live local terminal", async () => {
    const { fake, rt } = rig({ t1: terminal(), t2: terminal({ state: "finished" }) });
    expect(await rt.list()).toEqual([{ ref: { runtime: "hc", id: "t1" }, cwd: "/w", status: "idle", agent: "omo" }]);
    expect(fake.calls).toEqual([["ls"]]);
  });

  test("self comes from HC_TERMINAL_ID", () => {
    expect(rig({}, { HC_TERMINAL_ID: "t9" }).rt.self()).toEqual({ runtime: "hc", id: "t9" });
    expect(rig({}, {}).rt.self()).toBeUndefined();
    expect(rig({}, { HC_TERMINAL_ID: "" }).rt.self()).toBeUndefined();
  });

  test("kind is hc", () => {
    expect(rig().rt.kind).toBe("hc");
  });
});

describe("hcCall", () => {
  test("parses hc's error JSON from stderr, hint either at error.hint or error.data.hint", async () => {
    const exec = async () => ({
      code: 3,
      stdout: "",
      stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal", data: { hint: "see ls" } } }),
    });
    const err = await hcCall(exec, ["get", "t5"]).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not_found", hint: "see ls", reason: "no terminal" });
  });

  test("redacts the delivered text; with no JSON the kind falls back to hc's exit-code table", async () => {
    const exec = async () => ({ code: 5, stdout: "", stderr: "boom" });
    const err = (await hcCall(exec, ["send", "t1", "--", "secret text"], { redact: "secret text" }).catch(
      (e: unknown) => e,
    )) as HcError;
    expect(err.kind).toBe("unavailable");
    expect(err.argv).toEqual(["--json", "send", "t1", "--", "<text>"]);
    expect(err.message).not.toContain("secret text");
  });
});
