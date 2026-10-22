// Every aoe window carries its Dori's DORI_CONFIG, DORI_ENV_FILE and DORI_STATE_DIR (tmux-server, #170), and a lane runs
// bun test in such a window: a test, or a CLI it spawns, that read them would load that Dori's live config and state.
// The suite starts from no DORI_* at all; a test that needs one sets it itself.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("DORI_")) delete process.env[name];
}
