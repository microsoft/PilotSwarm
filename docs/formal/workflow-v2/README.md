# Workflow v2 run model

`WorkflowV2Run.tla` models one workflow v2 run as the code in
`packages/sdk/src/workflow/v2` implements it: the controller orchestration,
one effect orchestration per script node execution, the PostgreSQL store
transitions and deletion of the workflow session. It is derived from the
code in the same commit as this file. Line numbers below refer to that commit.

The model checks durable-history and transaction boundaries, crashes,
retries, lost and duplicate wakes, cancellation, deletion, effect death,
controller death with a reader's reconciliation, and the workflow's
catch-all state.
It does not check the compiler, schemas, bindings or tool authorization;
real PostgreSQL and runtime tests cover those (see "Regressions").

## Switches

Each fix switch selects one code change. All fix switches FALSE is the
reviewed commit `63c8013b`; all TRUE is this commit. `CatchAll`,
`ControllerDeath` and `Deletes` select the workflow and environment, not a
code revision.

| Constant | Kind | Code |
|---|---|---|
| `LoseWake` | fault | The effect's `wake` activity exhausts its retries. |
| `ControllerFaults` | fault | A controller activity exhausts its retries; `workflowV2Controller` catches and fails the run. |
| `EffectFaults` | fault | A worker crash re-runs `runScript` (at-least-once), or the effect orchestration ends without storing a result. |
| `Backstop` | fix | The controller waits with `race(dequeueEvent, timer)` and re-collects on the timer. |
| `CancelStopFromStore` | fix | The cancel activity reads every `winner = 'cancel'` node from the store on each execution. |
| `DeleteGuard` | fix | Migration 0086 deletion trigger; every v2 transaction locks the session row first; the script entry checks node, run and session under those locks; the running script's liveness check. |
| `EntryFence` | fix | The script process starts inside the entry transaction (`S` `enterScript` calls the runner's `start` while it holds the locks). Without it (`159bdce5`), the claim committed first and the process started after the tool binding was read, unchecked. |
| `CommandPoll` | fix | Before every admission the controller reads every queued message without waiting (`takeQueuedCommand`); a cancel ends the run, a wake is dropped. Without it (before this commit), commands were read only while the controller waited, so a chain of states that completed at once could delay a cancel until the run ended. |
| `Reconciler` | fix | A reader of the run (`reconcileWorkflowV2Run`, called by `read_workflow`) ends an active run whose controller ended. |
| `CatchAll` | workflow | The workflow declares a catch-all state `H` (a script); an unhandled `error` goes there once. |
| `ControllerDeath` | fault | The controller orchestration ends without ending its run: it was terminated, or its finalization attempts ran out. |
| `Deletes` | environment | The workflow session may be deleted. FALSE isolates the reviewed-mode liveness counterexamples from deletion. |
| `EndPending` | fix | `finishRun` completes every pending node execution in the transaction that ends the run. |
| `EffectWatch` | fix | The collect activity fails a pending script node whose effect orchestration has ended. |
| `NoCas` | deliberate fault | Node completion overwrites instead of compare-and-swap. |

## Action to code

`R` is `packages/sdk/src/workflow/v2/runtime.ts`, `S` is `store.ts` in the
same folder, `V` is `service.ts`, `T` is `tools.ts`, `M` is
`packages/sdk/src/migrations/workflow-v2-0086.ts` (tables are in 0085), `C`
is `packages/sdk/src/cms.ts`, `X` is `packages/sdk/src/workflow/runner.ts`. "Exec" is the activity body and its store
transaction; "Record" is the controller resuming with the recorded result.
A crash between them re-executes Exec; every Exec is idempotent or
compare-and-swap.

| Model action | Code | Boundary |
|---|---|---|
| `Init` | `S` `createDefinition` 482, `insertRun` 446 | Run row `admitted` committed with the definition and receipt. |
| `Dispatch` | `V` `dispatchWorkflowV2Run` 94 | After admission commit; a deletion may commit before it. The controller start is idempotent by instance id. |
| `BeginExec` / `BeginRecord` | `R` 414 (call), 677 (activity); `S` `beginRun` 722 | Session row lock, then run lock; `admitted -> running` only if the session is live. |
| `PollCommand` | `R` 437-440 (call), `takeQueuedCommand` 388-395 | `race(dequeue, 10 ms timer)` until the timer wins or a command is read; only when the next state is about to be admitted. |
| `AdmitExec` / `AdmitRecord` | `R` 459 (call), 706 (activity); `S` `enterNode` 740 | Session and run locks; insert by deterministic id from history (scope, node, ordinal); idempotent on retry. |
| `StartEffect` | `R` 467 | `ctx.startOrchestrationVersioned`; instance id derived from the node execution id. |
| `CollectExec` / `CollectRecord` | `R` 475 (call), 762 (activity), 781 (effect watch), 485 (catch-all route); `S` `readCompletedNodes` 864 | Reads stored winners of the history-selected pending ids only. An unhandled runtime error goes to the catch-all state once (`catchAllEntered`, carried through continue-as-new). |
| `WaitMsg` / `WaitTimer` | `R` 510-517 | One durable `race`; an already queued message wins; a wake is only a hint. |
| `FinishExec` / `FinishFailExec` / `FinishRecord` | `R` 343 (finishRun), 331 (`persistently`), 800 (activity), 806 (no IR on the failure path); `S` `finishRun` 876 | Session and run locks; run end, terminal node and pending nodes in one transaction. A failed attempt is retried on durable timers (about 30 minutes). |
| `NotifyExec` / `NotifyRecord` | `R` 349, 403 (calls), 924 (activity) | At-least-once; stable client message id; reads no IR. |
| `CancelTx` | `R` 398 (applyCommand), 876-891 (activity); `S` `finishRun` 876 | Run `cancelled` and pending nodes `winner = 'cancel'` in one transaction. |
| `CancelStop` | `R` 892-908; `S` `listCancelledNodeIds` 857 | After the commit; not transactional with it. |
| `CancelCrash` | `R` 876 | Activity retry re-executes the whole body. |
| `CancelRecord` | `R` 398-407 | Controller resumes with the recorded result. |
| `ControllerFault` | `R` 366-380 (`workflowV2Controller`), 361 (`failRun`) | `controlRun` throws, or the input does not parse but names the run; the run ends failed with the cause. |
| `ControllerDie` | `R` 331-340 (the last attempt's failure propagates), or an external termination | The controller orchestration ends; its run stays active until a reader reconciles it. |
| `Reconcile` | `V` `reconcileWorkflowV2Run` 116; `T` 186 | Run `failed` (`controller_ended`) and pending nodes `winner = 'controller'` in one transaction. A run admitted but never dispatched is dispatched again instead. |
| `EffClaim` | `R` 545 (call), 954 (activity), 1003; `S` `enterScript` 806; `X` `start` 548, `enter` 605 | Session, run and node locks; enter only a pending node of an active run of a live session; with `EntryFence` the process starts before the commit. |
| `EffLaunch` | none in this commit; `159bdce5` `R` 852 (claim), 855 (binding read), 876 (runner) | Only without `EntryFence`: the process starts after the claim committed. |
| `EffComplete` | `R` 993-1012, `scriptResult` 1058 | Script result enters the effect history before it is stored. |
| `EffStopDecided` | `R` 983-991, 1014; `S` `isNodePending` 824; `X` 574 | Polling liveness check; stops the script when its node is decided elsewhere. |
| `EffCrash` | `R` 545 | Activity re-dispatch after a worker crash. |
| `EffDie` | `R` 549 | Record activity exhausts retries, or the effect instance is terminated. |
| `EffRecord` | `R` 549 (call), 1018 (activity); `S` `completeNode` 833 | Session lock, then compare-and-swap from `pending`; loser reads the stored winner. |
| `EffWake` / `EffWakeDup` / `EffWakeLost` | `R` 550 (call), 1039 (activity) | Enqueue to the controller queue only for an active run. |
| `SendCancel` | `management-client.ts` `sendCommand` | Command enqueued to the controller queue. |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `M` trigger 65-94 | Soft delete, definition tombstone, run cancel and pending nodes `winner = 'delete'` in one transaction. |

`Writable` in the model is the session-row check that `S` `lockLiveSession`
(324) makes at the start of each locking transaction. Every v2 transaction
takes locks in one order (session, definition, run, node), and deletion
takes the session row first, so they serialize.

### Model simplifications

- One cursor (no parallel branches): the first slice has none.
- The catch-all state is one script state `H` entered at most once; the code
  enforces "once" with `catchAllEntered`, which the regressions exercise
  (a failing handler fails the run).
- `PollCommand` reads one message per step; a chain of states that complete
  at admission is bounded here by `MaxLoops`, so the model cannot show the
  starvation that `CommandPoll` removes. The immediate-chain regression shows it.
- `Reconcile` is weakly fair: the model assumes that a reader eventually reads
  a run whose controller ended. Without a reader the run stays active
  (`df-no-reconciler`).
- Continue-as-new is not modeled. It carries the exact controller state
  (cursor, ordinals, steps); the 30-step loop regression checks it.
- The controller is one sequential process; activity retries are Exec steps
  repeated before Record.
- Promptness is not modeled. Liveness says that something eventually
  happens; the regressions check that a stopped script ends before its late
  effect.
- Workflow creation is not modeled; its exclusive claim, and that no other
  creator (including the ordinary client and its session handle) can take a
  workflow's id, are checked by the admission regressions on PostgreSQL.
- The tool binding read, the context build and the runner's process start
  are one step in this commit (`EffClaim`); `EffLaunch` exists only to model
  the earlier gap.
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
| `Inv_CatchAllAfterUnhandled` (in `CoreSafety`) | The catch-all state is admitted only after a state ended with an error it had no route for; `Inv_EventsOnce` limits it to one admission. |
| `Live_Terminates` | The run eventually ends. |
| `Live_ControllerDone` | The controller eventually finishes. |
| `Live_EffectsQuiesce` | Every effect eventually ends for good. |
| `Live_CancelStops` | Every effect of a cancel-won node is eventually asked to stop. |

## Cases

`MaxLoops = 1` unless stated. "rv" cases use the reviewed commit's switches;
"hd" cases use this commit's; "df" cases are deliberate faults.

| Case | Mode | Faults | Checked | Expected |
|---|---|---|---|---|
| `rv-core-safety` | reviewed 63c8013b | wake loss, effect faults, deletion | `CoreSafety`, result/run/admission properties | PASS |
| `rv-terminal-no-pending` | reviewed 63c8013b | controller faults, deletion | `Inv_TerminalNoPending` | safety violation |
| `rv-terminates-lost-wake` | reviewed 63c8013b | wake loss, no deletion | `Live_Terminates` | liveness violation |
| `rv-terminates-effect-death` | reviewed 63c8013b | effect faults, no deletion | `Live_Terminates` | liveness violation |
| `rv-cancel-stops` | reviewed 63c8013b | cancel crash only, no deletion | `Live_CancelStops` | liveness violation |
| `rv-no-script-after-delete` | reviewed 63c8013b | deletion | `Prop_NoScriptAfterDelete` | safety violation |
| `rv-deleted-not-active` | reviewed 63c8013b | deletion | `Inv_DeletedNotActive` | safety violation |
| `hd-safety` | this commit | all except controller death | all safety | PASS |
| `hd-safety-loops2` | this commit, `MaxLoops = 2` | all except controller death | all safety | PASS |
| `hd-liveness` | this commit | wake loss, effect faults | all four liveness | PASS |
| `hd-liveness-faults` | this commit | all except controller death | liveness except `Live_CancelStops` | PASS |
| `hd-catchall-safety` | this commit, catch-all | all except controller death | all safety | PASS |
| `hd-catchall-liveness` | this commit, catch-all | wake loss, effect faults | all four liveness | PASS |
| `hd-controller-death` | this commit | controller death, effect faults | `CoreSafety`, `Inv_TerminalNoPending`, `Live_Terminates`, `Live_EffectsQuiesce` | PASS |
| `df-no-cas` | this commit + `NoCas` | none | `Prop_ResultImmutable` | safety violation |
| `df-no-backstop` | this commit without `Backstop` | wake loss | `Live_Terminates` | liveness violation |
| `df-no-entry-fence` | this commit without `EntryFence` (the `159bdce5` entry) | none | `Prop_NoScriptAfterDelete` | safety violation |
| `df-no-reconciler` | this commit without `Reconciler` | controller death, no deletion | `Live_Terminates` | liveness violation |

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
| Deletion while the effect prepares its script, with a positive control (`EntryFence`) | `packages/sdk/test/local/workflow-v2-faults.test.js` "starts no script once a deletion commits before its entry" |
| IR unreadable after admission and finish attempts failing (`ControllerFault`, fail-closed finalization) | same file, "ends a run as failed with its cause when its IR cannot be read" |
| Controller input that does not parse but names its run | same file, "ends a run as failed when its controller starts with input it cannot parse" |
| Terminated controller and lost dispatch (`ControllerDie`, `Reconcile`) | same file, "ends a run whose controller was terminated, and dispatches an admitted run nobody started" |
| Continue-as-new with a pending state | same file, "carries a pending state across continue-as-new" |
| Parent notification after a crash past the parent's enqueue (at least once, one id) | same file, "notifies the parent at least once with one stable message id" |
| Cancel behind a wake; cancel during a chain of states that complete at admission (`CommandPoll`) | same file, "takes a cancel that arrives after a result's wake" and "takes a queued cancel within one step of a long chain" |
| Catch-all state: compiled, entered once, a failing handler fails the run, own routes win | `packages/sdk/test/local/workflow-v2-core.test.js` "compiles a workflow-wide catch-all state" and "routes an unhandled runtime error to the catch-all state once" |
| Concurrent creation, both orders, foreign and legacy rows, interrupted creation with another grant, the ordinary client and its handle | `packages/sdk/test/local/workflow-v2-admission.test.js` |
| A schema recorded at 0085 gets 0086; IR version 1 revisions run as stored; creation records of earlier fingerprints are continued or replayed without rewriting, and another grant or owner is refused | `packages/sdk/test/local/workflow-v2-compat.test.js` |
| A refused result whatever its text (empty error, empty marker) is `invalid_output`; a plain null is a valid result | `packages/sdk/test/local/workflow-v2-core.test.js` "treats an invalid marker as a refusal" and the strict-JSON probes |
| Exactly-once events, continue-as-new state, cancel winner, strict JSON, contracts | `packages/sdk/test/local/workflow-v2-core.test.js` |
