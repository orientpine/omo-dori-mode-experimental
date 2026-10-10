import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { knownConfigKeys } from "../src/config-keys.ts";
import { applyUpdate } from "../src/update.ts";
import { announceChange, mergeTitles } from "../src/update-announce.ts";
import { fakeClock, withState } from "./fakes.ts";

test("sends one summary to leadPane when a merge changes a reference", async () => {
  // Given
  const state = withState();
  try {
    const sent: { pane: string; text: string }[] = [];
    const config = { ...defaultConfig(), stateDir: state.dir, watchLog: join(state.dir, "lanes.log"), leadPane: "lead", update: { ...defaultConfig().update, alertPane: "alerts" } };
    await Bun.write(join(state.dir, "update.json"), JSON.stringify({ applied: "old", keys: knownConfigKeys() }));
    // When
    await applyUpdate({
      config, configPath: join(state.dir, "missing.json"), clock: fakeClock(0),
      git: async (args) => ({ code: 0, err: "", out: args.includes("rev-parse") ? "new" : args.includes("diff") ? "skills/dori-mode/references/sessions.md" : args.includes("--merges") ? "Merge pull request #23 from acme/change\n\nExplain new lane behaviour\n" : "" }),
      systemctl: async () => ({ code: 0, out: "", err: "" }),
      send: async (pane, text) => { sent.push({ pane, text }); return true; }, print: () => {},
    }, { pull: false, dryRun: false });
    // Then
    expect(sent).toHaveLength(1);
    expect(sent[0]?.pane).toBe("lead");
    expect(sent[0]?.text).toContain("Explain new lane behaviour");
    expect(sent[0]?.text).toContain("skills/dori-mode/references/sessions.md");
    expect((await Bun.file(config.watchLog).text()).split("\n").filter((line) => line.includes(" ANNOUNCED lead"))).toHaveLength(1);
  } finally { state.done(); }
});

test("sends one guidance notification when notify-change is requested", async () => {
  // Given
  const state = withState();
  try {
    const sent: string[] = [];
    const config = { ...defaultConfig(), leadPane: "lead", watchLog: join(state.dir, "lanes.log"), update: { ...defaultConfig().update, announce: "Review your guidance." } };
    // When
    expect(await announceChange({ config, clock: fakeClock(0), print: () => {}, send: async (pane, text) => { sent.push(`${pane} ${text}`); return true; } }, { summary: "Guidance updated", files: ["AGENTS.md"] })).toBe(true);
    // Then
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStartWith("lead [UPDATE] ");
    expect(sent[0]).toContain("AGENTS.md");
    expect(sent[0]?.endsWith(config.update.announce)).toBe(true);
    expect(await Bun.file(config.watchLog).text()).toContain("update ANNOUNCED lead");
  } finally { state.done(); }
});

test("logs ANNOUNCE_FAIL when pane delivery fails", async () => {
  // Given
  const state = withState();
  try {
    const config = { ...defaultConfig(), leadPane: "lead", watchLog: join(state.dir, "lanes.log") };
    // When
    expect(await announceChange({ config, clock: fakeClock(0), print: () => {}, send: async () => false }, { summary: "Changed", files: [] })).toBe(false);
    // Then
    expect(await Bun.file(config.watchLog).text()).toContain("update ANNOUNCE_FAIL lead message did not reach pane");
  } finally { state.done(); }
});

test("uses each PR title when the git merge log contains multiple bodies", () => {
  // Given
  const log = "Merge pull request #1 from a/b\n\nFirst title\n\nMore detail\0Merge pull request #2 from a/c\n\nSecond title\n";
  // When
  const titles = mergeTitles(log);
  // Then
  expect(titles).toEqual(["First title", "Second title"]);
});
