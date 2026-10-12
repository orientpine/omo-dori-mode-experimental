import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageHtml, usageSnapshot } from "../../setups/discord-aoe/usage-snapshot.ts";
import { fakeClock, withState } from "./fakes.ts";
import type { Runner } from "../src/run.ts";

test("usage HTML preserves ANSI colors and escapes captured text", () => {
  const page = usageHtml("\x1b[1;38;5;196m<quota>&\x1b[0m\n\x1b[48;2;1;2;3mremaining\x1b[0m\n");
  expect({
    escaped: page.html.includes("&lt;quota&gt;&amp;"),
    color: page.html.includes("color:rgb(255,0,0)"),
    bold: page.html.includes("font-weight:700"),
    background: page.html.includes("background:rgb(1,2,3)"),
    height: page.height,
  }).toEqual({ escaped: true, color: true, bold: true, background: true, height: 78 });
});

test("usage snapshot honors paths with spaces, captures loaded quota and cleans intermediates", async () => {
  const temp = withState();
  const calls: (readonly string[])[] = [];
  let captures = 0;
  const out = join(temp.dir, "result.png");
  const snap = join(temp.dir, "firefox space");
  const runner: Runner = async (args) => {
    calls.push(args);
    if (args[1] === "capture-pane") return { code: 0, err: "", out: ++captures === 1 ? "loading" : "[q] quit\nupdated 1:23\nquota" };
    if (args[0] === "firefox") writeFileSync(args[3] ?? "", "fake-png");
    return { code: 0, err: "", out: "" };
  };
  try {
    await usageSnapshot(out, { DORI_USAGE_DIR: "/repo with spaces", DORI_USAGE_SNAP_DIR: snap }, runner, fakeClock(0));
    const launch = calls.find((c) => c[1] === "new-session") ?? [];
    const firefox = calls.find((c) => c[0] === "firefox") ?? [];
    expect({
      cwd: launch[launch.indexOf("-c") + 1],
      command: launch.slice(-3),
      captures,
      stopped: calls.some((c) => c[1] === "kill-session"),
      screenshotDir: firefox[3]?.startsWith(`${snap}/`),
      output: readFileSync(out, "utf8"),
      pageLeft: existsSync(join(snap, `page-${process.pid}.html`)),
      shotLeft: existsSync(join(snap, `shot-${process.pid}.png`)),
    }).toEqual({ cwd: "/repo with spaces", command: ["bun", "run", "bin/omo-usage.ts"], captures: 2, stopped: true, screenshotDir: true, output: "fake-png", pageLeft: false, shotLeft: false });
  } finally {
    temp.done();
  }
});

test("usage capture failure still removes its temporary tmux session", async () => {
  const calls: string[] = [];
  const runner: Runner = async (args) => {
    calls.push(args[1] ?? "");
    return { code: args[1] === "capture-pane" ? 1 : 0, out: "", err: "capture failed" };
  };
  const result = await usageSnapshot("/unused", { DORI_USAGE_DIR: "/repo" }, runner, fakeClock(0)).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  expect({ result, calls }).toEqual({ result: "tmux capture-pane -e: capture failed", calls: ["new-session", "capture-pane", "kill-session"] });
});
