import { tmpdir } from "node:os";
import { join } from "node:path";

// Every aoe window carries its Dori's DORI_CONFIG, DORI_ENV_FILE and DORI_STATE_DIR (tmux-server, #170), and a lane runs
// bun test in such a window: a test, or a CLI it spawns, that read them would load that Dori's live config and state.
// The suite starts from no DORI_* at all; a test that needs one sets it itself.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("DORI_")) delete process.env[name];
}

// A hold this host really has on (dori heavy hold-local, /tmp/dori-heavy-hold) must not reach a test: on 2026-11-08 one
// live QA hold made seven heavy tests of another lane fail with WORKER_BUSY. Every config the suite loads, and every CLI
// it starts with this environment, reads a hold directory of its own that does not exist, so no hold is on there.
process.env["DORI_HEAVY_HOLD_DIR"] = join(tmpdir(), `dori-test-no-hold-${process.pid}-${Date.now()}`);
