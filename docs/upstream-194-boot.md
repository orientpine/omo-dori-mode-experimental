# Upstream boot port evidence (Q28 / PR #194)

Owner scope: port the complete upstream `dori boot` prerequisites in chronological order, then upstream PR #194. Each stage first compares current-main behavior and tests. Existing behavior is evidence-only and is not ported again. Only the lead reviews and merges the fork PR.

## Prerequisite audit

| Order | Upstream source | Current-main audit | Result |
|---|---|---|---|
| 1 | [#30 durable lane reports](https://github.com/sisyphuslabs/dori-superagent/pull/30) | No `reports.ts`, `reportProtocol`, report CLI, launch journal, or journal-backed freshness; `supervision.ts` explicitly says #30 was not ported. | Gap: port journal, CLI, launch, and protocol-gated freshness. |
| 2 | [#37 read-only boot](https://github.com/sisyphuslabs/dori-superagent/pull/37) | `handover.ts` and `references/scripts.md` say this fork has no `dori boot`; no partial `Registry.scan` or boot command/tests exist. | Gap: port boot orchestration and tests. |
| 3 | [#61 supervision and report activity](https://github.com/sisyphuslabs/dori-superagent/pull/61) | Fork-native supervision and tests exist, but no report-journal integration exists. | Port only the journal-aware #61 behavior. |
| 4 | [#72 finished rule and safe journal errors](https://github.com/sisyphuslabs/dori-superagent/pull/72) | No boot finished predicate or boot journal error handling exists. | Gap: port the boot-specific changes. |
| 5 | [#96 worklog](https://github.com/sisyphuslabs/dori-superagent/pull/96) | Worklog storage, rendering, CLI, and tests already exist in `worklog.ts` and `worklog*.test.ts`; boot output is absent. | Keep storage; add only boot worklog output. |
| 6 | [#149 strict tooling](https://github.com/sisyphuslabs/dori-superagent/pull/149) | Fork PR #388 and current `package.json`, `tsconfig.json`, Biome, knip, and LOC checks already cover it. | Evidence only; no tooling port. |
| 7 | [#154 session runtime](https://github.com/sisyphuslabs/dori-superagent/pull/154) | Fork PR #393, `session-runtime.test.ts`, runtime implementations, `sessionRef`, `listSessions`, and probes already cover runtime behavior. Boot wiring and `reconcile.ts` are absent. | Keep runtime; add only boot runtime wiring/reconciliation. |
| 8 | [#159 250-line splits](https://github.com/sisyphuslabs/dori-superagent/pull/159) | Fork PR #402 and the current LOC check already cover the splits; worklog rendering already lives in `worklog.ts`. | Evidence only. New boot files use the split layout; no duplicate `worklog-render.ts`. |
| 9 | [#194 boot drift and workspace checks](https://github.com/sisyphuslabs/dori-superagent/pull/194) | No `boot-checks.ts`, `DRIFT`, or `CONFIG_WARN` exists. | Gap: port after the full boot base is green. |

## #30 durable lane reports

Red reproduction on the unchanged base, before production edits:

```sh
env -u DORI_STATE_DIR -u DORI_CONFIG DORI_ENV_FILE=/tmp/tmp.YSFgdiewgX/empty.env \
  bun test --timeout 30000 \
  ./test/reports.test.ts ./test/reports-freshness.test.ts \
  ./test/report-launch.test.ts ./test/report-cli.test.ts
```

Result: **0 pass, 6 fail**. The three journal test files could not import `reports.ts`; the three spawned-CLI cases failed because `report` was not implemented.

Implementation: durable JSONL reports and activity, sanitized report output, report CLI and validation, pre-prompt launch registration/journal seed on both backends, and `jsonl-v1`-gated freshness. Adopted and legacy lanes retain the transcript path. Freshness tells the lead rather than auto-posting to the owner's thread, preserving this fork's policy.

Verification after implementation:

- The same four test files: **37 pass, 0 fail**.
- `bun run typecheck`: exit 0.
- Launch regressions prove the activity journal exists before the first prompt on both aoe and herdr.
- Real CLI regressions prove durable output plus invalid-kind and unknown-lane refusal without journal writes.

Full gate: `bun run ci` completed with **1986 pass, 0 fail**. Biome, strict typecheck, and knip succeeded, and the LOC gate printed `LOC_OK 357 files`. The heavy runner recorded that this repository's suite must run locally and completed it in its own scope.

## #37 read-only boot

Red reproduction after #30 and before boot production files: **0 pass, 5 fail** across `boot.test.ts`, `boot-monitors.test.ts`, `boot-slack.test.ts`, `boot-journals.test.ts`, and `boot-metadata.test.ts`, because the boot modules and command did not exist.

Implementation: non-creating full and partial registry reads, boot orchestration, journal reporting, pane reconciliation, monitor-manifest discovery and cleanup instructions, bounded Slack auth, real CLI dispatch, and command documentation. The approved split layout keeps `boot.ts` and `boot-monitors.ts` under the current LOC rule; `registry-scan.ts` owns directory reads without changing the registry's public API.

Verification: all five files passed **24 pass, 0 fail**, including the spawned-CLI `PI_SESSION_DIR`/`PI_SESSION_FILE` metadata case and read-only state snapshots. Later #72, #96, and #154 assertions are intentionally added only in their own stages.

The first full CI run caught two legacy-session regressions (**2008 pass, 2 fail**): existing tests use `Registry.list()` to create `lanes/` before writing legacy records. The fix preserves that established `list()` behavior while keeping boot's `scan()` non-creating; no existing test was edited. The focused rerun passed **38 pass, 0 fail** with strict typecheck green. The final full CI after the fix completed with **2010 pass, 0 fail** and `LOC_OK 366 files`.

## #61 journal-aware supervision

Red reproduction after #37: **19 pass, 4 fail** in the journal-supervision and observation tests. Supervision produced no blocker or stalled journal event, and observation did not implement the #61 resume rule.

Implementation: `Reports.observe` gains the #61 `resumeOnWorking` behavior, with `Running` deliberately excluded. For launched `jsonl-v1` lanes only, supervision includes durable reports in its activity signature, appends ceiling blockers and stalled/running activity, and recomputes its observation afterward so its own blocker is not mistaken for agent progress. Existing lead alerts, cost readings, checkpoint/file accounting, and adopted/legacy supervision behavior remain intact.

Verification: **70 pass, 0 fail** across the new tests and every adjacent supervision suite, with strict typecheck exit 0. The cases cover ceiling blockers, one-time stalls, fresh-report recovery, checkpoint-driven running activity, the Working-only resume rule, and legacy-lane gating. Existing tests cover file activity and declared terminal intent. The final full CI completed with **2016 pass, 0 fail** and `LOC_OK 367 files`.

## #72 finished lanes and safe journal errors

Red reproduction after #61: **15 pass, 4 fail**. A journal-done lane was still shown as vanished and its watch was not cleaned up, and journal failures printed filesystem paths.

Implementation: the shared `finished` predicate accepts `reportState === "done"` in addition to closed and verified-done, so VANISHED and monitor cleanup use the same rule. Journal errors now print `kind=invalid-journal`, the operating-system error code, or `kind=unreadable`; state-directory paths are not exposed.

Verification: **19 pass, 0 fail** with strict typecheck and clean no-excuse/junk-test audits. The tests prove the finished rule in both boot paths and verify invalid-journal and EISDIR errors without a state path. The final full CI completed with **2018 pass, 0 fail** and `LOC_OK 367 files`.

## #96 boot worklog output

Current-main audit: worklog storage, rendering, CLI, handover output, and their tests already existed, so no storage or renderer was ported again. The only gap was boot output.

Red reproduction after #72: **0 pass, 5 fail** in `boot-worklog.test.ts`; boot printed no open-item count, damage state, or unreadable-worklog failure.

Implementation: `BootDeps` includes the existing `Worklog`, and boot prints `WORKLOG open=N` plus `OPEN` lines after journals and before monitor cleanup. Damaged records fail boot; torn writes, duplicate closes, and post-close warnings retain their existing semantics. The real CLI constructs the same dependency, and SKILL.md/scripts.md document the behavior.

Verification: **44 pass, 0 fail** across all boot files and the existing worklog suites, with clean no-excuse/junk-test audits. Cases cover open items and next steps, closed-item omission, garbage and unreadable input, torn writes, duplicate closes, and read-only state snapshots. The final full CI completed with **2023 pass, 0 fail** and `LOC_OK 368 files`.

## #154 session-runtime boot wiring

Current-main audit: fork PR #393 and `session-runtime.test.ts` already cover runtime choice, stored refs, listing, and probes. No runtime or sync code was ported again. The only gaps were boot's runtime wiring and `reconcile.ts`.

Red reproduction after #96: **37 pass, 5 fail** across runtime-first output, unavailable-runtime failure, reconciliation, failed-list handling, and the real CLI message.

Implementation: boot prints `RUNTIME <kind> (from <source>)` first and exits immediately with a fix when the runtime is unavailable. It uses the existing `ChosenRuntimes`/`listSessions`, and the new `reconcile.ts` compares `sessionRef` identities through the existing `sessionOf`/`formatRef`. No runtime implementation changed.

Verification: **48 pass, 0 fail** across all boot files and the existing session-runtime suite, with strict typecheck and clean no-excuse/junk-test audits. A direct probe confirmed the runtime identities. The final fixtures use valid herdr refs, exact watch-token panes, and an explicitly unassigned adopted lane. The final full CI completed with **2026 pass, 0 fail** and `LOC_OK 369 files`.

Later prerequisite results are recorded in the sections that follow.
