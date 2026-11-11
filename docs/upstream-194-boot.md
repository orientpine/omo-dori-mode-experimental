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

## #149 strict tooling audit (no port)

Current-main evidence: fork PR #388 already ported the strict TypeScript flags, Biome lint, knip, and LOC checks. `package.json` runs them through `ci`, and every prerequisite run above exercised them. The formatter remains deliberately excluded by the earlier owner decision; no mass formatting or tooling rewrite was made. **Verdict: DONE, evidence only.**

## #159 split and worklog-rendering audit (no duplicate port)

Current-main evidence: fork PR #402 already applied the split discipline, `check-loc.ts` enforces it, `worklog.ts` already owns rendering, and the session runtime/listing behavior is tested. New boot code used the approved `boot.ts`/`boot-monitors.ts` and split-test layout from the start, so no later structural rewrite was needed and no duplicate `worklog-render.ts` was created.

Verification: `worklog.test.ts`, `worklog-records.test.ts`, and `session-runtime.test.ts` completed with **27 pass, 0 fail**, and `bun run lint:loc` printed `LOC_OK 369 files`. **Verdict: DONE, evidence only.**

## #194 drift and workspace checks

The refreshed upstream diff remained unchanged at head `e8d62d60b958dd12c90c36dcc3f5533c58302859`; the exact commit was fetched for source and NOTICE.

Red reproduction after all prerequisites: **46 pass, 8 fail** across the six new boot-check cases and the updated boot/journal expectations.

Implementation: `boot-checks.ts` adds `workspaceCheck` and `driftCheck`. Workspace and group-filter mismatches print `CONFIG_WARN` and fail boot on herdr and hc. Open, non-closed lanes missing from the session list are probed through the existing runtime; confirmed-gone lanes are counted in `DRIFT n=...`, while probe failures are named separately and fail boot without being counted. Boot calls the checks after reconciliation and before journals. Existing runtime, worklog, and monitor code is reused.

Verification: **54 pass, 0 fail** across all boot and session-runtime files, with strict typecheck exit 0. The six cases cover laneWorkspace omission, live-agent mismatch, covering/empty filters, herdr drift with closed/live exclusions, hc drift with no workspace warning at that stage, and probe failure. The updated boot test allows only `pane list`/`pane get`, and the journal cases keep a silent lane on a live pane.

All four mutation checks failed on their intended assertions: laneWorkspace warning removal (4 pass / 2 fail), live-agent coverage removal (5 pass / 1 fail), drift never counted (4 pass / 2 fail), and hc incorrectly treated as having workspaces (5 pass / 1 fail). The restored source is byte-identical and the six cases pass again.

The final full CI completed with **2032 pass, 0 fail** and `LOC_OK 371 files`.

Real-CLI QA in `/home/soodori/.soodori/qa/port-upstream-194` passed all eight scenarios: herdr drift/config mismatch, live-agent mismatch, covering filter, empty filter, hc drift without workspace warnings, herdr probe failure, empty-state read-only boot, and report CLI persistence. The artifacts include command lines, stdout/stderr, exit codes, runtime argv logs, state hashes, and the report journal. Only list/get probes occurred and every boot state hash stayed unchanged.

Documentation and NOTICE name the new output, non-zero exit, and upstream head.

## Fork PR 436 review round 1

The reviewed head `0bf0f6cf` received seven BLOCK findings. Failing-first evidence is under `/tmp/tmp.YSFgdiewgX/review-436-r1`: hc/aoe boot **16 pass / 4 fail**, freshness/lifecycle **1 pass / 9 fail**, and Slack deadline **3 pass / 2 fail**. The spawned Slack CLI was killed by its outer 15-second bound before the fix.

Implementation: hc workspace checks use the fork's `dori.group`-aware listing and canonical `hc:t1` refs compare runtime plus id. aoe/tmux sessions join read-only reconciliation and gone probes. Stalled structured lanes suppress only nudges/report relays while supervision, compaction recovery, handover resumption, and rollover checks continue. Journal filesystem errors carry their OS code into the existing lane-scoped error path. Reopen/object transitions append running activity so a historical done report no longer terminates boot or supervision. Slack auth passes an abort signal into its request and clears retry sleeps at the deadline.

