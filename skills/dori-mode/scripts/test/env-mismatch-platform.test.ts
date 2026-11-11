import { expect, setDefaultTimeout, test } from "bun:test";
import { envMismatch } from "../src/aoe.ts";
import type { Runner } from "../src/run.ts";

setDefaultTimeout(30_000);

test("macOS treats unavailable process environment inspection as no mismatch", async () => {
  const own = Object.getOwnPropertyDescriptor(process, "platform");
  if (!own) throw new Error("process.platform has no descriptor");
  Object.defineProperty(process, "platform", { ...own, value: "darwin" });
  try {
    const run: Runner = async (argv) => argv[2] === "process-info" ? { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: 999999999, cmdline: "omo" }] } } }), err: "" } : { code: 0, out: "", err: "" };

    expect(await envMismatch(run, "w1:p1", { DORI_CONFIG: "/second/config.json", DORI_STATE_DIR: "/second/state", DORI_ENV_FILE: "/second/dori.env", PATH: process.env["PATH"] })).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", own);
  }
});
