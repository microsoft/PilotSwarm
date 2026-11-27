# Workflow re-run from a chosen visit (I7 v1)

`WorkflowRerun.tla` models Workflow Re-run from a Chosen Visit (`I7` v1) ahead of store and runtime implementation. A TLC pass is a bounded check, not a proof.

## Relation to `WorkflowRun.tla`

`WorkflowRerun.tla` **restates** (rather than `INSTANCE`s) the unchanged `1.3.0` controller loop (`AdmitExec`/`AdmitRecord`, `CollectExec`/`CollectRecord`, `FinishExec`/`FinishFailExec`, `PollCommand`, `CancelTx`) of `../WorkflowRun.tla` so it can begin from an atomically copied prefix of completed visits (`reusedSet`) and couple that loop with the two-step Start claim/admission transaction, lock-ordered deleter races, compatibility and cut-guard checks, plan budget subtraction, approval consent gating, carried inbox messages, receive `wait.totalSeconds` reset, and two-generation origin flattening.

## Model-to-code map

### Restated controller actions (`controller/index.ts` & `runtime.ts`)

| Model action | Target symbol / code location | Notes |
|---|---|---|
| `BeginExec` | `runtime.ts › register("begin")`, `runtime.ts › register("plan")` | Transitions `admitted -> running`, starts fresh run deadline, returns `maxNodeExecutions = ir.limits.maxNodeExecutions - rerunUnwalked` (`PlanBudget`). |
| `PollCommand` | `controller/index.ts › controlRun` (command poll & `steps >= plan.maxNodeExecutions` check) | Reads queued cancel/stop commands and enforces lowered `plan.maxNodeExecutions` before each admission. |
| `AdmitExec` / `AdmitRecord` | `runtime.ts › enterNodeActivity`, `store.ts › enterNode`, `controller/index.ts › controlRun` (admission loop) | Idempotent read-only return on copied `completed` rows (zero work started); on first uncopied row enforces `rerun_resume` cut guard before insert (`failCode = "rerun_diverged"` on mismatch); stamps `rerun_resumed_at` atomically with first new row; enforces `MaxVisits` (`exhausted`) and receive total deadline anchor (`readReceiveTotalDeadline`). |
| `StartEffect` | `controller/index.ts › controlRun` (`entered.state === "pending"`) | Dispatches effect/agent/send/request only when admitted `pending`; never runs for copied `completed` rows. |
| `CollectExec` / `CollectRecord` | `runtime.ts › register("collect")`, `controller/index.ts › controlRun` (collection & catch-all routing) | Reads stored outcome, routes via `selectRoute` or catch-all (`HandlerOnce`: `curCaught` set when passing over a reused catch-all). |
| `FinishExec` / `FinishFailExec` | `runtime.ts › register("finish")`, `store.ts › finishRun` | Completes terminal visit or fails run; ends pending nodes atomically. |
| `CancelTx` | `runtime.ts › register("cancel")`, `store.ts › cancelRun` | Ends active run `cancelled` and completes pending nodes with `winner = "cancel"`. |

### Modeled SQL locks (`store.ts`, `session-definition-store.ts`, `migrations/workflow-0088.ts`)

| Model action / lock | Exact SQL lock in code |
|---|---|
| `CopyLockStep1` (`ownerLock = "copy_share"`, `defLock = "copy_share"`) | `session-definition-store.ts › requireSessionStartLocked`: `SELECT ... FROM sessions WHERE session_id = $1 FOR SHARE` followed by `SELECT ... FROM session_workflow_definitions ... FOR SHARE`. |
| `CopyLockStep2` (`srcLock = "copy_share"`, `newLock = "copy_excl"`) | `store.ts › lockSessionPair` inside `store.createDefinition`: locks source (`#2`, `FOR SHARE`) and new Workflow (`#3`, `FOR NO KEY UPDATE`) in ascending `session_id` order. |
| `SweeperLockTarget` / `SweeperCommit` (`srcLock = "sweeper_excl"`) | `store.ts › sweeperSoftDelete`: blocking `SELECT ... FROM sessions WHERE session_id = $1 FOR NO KEY UPDATE` on target `#2`; cascade descendants locked `ORDER BY session_id FOR NO KEY UPDATE NOWAIT` (returns `Busy` if a descendant is held). |
| `DelWfLock` / `DelWfCommit` (`srcLock = "delwf_excl"`) | `store.ts › lockLiveSession`: blocking `SELECT deleted_at FROM sessions WHERE session_id = $1 FOR NO KEY UPDATE`. |
| `OwnerEndLockOwner` / `OwnerEndCommit` (`ownerLock`, then `srcLock`, `newLock`) | `migrations/workflow-0088.ts` owner-session-ended trigger: locks owner row first (`FOR NO KEY UPDATE`), then child Workflow rows (`#2`, `#3`) in ascending `session_id` order. |

*(Full symbol-and-line correspondence against the engine implementation will be recorded in `CORRESPONDENCE-<head8>.md` in Unit 3B.)*

## What is checked

All 42 cases run with `CHECK_DEADLOCK TRUE`:
- **14 design cases** (10 safety + 4 liveness): `CoreSafety`, `Inv_TerminalNoPending`, `Prop_NoAdmissionAfterTerminal`, `Inv_ReusedNeverRuns`, `Inv_ReusedImmutable`, `Inv_SourceUntouched`, `Inv_CopyAtomic`, `Inv_OriginRan`, `Inv_NoCopyFromDeleted`, `Inv_PinnedChoice`, `Inv_NoConsentReuse`, `Inv_FirstNewAtCut`, `Inv_NoWorkOnDiverge`, `Inv_OrdinalsContinue`, `Inv_CatchAllOnce`, `Inv_VisitLimit`, `Inv_StepLimit`, `Inv_TotalFromFirstNew`, `Inv_CarriedWereWaiting`, `Inv_TakeOnce`, plus `Live_ReachesCut` and `Live_Terminates`.
- **13 non-vacuity witnesses** (`wit.rr-*`, each expected violated, exit `12`): proves every critical path (resuming at cut, reused catch-all, failure after reused catch-all, `MaxVisits` exhaustion, pass-over retry, pass-over `continueAsNew`, 2-generation completion, divergence guard, `RERUN_SOURCE_GONE`, source deleted after copy, approval refusal, carried inbox take, pinned claim-crash resume) is reachable.
- **15 deliberate faults** (`rr-df-*`, each expected violated or deadlock, exit `12`): proves each safety invariant and the lock-order deadlock check catches its matching bug.

Generate cases with `python3 gen-cases.py`, verify packet integrity with `./check-packet.sh`, and run TLC with `TLA_TOOLS=<dir> ./run-tlc.sh`.

## Results (batch `rr1`, TLC 2.19, `CHECK_DEADLOCK TRUE` on all 42 cases)

- **Design safety & liveness (14 cases):** 14/14 PASS (largest: `rr.design-loop-run-again` and `rr.live-run-again`, 928,279 generated / 275,524 distinct states, 0 errors, 0 deadlocks).
- **Non-vacuity witnesses (13 cases):** 13/13 VIOLATED as expected (exit 12).
- **Deliberate faults (15 cases):** 15/15 VIOLATED / DEADLOCK as expected (14 invariant violations exit 12; `rr-df-lock-new-before-owner` TLC deadlock exit 11).
- **Total:** 42/42 matched expected, zero timeouts.

