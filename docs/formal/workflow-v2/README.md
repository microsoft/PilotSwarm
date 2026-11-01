# Workflow v2 run model

`WorkflowV2Run.tla` models one workflow v2 run as the code in
`packages/sdk/src/workflow/v2` implements it: the controller orchestration,
one effect orchestration per script node execution, the PostgreSQL store
transitions and deletion of the workflow session. It is derived from the
code in the same commit as this file. Line numbers below refer to that commit.

The model checks durable-history and transaction boundaries, crashes,
retries, lost and duplicate wakes, cancellation, deletion and effect death.
It does not check the compiler, schemas, bindings or tool authorization;
real PostgreSQL and runtime tests cover those (see "Regressions").

## Switches

Each fix switch selects one code change. All fix switches FALSE is the
reviewed commit `63c8013b`; all TRUE is this commit.

| Constant | Kind | Code |
|---|---|---|
| `LoseWake` | fault | The effect's `wake` activity exhausts its retries. |
| `ControllerFaults` | fault | A controller activity exhausts its retries; `workflowV2Controller` catches and fails the run. |
| `EffectFaults` | fault | A worker crash re-runs `runScript` (at-least-once), or the effect orchestration ends without storing a result. |
| `Backstop` | fix | The controller waits with `race(dequeueEvent, timer)` and re-collects on the timer. |
| `CancelStopFromStore` | fix | The cancel activity reads every `winner = 'cancel'` node from the store on each execution. |
| `DeleteGuard` | fix | Migration 0085 deletion trigger; every v2 transaction locks the session row first; `claimScriptEntry`; the running script's liveness check. |
| `EndPending` | fix | `finishRun` completes every pending node execution in the transaction that ends the run. |
| `EffectWatch` | fix | The collect activity fails a pending script node whose effect orchestration has ended. |
| `NoCas` | deliberate fault | Node completion overwrites instead of compare-and-swap. |

## Action to code

`R` is `packages/sdk/src/workflow/v2/runtime.ts`, `S` is `store.ts` in the
same folder, `V` is `service.ts`, `M` is
`packages/sdk/src/migrations/workflow-v2-0085.ts`, `C` is
`packages/sdk/src/cms.ts`. "Exec" is the activity body and its store
transaction; "Record" is the controller resuming with the recorded result.
A crash between them re-executes Exec; every Exec is idempotent or
compare-and-swap.

| Model action | Code | Boundary |
|---|---|---|
| `Init` | `S` `createDefinition` 475, `insertRun` 439 | Run row `admitted` committed with the definition and receipt. |
| `Dispatch` | `V` `dispatchWorkflowV2Run` 91 | After admission commit; a deletion may commit before it. The controller start is idempotent by instance id. |
| `BeginExec` / `BeginRecord` | `R` 326 (call), 576 (activity); `S` `beginRun` 702 | Session row lock, then run lock; `admitted -> running` only if the session is live. |
| `AdmitExec` / `AdmitRecord` | `R` 361 (call), 605 (activity); `S` `enterNode` 720 | Session and run locks; insert by deterministic id from history (scope, node, ordinal); idempotent on retry. |
| `StartEffect` | `R` 369 | `ctx.startOrchestrationVersioned`; instance id derived from the node execution id. |
| `CollectExec` / `CollectRecord` | `R` 377 (call), 660 (activity), 679 (effect watch); `S` `readCompletedNodes` 839 | Reads stored winners of the history-selected pending ids only. |
| `WaitMsg` / `WaitTimer` | `R` 403-409 | One durable `race`; an already queued message wins; a wake is only a hint. |
| `FinishExec` / `FinishFailExec` / `FinishRecord` | `R` 298 (finishRun), 366, 698 (activity); `S` `finishRun` 851 | Session and run locks; run end, terminal node and pending nodes in one transaction. |
| `NotifyExec` / `NotifyRecord` | `R` 304, 810 | At-least-once; stable client message id. |
| `CancelTx` | `R` 411 (call), 771-786 (activity); `S` `finishRun` 851 | Run `cancelled` and pending nodes `winner = 'cancel'` in one transaction. |
| `CancelStop` | `R` 787-803; `S` `listCancelledNodeIds` 832 | After the commit; not transactional with it. |
| `CancelCrash` | `R` 771 | Activity retry re-executes the whole body. |
| `CancelRecord` | `R` 411-418 | Controller resumes with the recorded result. |
| `ControllerFault` | `R` 310-319 | `controlRun` throws; the catch fails the run. |
| `EffClaim` | `R` 447 (call), 839 (activity), 852; `S` `claimScriptEntry` 784 | Session, run and node locks; claim only a pending node of an active run of a live session. |
| `EffComplete` | `R` 874-901, `scriptResult` 939 | Script result enters the effect history before it is stored. |
| `EffStopDecided` | `R` 866-876, 900; `S` `isNodePending` 799 | Polling liveness check; stops the script when its node is decided elsewhere. |
| `EffCrash` | `R` 447 | Activity re-dispatch after a worker crash. |
| `EffDie` | `R` 451 | Record activity exhausts retries, or the effect instance is terminated. |
| `EffRecord` | `R` 451 (call), 904 (activity); `S` `completeNode` 808 | Session lock, then compare-and-swap from `pending`; loser reads the stored winner. |
| `EffWake` / `EffWakeDup` / `EffWakeLost` | `R` 452 (call), 925 (activity) | Enqueue to the controller queue only for an active run. |
| `SendCancel` | `management-client.ts` `sendCommand` | Command enqueued to the controller queue. |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `M` trigger 179-208 | Soft delete, definition tombstone, run cancel and pending nodes `winner = 'delete'` in one transaction. |

