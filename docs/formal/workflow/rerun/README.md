# Workflow re-run from a chosen visit (I7 v1)

`WorkflowRerun.tla` models Workflow Re-run from a Chosen Visit (`I7` v1) ahead of store and runtime implementation. A TLC pass is a bounded check, not a proof.

## Relation to `WorkflowRun.tla`

`WorkflowRerun.tla` **restates** (rather than `INSTANCE`s) the unchanged `1.3.0` controller loop (`AdmitExec`/`AdmitRecord`, `CollectExec`/`CollectRecord`, `FinishExec`/`FinishFailExec`, `PollCommand`, `CancelTx`) of `../WorkflowRun.tla` so it can begin from an atomically copied prefix of completed visits (`reusedSet`) and couple that loop with the two-step Start claim/admission transaction, lock-ordered deleter races, compatibility and cut-guard checks (both `run_again` and `continue`, same-IR input/carry byte check, and copied-coordinate divergence), plan budget subtraction, approval consent gating, carried inbox filtering, receive `wait.totalSeconds` reset, and two-generation `COALESCE` origin flattening.

## Model-to-code map

### Restated controller actions (`controller/index.ts` & `runtime.ts`)

| Model action | Target symbol / code location | Notes |
|---|---|---|
| `BeginExec` | `runtime.ts › register("begin")`, `runtime.ts › register("plan")` | Transitions `admitted -> running`, starts fresh run deadline, returns `maxNodeExecutions = ir.limits.maxNodeExecutions - rerunUnwalked` (`PlanBudget`). |
| `PollCommand` | `controller/index.ts › controlRun` (command poll & `steps >= plan.maxNodeExecutions` check) | Reads queued cancel/stop commands and enforces lowered `plan.maxNodeExecutions` before each admission. |
| `AdmitExec` / `AdmitRecord` | `runtime.ts › enterNodeActivity`, `store.ts › enterNode`, `controller/index.ts › controlRun` (admission loop) | On copied `completed` rows, checks `(predecessor, arrivalRoute)` — matching hits return idempotently with zero work started; mismatches before `rerun_resumed_at` call `failRerunDiverged` (`rerun_diverged`). On first uncopied row enforces `rerun_resume` cut guard (coordinates + same-IR & same-KV input/carry byte check, skipped on `fix_chosen` or `StartVars`) before insert; stamps `rerun_resumed_at` atomically with first new row; enforces `MaxVisits` (`exhausted`) and receive total deadline anchor (`readReceiveTotalDeadline`). |
| `StartEffect` | `controller/index.ts › controlRun` (`entered.state === "pending"`) | Dispatches effect/agent/send/request only when admitted `pending`; never runs for copied `completed` rows. |
| `CollectExec` / `CollectRecord` | `runtime.ts › register("collect")`, `controller/index.ts › controlRun` (collection & catch-all routing) | Reads stored outcome, routes via `selectRoute` or catch-all (`HandlerOnce`: `curCaught` set when passing over a reused catch-all). |
| `FinishExec` / `FinishFailExec` | `runtime.ts › register("finish")`, `store.ts › finishRun` | Completes terminal visit or fails run; ends pending nodes atomically. |
| `CancelTx` | `runtime.ts › register("cancel")`, `store.ts › cancelRun` | Ends active run `cancelled` and completes pending nodes with `winner = "cancel"`. |

### Modeled SQL locks (`store.ts`, `session-definition-store.ts`, `cms.ts`, `migrations/workflow-outcome-retention-0096.ts`)