Verification: the touched owner and adjacent suites completed with **258 pass, 0 fail**, including matching/mismatching hc groups, live/vanished aoe, stalled maintenance through `freshnessTick`, two-lane EISDIR isolation, done→reopen/object→boot/supervision, and real spawned-process Slack termination at 10 seconds with exit 1 and no signal. Strict TypeScript passed. The first full CI exposed a test-only tmux fake compatibility change and the Slack test's default five-second budget; those were corrected without changing production behavior. The final full CI completed with **2072 pass, 37 pre-existing skips, 0 fail** across 2109 tests in 167 files, with Biome, strict typecheck, knip, and `LOC_OK 377 files`.

## Fork PR 436 review round 2

The next reviewed head `89d24b84` received five follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r2/second-review-red.log` shows **39 pass / 10 fail**: hc lead and ignored terminals miscounted, mixed-runtime lead missing, failed aoe/tmux listing still producing vanished and drift, three tmux execution/connection failures counted as gone, and a readable nonwritable journal aborting the second lane.

Implementation: exclusions use runtime-plus-ID identities; the configured lead's runtime is required in listing; combined panes are published only after all required listings succeed; boot-specific aoe listing checks `tmux ls` errors and its probe treats only an explicit not-found answer as gone; append failures carry the same `ReportError` OS code as read failures. Round-one behavior is unchanged.

Verification: all round-one and round-two owner and adjacent suites completed with **267 pass, 0 fail** across 14 files. The cases separately cover excluded-only and covered-excluded/uncovered-agent hc configurations, mixed hc selection with a herdr lead, failed aoe and tmux listings without vanished verdicts, executable/socket/not-found distinctions, and readable/nonwritable two-lane journals. Strict TypeScript passed. The final full CI completed with **2081 pass, 37 pre-existing skips, 0 fail** across 2118 tests in 167 files, with Biome, strict typecheck, knip, and `LOC_OK 377 files`.

## Fork PR 436 review round 3

The next reviewed head `86cfc371` received three follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r3/third-review-red-2.log` shows **0 pass / 4 fail**: an hc start failure left a provisional lane and initial journal, a paused structured lane appended stalled activity, and both running→blocked and running→stalled sweeps used pre-supervision progress for notifications.

Implementation: an unsuccessful non-aoe open rolls back only the provisional registry file and activity journal created by `beforeStart`, allowing retry while preserving genuinely started lanes. Paused and other ineligible statuses are skipped before journal observation. Working-lane notification gates reread the journal after supervision; blocked lanes receive no nudge but keep their blocker relay, while stalled lanes receive neither a nudge nor a relay.

Verification: all prior and new owner and adjacent suites completed with **295 pass, 0 fail** across 17 files. The launch case proves cleanup and successful retry, the paused case proves no acts and a byte-identical journal, and the transition cases cross their notification thresholds in the same sweep. Strict TypeScript passed. LOC is preserved by moving the supervision helper to `freshness-progress.ts` and keeping the three notification regressions in `freshness-notifications.test.ts`. The final full CI completed with **2085 pass, 37 pre-existing skips, 0 fail** across 2122 tests in 168 files, with Biome, strict typecheck, knip, and `LOC_OK 379 files`.

## Fork PR 436 review round 4

The next reviewed head `98e0c619` received three follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r4/fourth-review-red-2.log` shows **1 pass / 5 fail**: ambiguous send and still-live cleanup outcomes were deleted, an initial append failure left registration and terminal state, and an aoe lead alone was neither discovered nor allowed to surface discovery failure.

Implementation: `HcStartupError` carries a rollback decision through `openHerdr`. Only a definite send failure with a probe-confirmed gone terminal permits rollback; ambiguous send and uncertain or still-live cleanup preserve tracking. Registration is recorded before the journal append, and a failed pre-start callback closes the new terminal before unwind. Boot includes a configured aoe lead in required discovery.

Verification: all prior and new owner and adjacent suites completed with **319 pass, 0 fail** across 20 files, including hc close and handover owners. The four launch cases separately prove definite+cleaned retry, ambiguous preservation, still-live preservation, and append-failure cleanup with successful retry. The boot cases prove live aoe lead discovery with herdr/hc lanes and explicit discovery failure without a vanished verdict. Strict TypeScript passed. The final full CI completed with **2090 pass, 37 pre-existing skips, 0 fail** across 2127 tests in 169 files, with Biome, strict typecheck, knip, and `LOC_OK 380 files`.

## Fork PR 436 review round 5

The next reviewed head `33d815aa` received two follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r5/fifth-review-red-2.log` and `journal-read-red.log` shows **2 pass / 3 fail**: definite herdr rejection and append failure left provisional state, and a journal directory without execute permission was reported as absent.