`Writable` in the model is the session-row check that `S` `lockLiveSession`
(324) makes at the start of each locking transaction. Every v2 transaction
takes locks in one order (session, definition, run, node), and deletion
takes the session row first, so they serialize.

### Model simplifications

- One cursor (no parallel branches): the first slice has none.
- Continue-as-new is not modeled. It carries the exact controller state
  (cursor, ordinals, steps); the 30-step loop regression checks it.
- The controller is one sequential process; activity retries are Exec steps
  repeated before Record.
- Promptness is not modeled. Liveness says that something eventually
  happens; the regressions check that a stopped script ends before its late
  effect.
- Workflow creation is not modeled; its exclusive claim is checked by the
  admission regressions on PostgreSQL.
- Fairness assumes the store eventually accepts each transaction. The code
  retries a store activity for at most 180 seconds; after a longer outage
  the orchestration fails and its run row stays active. That recovery is
  an open item, not a modeled behaviour.

## Properties

| Property | Meaning |
|---|---|
| `CoreSafety` | Types; each event once; admission order; cancel/delete winners only in a cancelled run; completed run has a succeeded terminal; no routing of a cancelled node of an active run. |
| `Inv_TerminalNoPending` | A terminal run has no pending node execution. |
| `Inv_DeletedNotActive` | A deleted workflow has no active run. |
| `Prop_ResultImmutable` | A stored node result never changes. |
| `Prop_RunTerminalImmutable` | A terminal run status never changes. |
| `Prop_NoAdmissionAfterTerminal` | No node execution is admitted after the run ended. |
| `Prop_NoScriptAfterDelete` | No script starts after the session was deleted. |
| `Prop_TombstonePermanent` | A deleted definition stays deleted. |
| `Live_Terminates` | The run eventually ends. |
| `Live_ControllerDone` | The controller eventually finishes. |
| `Live_EffectsQuiesce` | Every effect eventually ends for good. |
| `Live_CancelStops` | Every effect of a cancel-won node is eventually asked to stop. |

## Cases

`MaxLoops = 1` unless stated. "rv" cases use the reviewed commit's switches;
"hd" cases use this commit's; "df" cases are deliberate faults.

| Case | Mode | Faults | Checked | Expected |
|---|---|---|---|---|
| `rv-core-safety` | reviewed 63c8013b | wake loss, effect faults | `CoreSafety`, result/run/admission properties | PASS |
| `rv-terminal-no-pending` | reviewed 63c8013b | controller faults | `Inv_TerminalNoPending` | safety violation |
| `rv-terminates-lost-wake` | reviewed 63c8013b | wake loss | `Live_Terminates` | liveness violation |
| `rv-terminates-effect-death` | reviewed 63c8013b | effect faults | `Live_Terminates` | liveness violation |
| `rv-cancel-stops` | reviewed 63c8013b | cancel crash only | `Live_CancelStops` | liveness violation |
| `rv-no-script-after-delete` | reviewed 63c8013b | none | `Prop_NoScriptAfterDelete` | safety violation |
| `rv-deleted-not-active` | reviewed 63c8013b | none | `Inv_DeletedNotActive` | safety violation |
| `hd-safety` | this commit | all | all safety | PASS |
| `hd-safety-loops2` | this commit, `MaxLoops = 2` | all | all safety | PASS |
| `hd-liveness` | this commit | wake loss, effect faults | all four liveness | PASS |
| `hd-liveness-faults` | this commit | all | liveness except `Live_CancelStops` | PASS |
| `df-no-cas` | this commit + `NoCas` | none | `Prop_ResultImmutable` | safety violation |
| `df-no-backstop` | this commit without `Backstop` | wake loss | `Live_Terminates` | liveness violation |

`Live_CancelStops` is not checked with controller faults: a controller that
fails after the cancel commit sends no stop request. The script's liveness
check still stops it; `Live_EffectsQuiesce` and the regressions cover that.

A reviewed-mode violation is a model counterexample for the reviewed code,
not by itself a reproduced defect. The regressions below exercise each
boundary on the real runtime; their executed results are recorded with the
DEV receipts for this commit, not in this file.

## Commands

Run from this folder with the TLA+ tools jar (`tla2tools.jar`):

```sh
java -cp tla2tools.jar tla2sany.SANY WorkflowV2Run.tla
java -XX:+UseParallelGC -Xmx8g -cp tla2tools.jar tlc2.TLC -workers 4 -deadlock \
    -config <case>.cfg -metadir states/<case> WorkflowV2Run.tla
```

`-deadlock` turns deadlock checking off: a finished run is a final state.
A case that exceeds its time or memory cap is VOID, not PASS.

## Regressions

| Boundary | Test |
|---|---|
| Lost wakes (`Backstop`) | `packages/sdk/test/local/workflow-v2-faults.test.js` "finishes from stored results when every wake is lost" |
| Effect death (`EffectWatch`) | same file, "fails a script state whose effect orchestration ended without storing a result" |
| Cancel retry after commit (`CancelStopFromStore`) | same file, "still asks the effect to stop when the cancel activity is retried after its commit" |
| Deletion before dispatch, during a script, of drafts and finished runs (`DeleteGuard`) | `packages/sdk/test/local/workflow-v2-delete.test.js` |
| Concurrent creation, foreign and legacy rows | `packages/sdk/test/local/workflow-v2-admission.test.js` |
| Exactly-once events, continue-as-new state, cancel winner, strict JSON, contracts | `packages/sdk/test/local/workflow-v2-core.test.js` |