| Model action / lock | Exact SQL lock in code |
|---|---|
| `CopyLockStep1` (`ownerLock = "copy_share"`, `defLock = "copy_share"`) | `session-definition-store.ts › requireSessionStartLocked`: `SELECT ... FROM sessions WHERE session_id = $1 FOR SHARE` followed by `SELECT ... FROM session_workflow_definitions ... FOR SHARE`. |
| `CopyLockSrc` -> `CopyLockStep2` (`srcLock = "copy_share"`, then `newLock = "copy_excl"`) | `store.ts › lockSessionPair` inside `store.createDefinition`: sequentially locks `#2` (`FOR SHARE`) and `#3` (`FOR NO KEY UPDATE`) in `sessionPairLockOrder` (`session_id ASC`). |
| `SweeperLockTarget` / `SweeperCommit` (`srcLock = "sweeper_excl"`) | `store.ts › sweeperSoftDelete`: blocking `SELECT ... FROM sessions WHERE session_id = $1 FOR NO KEY UPDATE` on target `#2`; cascade descendants locked `ORDER BY session_id FOR NO KEY UPDATE NOWAIT` (returns `Busy` if a descendant is held). |
| `DelWfLock` / `DelWfCommit` (`srcLock = "delwf_excl"`) | `management-client.ts › deleteSession / _forceDeleteSession` -> `cms.ts › softDeleteSession` -> `cms_soft_delete_session`: blocking `UPDATE` on `#2`'s `sessions` row (preceded by a separate autocommit `updateSession(state: "failed")` before the soft delete; only the blocking soft-delete lock is modeled here). |
| `OwnerEndLockOwner` -> `OwnerEndLockDef` -> `OwnerEndCommit` (`ownerLock`, then `defLock`, then `srcLock`, `newLock`) | `migrations/workflow-outcome-retention-0096.ts › workflow_on_owner_session_ended` (owner-deleted branch): locks owner row (`UPDATE sessions`), updates `session_workflow_definitions` (`defLock`), then locks child Workflow rows (`#2`, `#3`) in ascending `session_id` order. *(The owner-completed/failed branch cancels active child runs without soft-deleting ended `#2`; only the stronger owner-deleted branch is modeled here. Phase 2 Unit F's definition delete will be added to the lock model at the pre-3B rebase.)* |

*(Full symbol-and-line correspondence against the engine implementation will be recorded in `CORRESPONDENCE-<head8>.md` in Unit 3B.)*

## Mechanism-level vs specification-level invariants

- **Mechanism-level checks (verified by interleavings, guards, and state transitions in `WorkflowRerun.tla`):**
  Lock-order deadlock freedom (`CHECK_DEADLOCK TRUE` across `Copy`, `SweeperDirect`, `DeleteWorkflow`, `OwnerEnded`), `Inv_NoCopyFromDeleted` (read-then-commit window without `FOR SHARE`), `Inv_CopyAtomic`, `Inv_ReusedNeverRuns`, `Inv_ReusedImmutable`, `Inv_FirstNewAtCut` (run-again, continue, same-IR byte check, `fix_chosen` & `StartVars` exemptions), `Inv_ValidNeverDiverges` (guard never blocks valid or exempt re-runs), `Inv_PassOverOnChain` (S1 copied-row route/predecessor check), `Inv_NoWorkOnDiverge`, `Inv_OrdinalsContinue`, `Inv_CatchAllOnce`, `Inv_VisitLimit`, `Inv_StepLimit`, `Inv_TotalFromFirstNew`, `Inv_TakeOnce`, `CoreSafety`, `Inv_TerminalNoPending`, `Prop_NoAdmissionAfterTerminal`, and strong liveness `Live_ReachesCutOnly` (`<>resumedAtCut`, no divergence disjunct) / `Live_DivergesCleanly` / `Live_Terminates`.
- **Specification-level restatements (checked structurally here; code-level mechanism evidence lives in Unit 3B integration tests):**
  - `Inv_SourceUntouched`: models zero writes to `#2`'s rows; code-level ID separation (`nodeExecutionIdFor(newRunId, ...)`) and source-row immutability are verified by Unit 3A `workflow-rerun-plan.test.mjs` and Unit 3B `workflow-rerun-store.test.js`.
  - `Inv_OriginRan`: models `COALESCE` flattening over static `SrcReusedFrom`; multi-generation SQL `COALESCE` provenance is verified by Unit 3A `flattenRerunOrigin` tests and Unit 3B `workflow-rerun-store.test.js`.
  - `Inv_CarriedWereWaiting`: models the `accepted_at <= cutTime \/ WorkflowEnded@1` filter over a static inbox; SQL timestamp/consumption/TTL selection (`copyRerunInboxIn`) is verified by Unit 3B `workflow-rerun-store.test.js`.
  - `Inv_PinnedChoice`: models `rerunPin` preservation across claim crash; JSON pin persistence and `replaySessionStart` recovery are verified by Unit 3B `workflow-rerun-start.test.js` (Task 4d).
  - `Inv_NoConsentReuse`: models owner-only gating past answered approvals; `(owner_provider, owner_subject)` matching, owner-change refusal, and fail-closed missing-approval checks are verified by Unit 3B `workflow-rerun-start.test.js` (Task 4d).
  - `Inv_AutoPickNoCancelledReuse`: models G-R1's scan/lift/earliest-index specification over `CandSpawnTop \cup CandSpawnLanes` and the `ReqModeContinue` scope (`AutoPicked /\ ~ReqModeContinue`); full algorithmic multi-spawn/multi-lane scanning and explicit-`continue` warning behavior are verified by `workflow-rerun-plan.test.mjs` (Unit 3A-Supply) and `workflow-rerun-store.test.js` / `workflow-rerun-leak-census.test.js` (Unit 3B).

## What is checked (batch `rr4`, 94 cases, `CHECK_DEADLOCK TRUE` on all cases)

- **44 design cases** (26 safety + 18 liveness):
  - 27 baseline `rr3` cases (15 safety + 12 liveness) plus 17 Unit `3A-Supply` cases covering `Mode = "supply"` (`rr.design-supply-loop`, `rr.design-supply-first` with `0` reused visits, `rr.design-supply-to-terminal`, `rr.design-supply-diverge` [`S2f`], `rr.design-supply-refused-approval`, `rr.design-supply-refused-never`), `G-R1` top-level & parallel-lane spawn cut-back plus explicit-`continue` opt-out (`rr.design-gr1-top-spawn`, `rr.design-gr1-lane-spawn`, `rr.design-gr1-explicit-continue`), the `R2-M1` observable Sweeper-vs-admission & late-retry race (`rr.design-sweeper-admission-race` and `rr.design-sweeper-admission-owner-race` combining `AllowOwnerEnd` + `AllowShellSweeper`, zero `startPhase` oracle guards, `AdvanceClaimGrace` in any pre-admission phase, `SweeperReadBareShell` + `SweeperCollectClaimShell` under `newLock`, `CopyLockStep2` refusing `refused_workflow_deleted` under `newLock`), plus `Inv_AdmittedNotSwept`, `Prop_SweepRequiresLockAndNoRun`, `Inv_QuiescentNoLive`, and `Live_Quiesces == <>Quiescent` across 6 new liveness cases.
- **21 non-vacuity witnesses** (15 baseline + 6 Unit `3A-Supply`: `wit.rr-no-supply-downstream-read`, `wit.rr-no-supply-first-visit`, `wit.rr-no-supply-to-terminal`, `wit.rr-no-supply-refused-step-type`, `wit.rr-no-leak-quiescence`, and `wit.rr-no-late-retry-after-sweep`; each expected violated, exit `12`).
- **29 deliberate faults** (18 baseline + 10 required Unit `3A-Supply` faults + 1 extra lane-spawn `G-R1` fault `rr-df-gr1-lane-skip`: `rr-df-supply-on-approval`, `rr-df-starts-supplied`, `rr-df-supply-undeclared-outcome`, `rr-df-ignores-supply-never`, `rr-df-supply-no-note`, `rr-df-retry-changes-supplied`, `rr-df-gr1-skip`, `rr-df-gr1-lane-skip`, `rr-df-skip-parent-end-cancel`, `rr-df-refused-shell-not-deleted`, and `rr-df-sweeper-deletes-active-claim` [keeps grace enabled and removes only `newLock` / under-lock re-check -> `VIOLATION:Inv_AdmittedNotSwept`]; 28 invariant violations exit `12` + `rr-df-lock-new-before-owner` TLC deadlock exit `11`).

Generate cases with `python3 gen-cases.py`, verify packet integrity with `./check-packet.sh`, and run TLC with `TLA_TOOLS=<dir> ./run-tlc.sh`.

## Results (batch `rr4`, TLC 2.19, `CHECK_DEADLOCK TRUE` on all 94 cases)

- **Design safety & liveness (44 cases):** 44/44 PASS (largest: `rr.design-loop-run-again` and `rr.live-run-again`, 2,732,288 generated / 757,316 distinct states, 39 s safety / 220 s liveness; largest new supply case: `rr.design-supply-loop`, 1,185,985 generated / 333,662 distinct states, 19 s; `rr.design-gr1-top-spawn`: 44,892 distinct states, 4 s; `rr.design-gr1-lane-spawn`: 17,172 distinct states, 3 s; `rr.design-gr1-explicit-continue`: 1,467 distinct states, 1 s; `rr.design-sweeper-admission-race`: 11,376 distinct states, 3 s; `rr.design-sweeper-admission-owner-race`: 3,265 distinct states, 1 s; 0 errors, 0 deadlocks).
- **Non-vacuity witnesses (21 cases):** 21/21 VIOLATED as expected (exit 12).
- **Deliberate faults (29 cases):** 29/29 VIOLATED / DEADLOCK as expected (28 invariant violations exit 12; `rr-df-lock-new-before-owner` TLC deadlock exit 11).
- **Total:** 94/94 matched expected, zero timeouts, 394 s total elapsed.

