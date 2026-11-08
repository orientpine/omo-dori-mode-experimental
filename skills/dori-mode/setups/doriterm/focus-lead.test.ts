import { expect, test } from "bun:test";
import { focusLead } from "./focus-lead.ts";
import type { Runner } from "../../scripts/src/run.ts";

test("focuses the configured lead's tab, so a new herdr client opens on the lead", async () => {
  // Given: herdr knows the lead pane's tab
  const calls: string[] = [];
  const runner: Runner = async (argv) => {
    calls.push(argv.join(" "));
    return argv[1] === "pane"
      ? { code: 0, out: '{"result":{"pane":{"tab_id":"w1:t3"}}}', err: "" }
      : { code: 0, out: '{"result":{}}', err: "" };
  };
  // When
  await focusLead(runner, "w1:p7");
  // Then: the lead's tab is focused, nothing else
  expect(calls).toEqual(["herdr pane get w1:p7", "herdr tab focus w1:t3"]);
});

test("a failed lead-tab focus is an error, so attach.sh says so and attaches anyway", async () => {
  // Given
  const runner: Runner = async (argv) => argv[1] === "pane"
    ? { code: 0, out: '{"result":{"pane":{"tab_id":"w1:t3"}}}', err: "" }
    : { code: 1, out: "", err: "missing tab" };
  // When
  const result = focusLead(runner, "w1:p7");
  // Then
  await expect(result).rejects.toThrow("Cannot focus lead tab");
});
