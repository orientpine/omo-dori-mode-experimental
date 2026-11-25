import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

test("a 16 GiB dynamic host without procfs refuses an impossible 14 GiB estimate before queueing", async () => {
  const state = withState();
  try {
    const preload = join(state.dir, "mac.ts");
    const pressure = join(state.dir, "memory_pressure");
    const config = join(state.dir, "config.json");
    // Replace only the OS edges in this child: no procfs, a Mac's RAM size, and a real command result via PATH.
    await Bun.write(preload, `
      import { spyOn } from "bun:test";
      import * as fs from "node:fs";
      import * as os from "node:os";
      const read = fs.readFileSync;
      spyOn(fs, "readFileSync").mockImplementation((file, options) => {
        if (file === "/proc/meminfo") throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
        return read(file, options);
      });
      spyOn(os, "totalmem").mockReturnValue(16 * 1024 ** 3);
    `);
    writeFileSync(pressure, "#!/bin/sh\nprintf 'System-wide memory free percentage: 90%%\\n'\n");
    chmodSync(pressure, 0o755);
    await Bun.write(config, JSON.stringify({ heavyJobMemGb: 4, heavyMinSlots: 0, heavyMaxLoad: 1e9, heavyHoldDir: join(state.dir, "hold") }));
    const result = await run([process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli.ts"), "heavy", "mac", "--local", "--mem", "14G", "--", "true"], {
      timeoutMs: 3_000,
      env: { PATH: `${state.dir}:${process.env["PATH"]}`, DORI_CONFIG: config, DORI_STATE_DIR: state.dir, DORI_ENV_FILE: join(state.dir, "none.env") },
    });
    expect(result).toMatchObject({ code: 2, err: expect.stringContaining("HEAVY_REFUSED mac: --mem 14.0G never fits here: this host has 16.0G and keeps 20% free") });
  } finally {
    state.done();
  }
});