Implementation: `HerdrStartupError` mirrors the hc outcome through `openHerdr`. A definite pane-run rejection rolls back only after `closeHerdrSession` and a gone probe confirm cleanup; timeout/transport ambiguity and unconfirmed cleanup preserve registration. A failed pre-start callback closes the new terminal before unwind. `Reports.read` now reads directly, returning null only for `ENOENT` and wrapping every other filesystem failure as `ReportError` with its OS code.

Verification: all prior and new owner and adjacent suites completed with **324 pass, 0 fail** across 21 files. Four herdr launch cases separately prove definite+cleaned retry, ambiguous preservation, unconfirmed-cleanup preservation, and append-failure cleanup with retry. The boot case proves a directory without execute permission is lane-scoped `JOURNAL-ERROR ... kind=EACCES` while the other lane continues. Strict TypeScript passed. The final full CI completed with **2095 pass, 37 pre-existing skips, 0 fail** across 2132 tests in 170 files, with Biome, strict typecheck, knip, and `LOC_OK 381 files`.

## Fork PR 436 review round 6

The next reviewed head `a9a0ee67` received two follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r6/sixth-review-red.log` and `retired-runtime-red.log` shows **0 pass / 3 fail**: malformed JSON and unexpected EOF deleted registration, and a closed herdr lane made a healthy hc boot fail when herdr was unavailable.

Implementation: herdr rollback now requires a positively identified pre-execution refusal; SyntaxError and unknown outcomes default to ambiguous. Runtime discovery distinguishes required non-closed/selected/lead runtimes from optional retired runtimes. Optional discovery still runs for historical reconciliation but its failure is skipped instead of discarding the healthy listing.

Verification: all prior and new owner and adjacent suites completed with **327 pass, 0 fail** across 21 files. The startup cases prove malformed/EOF preservation after cleanup, and the boot case proves optional herdr discovery is attempted, its failure does not produce PANES unavailable, and the closed record produces neither VANISHED nor DRIFT while hc remains live. Strict TypeScript passed. The final full CI completed with **2098 pass, 37 pre-existing skips, 0 fail** across 2135 tests in 171 files, with Biome, strict typecheck, knip, and `LOC_OK 382 files`.

## Fork PR 436 review round 7

The next reviewed head `f8e4e8ae` received two follow-up BLOCK findings. Failing-first evidence in `/tmp/tmp.YSFgdiewgX/review-436-r7/seventh-review-red.log` and `relay-red.log` shows the bare footer command lacking config/state and the first post-supervision blocker becoming `no-report`; the stale milestone payload was also confirmed by the exact lead-text assertion.

Implementation: launch renders the report command with `env DORI_CONFIG=<originating config> DORI_STATE_DIR=<originating stateDir>`, without forwarding `DORI_ENV_FILE` into shared runtime command lines. Structured relay now renders `progress.lastReport` after the supervision reread, so it quotes the current blocker instead of the pre-supervision milestone and works when the journal began with activity only.

Verification: all prior and new owner and adjacent suites completed with **357 pass, 0 fail** across 27 files. The spawned-CLI case starts with no DORI selectors, uses an unrelated cwd and writes only into the non-default state's journal. The transition cases assert the actual lead text for a replaced milestone and for supervision's first blocker. Strict TypeScript passed. The final full CI completed with **2100 pass, 37 pre-existing skips, 0 fail** across 2137 tests in 172 files, with Biome, strict typecheck, knip, and `LOC_OK 383 files`.
