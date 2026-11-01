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
reviewed commit `63c8013b`; all TRUE is this commit. All TRUE except
`EntryFence` is the reviewed commit `159bdce5`.

| Constant | Kind | Code |
|---|---|---|
| `LoseWake` | fault | The effect's `wake` activity exhausts its retries. |
| `ControllerFaults` | fault | A controller activity exhausts its retries; `workflowV2Controller` catches and fails the run. |
| `EffectFaults` | fault | A worker crash re-runs `runScript` (at-least-once), or the effect orchestration ends without storing a result. |
| `Backstop` | fix | The controller waits with `race(dequeueEvent, timer)` and re-collects on the timer. |
| `CancelStopFromStore` | fix | The cancel activity reads every `winner = 'cancel'` node from the store on each execution. |
| `DeleteGuard` | fix | Migration 0086 deletion trigger; every v2 transaction locks the session row first; the script entry checks node, run and session under those locks; the running script's liveness check. |
| `EntryFence` | fix | The script process starts inside the entry transaction (`S` `enterScript` calls the runner's `start` while it holds the locks). Without it (`159bdce5`), the claim committed first and the process started after the tool binding was read, unchecked. |
| `EndPending` | fix | `finishRun` completes every pending node execution in the transaction that ends the run. |
| `EffectWatch` | fix | The collect activity fails a pending script node whose effect orchestration has ended. |
| `NoCas` | deliberate fault | Node completion overwrites instead of compare-and-swap. |

## Action to code

`R` is `packages/sdk/src/workflow/v2/runtime.ts`, `S` is `store.ts` in the
same folder, `V` is `service.ts`, `M` is
`packages/sdk/src/migrations/workflow-v2-0086.ts` (tables are in 0085), `C`
is `packages/sdk/src/cms.ts`, `X` is `packages/sdk/src/workflow/runner.ts`. "Exec" is the activity body and its store
transaction; "Record" is the controller resuming with the recorded result.
A crash between them re-executes Exec; every Exec is idempotent or
compare-and-swap.

| Model action | Code | Boundary |
|---|---|---|
| `Init` | `S` `createDefinition` 475, `insertRun` 439 | Run row `admitted` committed with the definition and receipt. |
| `Dispatch` | `V` `dispatchWorkflowV2Run` 91 | After admission commit; a deletion may commit before it. The controller start is idempotent by instance id. |
| `BeginExec` / `BeginRecord` | `R` 332 (call), 582 (activity); `S` `beginRun` 702 | Session row lock, then run lock; `admitted -> running` only if the session is live. |
| `AdmitExec` / `AdmitRecord` | `R` 367 (call), 611 (activity); `S` `enterNode` 720 | Session and run locks; insert by deterministic id from history (scope, node, ordinal); idempotent on retry. |
| `StartEffect` | `R` 375 | `ctx.startOrchestrationVersioned`; instance id derived from the node execution id. |
| `CollectExec` / `CollectRecord` | `R` 383 (call), 666 (activity), 685 (effect watch); `S` `readCompletedNodes` 844 | Reads stored winners of the history-selected pending ids only. |
| `WaitMsg` / `WaitTimer` | `R` 409-415 | One durable `race`; an already queued message wins; a wake is only a hint. |
| `FinishExec` / `FinishFailExec` / `FinishRecord` | `R` 304 (finishRun), 372, 704 (activity); `S` `finishRun` 856 | Session and run locks; run end, terminal node and pending nodes in one transaction. |
| `NotifyExec` / `NotifyRecord` | `R` 310, 816 | At-least-once; stable client message id. |
| `CancelTx` | `R` 417 (call), 777-792 (activity); `S` `finishRun` 856 | Run `cancelled` and pending nodes `winner = 'cancel'` in one transaction. |
| `CancelStop` | `R` 793-809; `S` `listCancelledNodeIds` 837 | After the commit; not transactional with it. |
| `CancelCrash` | `R` 777 | Activity retry re-executes the whole body. |
| `CancelRecord` | `R` 417-424 | Controller resumes with the recorded result. |
| `ControllerFault` | `R` 316-325 | `controlRun` throws; the catch fails the run. |
| `EffClaim` | `R` 453 (call), 845 (activity), 894; `S` `enterScript` 786; `X` `start` 536, `enter` 593 | Session, run and node locks; enter only a pending node of an active run of a live session; with `EntryFence` the process starts before the commit. |
| `EffLaunch` | none in this commit; `159bdce5` `R` 852 (claim), 855 (binding read), 876 (runner) | Only without `EntryFence`: the process starts after the claim committed. |
| `EffComplete` | `R` 884-897, `scriptResult` 949 | Script result enters the effect history before it is stored. |
| `EffStopDecided` | `R` 874-882, 905; `S` `isNodePending` 804; `X` 562 | Polling liveness check; stops the script when its node is decided elsewhere. |
| `EffCrash` | `R` 453 | Activity re-dispatch after a worker crash. |
| `EffDie` | `R` 457 | Record activity exhausts retries, or the effect instance is terminated. |
| `EffRecord` | `R` 457 (call), 909 (activity); `S` `completeNode` 813 | Session lock, then compare-and-swap from `pending`; loser reads the stored winner. |
| `EffWake` / `EffWakeDup` / `EffWakeLost` | `R` 458 (call), 930 (activity) | Enqueue to the controller queue only for an active run. |
| `SendCancel` | `management-client.ts` `sendCommand` | Command enqueued to the controller queue. |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `M` trigger 65-94 | Soft delete, definition tombstone, run cancel and pending nodes `winner = 'delete'` in one transaction. |

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
| `df-no-entry-fence` | this commit without `EntryFence` (the `159bdce5` entry) | none | `Prop_NoScriptAfterDelete` | safety violation |

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
| Concurrent creation, both orders, foreign and legacy rows, interrupted creation with another grant, the ordinary client and its handle | `packages/sdk/test/local/workflow-v2-admission.test.js` |
| A schema recorded at 0085 gets 0086; IR version 1 revisions run as stored | `packages/sdk/test/local/workflow-v2-compat.test.js` |
| Exactly-once events, continue-as-new state, cancel winner, strict JSON, contracts | `packages/sdk/test/local/workflow-v2-core.test.js` |
