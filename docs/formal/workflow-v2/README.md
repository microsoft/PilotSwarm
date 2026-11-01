# Workflow v2 run model

`WorkflowV2Run.tla` models one workflow v2 run as the code in
`packages/sdk/src/workflow/v2` implements it: the controller orchestration,
one effect orchestration per script node execution, the PostgreSQL store
transitions and deletion of the workflow session. It is derived from the
code in the same commit as this file. Line numbers below refer to that commit.

The model checks durable-history and transaction boundaries, crashes,
retries, lost and duplicate wakes, cancellation (request and
acknowledgement), deletion, effect death, the script start inside its entry
transaction, controller death with the parent's explicit recover, and the
workflow's catch-all state (entered once, by its catch-all route or by a
state's own failure route).
It does not check the compiler, schemas, bindings or tool authorization;
real PostgreSQL and runtime tests cover those (see "Regressions").
Its liveness results hold only under the environment assumptions below.

## Assumptions

These are assumptions about the environment, not guarantees of the code.
A liveness PASS holds only for behaviours that satisfy them; each has a
case that shows what happens without it.

| Id | Assumption | In the model | Without it |
|---|---|---|---|
| A1 | Worker crashes inside one run's script activities are finite. | `CrashBudget`: at most `MaxCrashes` `EffCrash` steps per run (any phase: claimed, spawned or running). | `df-unbounded-crashes`: a crash can interrupt every entry (`EffClaim`, `EffCrash`, repeated), and the run never ends. |
| A2 | Healthy scheduling: a worker runs a step of the controller or of an effect that stays enabled, and the store eventually accepts its transaction. | Weak fairness on every controller and effect step; no strong fairness. | A store outage longer than the retries fails the controller (`ControllerDie`); A3 then applies. |
| A3 | The parent eventually recovers a run that `read_workflow` shows as needing it. | Weak fairness of `Recover`. | `df-no-recovery`: the run stays active. |

The code adds no crash budget of its own: a worker crash re-dispatches the
script activity, as often as workers crash. A1 states what the liveness
results need from the platform. The regressions run one and two crashes
inside the entry transaction, then a healthy worker.

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
| `CommandPoll` | fix | Before every admission the controller reads every queued message without waiting (`takeQueuedCommand`); a cancel ends the run, a wake is dropped. Without it (before 547d1bf5), commands were read only while the controller waited, so a chain of states that completed at once could delay a cancel until the run ended. |
| `Recovery` | fix | The parent's explicit `update_workflow` operation `recover` (`recoverWorkflowV2Run`) ends an active run whose controller ended. `read_workflow` only reports it (`needsRecovery`). |
| `HandlerOnce` | fix | Controller 1.3.0 and later: admitting the catch-all state by any route uses its one entry, and a later route to it fails the run. Without it (1.2.0), only the catch-all route used the entry: after an explicit route into the state, its own unhandled error entered it a second time. |
| `CatchAll` | workflow | The workflow declares a catch-all state `H` (a script); an unhandled `error` goes there once. |
| `ExplicitHandlerRoute` | workflow | `S` routes its `error` to `H` by its own failure route (`failure: H`). Requires `CatchAll`. |
| `ControllerDeath` | fault | The controller orchestration ends without ending its run: it was terminated, or its finalization attempts ran out. |
| `Deletes` | environment | The workflow session may be deleted. FALSE isolates the reviewed-mode liveness counterexamples from deletion. |
| `CrashBudget`, `MaxCrashes` | environment assumption | A1: at most `MaxCrashes` worker crashes in this run's script activities. FALSE leaves crashes unbounded (all safety cases, and `df-unbounded-crashes`). |
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
| `Init` | `S` `createDefinition` 593, `insertRun` 555 | Run row `admitted` committed with the definition and receipt. |
| `Dispatch` | `V` `dispatchWorkflowV2Run` 115 | After admission commit; a deletion may commit before it. duroxide ignores a second start of an instance id (0.1.32 `WorkItemReader`). |
| `BeginExec` / `BeginRecord` | `R` 486 (call), 875 (activity); `S` `beginRun` 977 | Session row lock, then run lock; `admitted -> running` only if the session is live. |
| `PollCommand` | `R` 510 (call), `takeQueuedCommand` 460 | `race(dequeue, 10 ms timer)` until the timer wins or a command is read; only when the next state is about to be admitted. |
| `AdmitExec` / `AdmitRecord` | `R` 530 (call), 904 (activity); `S` `enterNode` 1009 | Session and run locks; insert by deterministic id from history (scope, node, ordinal); idempotent on retry. Admitting the catch-all state sets `catchAllEntered` (544). |
| `StartEffect` | `R` 570 | `ctx.startOrchestrationVersioned`; instance id derived from the node execution id. |
| `CollectExec` / `CollectRecord` | `R` 609 (call), 995 (activity), 1013 (effect watch), 616-641 (routing); `S` `readCompletedNodes` 1149 | Reads stored winners of the history-selected pending ids only. A route of the state wins (`ExplicitHandlerRoute` when it leads to `H`); an unhandled runtime error goes to the catch-all state while it has not run. A route to the catch-all state after it ran fails the run (631-641). `catchAllEntered` is carried through continue-as-new. |
| `WaitMsg` / `WaitTimer` | `R` 660 | One durable `race`; an already queued message wins; a wake is only a hint. |
| `FinishExec` / `FinishFailExec` / `FinishRecord` | `R` 549-559 (terminal), 418 (`finishRun`), 397 (`persistently`), 1033 (activity), 1039 (no IR on the failure path); `S` `finishRun` 1161 | Session and run locks; run end, terminal node and pending nodes in one transaction. A failed attempt is retried on durable timers (about 30 minutes). A terminal's invalid output goes to the catch-all state while it has not run (1100); the model's `T` has no output, so this path is not modeled (see below). |
| `NotifyExec` / `NotifyRecord` | `R` 410 (`reportEnded`), 475 (after a command), 1194 (activity) | At least once; stable client message id; reads no IR. |
| `CancelTx` | `R` 470 (applyCommand), 1146 (activity); `S` `finishRun` 1161 | Run `cancelled` and pending nodes `winner = 'cancel'` in one transaction. |
| `CancelStop` | `R` 1168; `S` `listCancelledNodeIds` 1142 | After the commit; not transactional with it. Sends a cancellation request (`cancelInstance`) only to effects that are still running; it is a request, not a stop. |
| `CancelCrash` | `R` 1146 | Activity retry re-executes the whole body; the code's attempts are finite (store retry policy, then `persistently`); the model allows one crash, and running out is `ControllerFault`. |
| `CancelRecord` | `R` 470 | Controller resumes with the recorded result. |
| `ControllerFault` | `R` 438 (`workflowV2Controller`), 433 (`failRun`) | `controlRun` throws (an activity ran out of attempts, or a protocol fault), or the input does not parse but names the run; the run ends failed with the cause. |
| `ControllerDie` | `R` 397 (the last attempt's failure propagates); `R` 808 (pre-release versions 1.0.0 to 1.3.0 fail at once); or an external termination | The controller orchestration ends; its run stays active and `read_workflow` shows `needsRecovery`. |
| `Recover` | `V` `recoverWorkflowV2Run` 227; `T` `recoverWorkflowFromTool` 223; `S` `finishRun` 1161 | Parent-authorized write. Run `failed` (`controller_ended`), pending nodes `winner = 'controller'` and the request's receipt in one transaction. Then the parent notification starts (`V` `notifyRecoveredRun` 186, `R` `workflowV2Notify` 709); the model has no notification property, so this step is not modeled. A run admitted but never dispatched is dispatched instead (not modeled; see below). |
| `EffClaim` | `R` 695 (call), 1254 (activity), 1305; `S` `enterScript` 1084; `X` `start` 548, `enter` 605 | Session, run and node locks; enter only a pending node of an active run of a live session. With `EntryFence` the process starts inside the transaction (`spawned`), holding the session row lock. |
| `EffCommit` / `EffCommitFail` | `S` `enterScript` 1084 (commit); `X` 605-625 (a failed commit stops and awaits the process, then the activity reports `execution_failed`) | The process exists before the commit; a failed commit kills it but cannot undo what it already did. |
| `EffLaunch` | none in this commit; `159bdce5` `R` 852 (claim), 855 (binding read), 876 (runner) | Only without `EntryFence`: the process starts after the claim committed. |
| `EffComplete` | `R` 1295-1317, `scriptResult` 1360 | Script result enters the effect history before it is stored. |
| `EffStopDecided` | `R` 1285, 1307; `S` `isNodePending` 1109; `X` 574 | Liveness query every 1 s and the runner's 250 ms poll; it stops the script when its node is decided elsewhere, provided the store answers and the worker runs its timers. |
| `EffStopRequested` | duroxide cancellation of the effect instance; `X` 574 (`isCancelled`) | The effect acknowledges a stop request: its runner kills the script and it ends without storing a result. |
| `EffCrash` | `R` 695 | Activity re-dispatch after a worker crash; a crash inside the entry transaction rolls it back. A script process of the crashed worker may outlive it (not modeled; see below). Bounded only by A1. |
| `EffDie` | `R` 699 | Record activity exhausts retries, or the effect instance is terminated. |
| `EffRecord` | `R` 699 (call), 1320 (activity); `S` `completeNode` 1118 | Session lock, then compare-and-swap from `pending`; loser reads the stored winner. |
| `EffWake` / `EffWakeDup` / `EffWakeLost` | `R` 700 (call), 1341 (activity) | Enqueue to the controller queue only for an active run. |
| `SendCancel` | `management-client.ts` `sendCommand`; `V` `controlWorkflowV2Run` (update_workflow operation `cancel`) | Command enqueued to the controller queue. |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `M` trigger 65-94 (0086), replaced in 0087 to also end paused runs | Soft delete, definition tombstone, run cancel and pending nodes `winner = 'delete'` in one transaction; waits for an entry transaction that holds the session row (`NoEntryInFlight`). |

`Writable` in the model is the session-row check that `S` `lockLiveSession`
(361) makes at the start of each locking transaction. Every v2 transaction
takes locks in one order (session, definition, run, node), and deletion
takes the session row first, so they serialize.

### Model simplifications

- One cursor (no parallel branches): the first slice has none.
- The catch-all state is one script state `H`. `S` reaches it by the
  catch-all route or, with `ExplicitHandlerRoute`, by its own failure route.
  `HNodes` has a second ordinal only without `HandlerOnce`, so the 1.2.0
  re-entry is a state the checker can reach (`df-handler-reentry`).
  `Inv_CatchAllOnce` states "at most once"; the code enforces it with
  `catchAllEntered`.
- The terminal `T` has no output, so a terminal's invalid output, which the
  code sends to the catch-all state once, is not modeled; the core
  regressions check it on the real runtime.
- `Recover` does not model the parent notification that follows it; no
  property here covers notification. A regression checks it.
- A lost dispatch (the controller start after admission never reaches
  duroxide) and the recover that dispatches it again are not modeled:
  `Dispatch` is weakly fair, and `ControllerDie` cannot fire before it.
  The code stores that recover's receipt and its `workflow.recovered`
  event before the start (`S` `recordRecoverDispatch` 526), and a repeat of
  the request starts the controller again (`V` `dispatchRecoveredRun` 201;
  duroxide ignores a second start of an instance). The dispatch is at
  least once; the faults regressions check the receipt under a concurrent
  repeat and after an interruption before or after the start.
- `PollCommand` reads one message per step; a chain of states that complete
  at admission is bounded here by `MaxLoops`, so the model cannot show the
  starvation that `CommandPoll` removes. The immediate-chain regression shows it.
- `Recover` is weakly fair: the model assumes that the parent eventually
  recovers a run that `read_workflow` shows as needing it. Nothing recovers
  it otherwise; without the operation the run stays active (`df-no-recovery`).
- Only transactions that can overlap an entry transaction in the single
  cursor model wait for it (`NoEntryInFlight` on collect, finish, cancel,
  record, recover and delete); begin and admit cannot overlap it here.
- A worker crash rolls back an entry transaction, but a script process that
  worker had started may keep running without its watcher until it ends on
  its own. Its effects are already-started effects, separate from a new
  entry after a deletion (which `Prop_NoScriptAfterDelete` excludes); the
  model does not track such orphans.
- External effects of a started script happen at least once (a crash
  re-runs the script) and are never rolled back.
- Pause, resume and the run's open KV are not modeled. In the code a paused
  run is active (it can be cancelled, deleted and recovered, and work it
  already admitted finishes) but admits no new state: `S` `enterNode` refuses
  it, and the controller waits for a resume (536, 581).
  Each state pins the KV revision current when its admission commits:
  set_vars and the admission both lock the run row, and an admission
  evaluated with an older revision is refused and evaluated again
  (`S` `enterNode`, `kv_changed`). A state already admitted keeps its
  revision. Without pause, the
  code's admitting statuses equal the model's `Active`, so the modeled
  actions keep their mapping. The control regressions check pause, resume
  and KV on the real runtime.
- Wait states are not modeled. A wait is a durable timer of the controller
  itself (no effect orchestration): its seconds are read once at admission,
  which stores its absolute deadline (`S` `enterNode`, `deadline_at`); the
  controller elapses it with a compare-and-swap (the `elapse` activity) when
  its own time reaches the deadline, and carries the deadline through
  continue-as-new. A cancel, a deletion or a recover ends a waiting run as
  it ends a run with a pending script. The wait regressions check it.
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
- Fairness (A2) assumes the store eventually accepts each transaction. The
  code retries a run-ending write for about 30 minutes and other store
  activities for at most 180 seconds; after a longer outage the controller
  fails, its run shows `needsRecovery`, and only the parent's recover (A3)
  ends it. A store that never accepts again is outside these results.

## Properties

| Property | Meaning |
|---|---|
| `CoreSafety` | Types; each event once; admission order; cancel/delete winners only in a cancelled run; completed run has a succeeded terminal; no routing of a cancelled node of an active run. |
| `Inv_TerminalNoPending` | A terminal run has no pending node execution. |
| `Inv_DeletedNotActive` | A deleted workflow has no active run. |
| `Prop_ResultImmutable` | A stored node result never changes. |
| `Prop_RunTerminalImmutable` | A terminal run status never changes. |
| `Prop_NoAdmissionAfterTerminal` | No node execution is admitted after the run ended. |
| `Prop_NoScriptAfterDelete` | No script process starts (in an entry transaction or after it) after the session was deleted. |
| `Prop_TombstonePermanent` | A deleted definition stays deleted. |
| `Inv_CatchAllAfterUnhandled` (in `CoreSafety`) | The catch-all state is admitted only after a script state ended with an error (by its own failure route, or with no route for it). |
| `Inv_CatchAllOnce` | The catch-all state is admitted at most once per run, by any route. |
| `Live_Terminates` | The run eventually ends. |
| `Live_ControllerDone` | The controller eventually finishes. |
| `Live_EffectsQuiesce` | Every effect eventually ends for good. |
| `Prop_CancelAsksLiveEffects` | Each stop step of the cancel activity asks every cancel-won effect that has not ended to stop (an ended effect needs no request). |
| `Live_CancelledEffectsEnd` | Every cancel-won effect eventually ends, by its stop request or by its own check, even when the cancel activity runs out of attempts. |

## Cases

`MaxLoops = 1` unless stated. "rv" cases use the reviewed commit's switches;
"hd" cases use this commit's; "df" cases are deliberate faults. Safety
cases leave crashes unbounded (`CrashBudget = FALSE`). Liveness cases
assume A1 with `MaxCrashes = 2`, except the catch-all liveness cases, which
use `MaxCrashes = 1`: the catch-all model is the largest, and its
conjunction case at `547d1bf5` did not finish its temporal check in 600
seconds.

| Case | Mode | Faults | A1 | Checked | Expected |
|---|---|---|---|---|---|
| `rv-core-safety` | reviewed 63c8013b | wake loss, effect faults, deletion | no | `CoreSafety`, result/run/admission properties | PASS |
| `rv-terminal-no-pending` | reviewed 63c8013b | controller faults, deletion | no | `Inv_TerminalNoPending` | safety violation |
| `rv-terminates-lost-wake` | reviewed 63c8013b | wake loss, no deletion | 2 | `Live_Terminates` | liveness violation |
| `rv-terminates-effect-death` | reviewed 63c8013b | effect faults, no deletion | 2 | `Live_Terminates` | liveness violation |
| `rv-cancel-stops` | reviewed 63c8013b | one cancel crash, no deletion | no | `Prop_CancelAsksLiveEffects` | safety violation |
| `rv-no-script-after-delete` | reviewed 63c8013b | deletion | no | `Prop_NoScriptAfterDelete` | safety violation |
| `rv-deleted-not-active` | reviewed 63c8013b | deletion | no | `Inv_DeletedNotActive` | safety violation |
| `hd-safety` | this commit | all except controller death | no | all safety | PASS |
| `hd-safety-loops2` | this commit, `MaxLoops = 2` | all except controller death | no | all safety | PASS |
| `hd-liveness` | this commit | wake loss, effect faults | 2 | `Live_Terminates`, `Live_ControllerDone`, `Live_CancelledEffectsEnd`, `Live_EffectsQuiesce` | PASS |
| `hd-liveness-faults` | this commit | all except controller death | 2 | the same four | PASS |
| `hd-catchall-safety` | this commit, catch-all route | all except controller death | no | all safety, `Inv_CatchAllOnce` | PASS |
| `hd-catchall-explicit-safety` | this commit, explicit route to the catch-all state | all except controller death | no | all safety, `Inv_CatchAllOnce` | PASS |
| `hd-catchall-liveness` | this commit, catch-all route | wake loss, effect faults | 1 | the same four | PASS |
| `hd-catchall-live-terminates` | as `hd-catchall-liveness` | the same | 1 | `Live_Terminates` | PASS |
| `hd-catchall-live-controller-done` | as `hd-catchall-liveness` | the same | 1 | `Live_ControllerDone` | PASS |
| `hd-catchall-live-cancelled-effects-end` | as `hd-catchall-liveness` | the same | 1 | `Live_CancelledEffectsEnd` | PASS |
| `hd-catchall-live-effects-quiesce` | as `hd-catchall-liveness` | the same | 1 | `Live_EffectsQuiesce` | PASS |
| `hd-controller-death` | this commit | controller death, effect faults | 2 | `CoreSafety`, `Inv_TerminalNoPending`, `Live_Terminates`, `Live_EffectsQuiesce` | PASS |
| `df-no-cas` | this commit + `NoCas` | none | no | `Prop_ResultImmutable` | safety violation |
| `df-no-backstop` | this commit without `Backstop` | wake loss | 2 | `Live_Terminates` | liveness violation |
| `df-no-entry-fence` | this commit without `EntryFence` (the `159bdce5` entry) | none | no | `Prop_NoScriptAfterDelete` | safety violation |
| `df-no-recovery` | this commit without `Recovery` | controller death, no deletion | 2 | `Live_Terminates` | liveness violation |
| `df-unbounded-crashes` | `hd-liveness` without A1 | wake loss, effect faults | no | the same four as `hd-liveness` | liveness violation |
| `df-handler-reentry` | this commit without `HandlerOnce` (controller 1.2.0), explicit route to the catch-all state | none | no | `Inv_CatchAllOnce` | safety violation |

The four `hd-catchall-live-*` cases have the constants, fairness and bounds
of `hd-catchall-liveness`, which stays; each checks one of its properties,
so a timeout of the conjunction does not leave every property without a
verdict. Their results do not replace it.

A controller fault may end the cancel activity before it sends any stop
request (finite attempts); `Live_CancelledEffectsEnd` still holds through the
script's own check, which is why it, not a request, is the liveness claim.

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
| Terminated controller and lost dispatch: read shows, recover acts (`ControllerDie`, `Recover`) | same file, "shows a run whose controller can no longer end it without changing it, and recovers it only on request" |
| Pre-release controller versions fail visibly; recover ends the run | same file, "fails a controller instance of a pre-release version visibly" |
| Continue-as-new with a pending state | same file, "carries a pending state across continue-as-new" |
| Parent notification after a crash past the parent's enqueue (at least once, one id) | same file, "notifies the parent at least once with one stable message id" |
| Cancel behind a wake; cancel during a chain of states that complete at admission (`CommandPoll`) | same file, "takes a cancel that arrives after a result's wake" and "takes a queued cancel within one step of a long chain" |
| Catch-all state: compiled, entered once, a failing handler fails the run, own routes win | `packages/sdk/test/local/workflow-v2-core.test.js` "compiles a workflow-wide catch-all state" and "routes an unhandled runtime error to the catch-all state once" |
| Catch-all state once by any route (`HandlerOnce`, `ExplicitHandlerRoute`); a terminal's invalid output goes there once; the catch-all terminal's own invalid output fails the run | same file, "enters the catch-all state at most once by any route, and hands it a terminal's invalid output" |
| Worker crashes inside the entry transaction, one and then two, then a healthy worker (A1, `EffCrash` from `spawned`) | `packages/sdk/test/local/workflow-v2-faults.test.js` "runs a script once, on a healthy worker, after one and after two worker crashes inside its entry transaction" |
| Recover of a run whose controller ended notifies the parent once with the stable id; recover receipts replay, a reused id is refused | same file, "notifies the parent when a recover ends a run whose controller ended" |
| Recover's dispatch receipt is stored before the start: a concurrent repeat that decides after the dispatch, two requests that both decide to dispatch, an interruption before and after the start, a reused id, and the run's stable controller instance id | same file, "stores a recover's dispatch receipt before it starts the controller" |
| Read and recover refuse another workflow's run, or no run, before any effect | same file, "refuses a read or a recover that selects a run of another workflow" |
| Open KV: initial map, one atomic set/delete batch at the expected revision, receipts, limits, refusal after the run ends; each state's pinned snapshot (a running script keeps its own) | `packages/sdk/test/local/workflow-v2-control.test.js` "pins each state's KV snapshot at admission" |
| Any valid KV key is plain data ("__proto__", "constructor", "toString"): creation, unrelated updates, direct set, replay, object and null values, explicit delete, the script's snapshot and bindings | same file, "keeps any valid KV key" |
| A set_vars that commits while an admission is evaluated: the admission pins the new revision | same file, "pins the KV revision current when an admission commits" |
| Wait state: compile rules and IR version 4; a one-second durable wait with no effect orchestration; seconds read once at entry (a later KV change does not move the deadline; bad seconds are invalid_input); the deadline across a worker restart and continue-as-new; elapsing while paused; cancel while waiting | `packages/sdk/test/local/workflow-v2-wait.test.js` |
| A controller instance of the compatible version 1.4.0 runs with this build's controller | `packages/sdk/test/local/workflow-v2-faults.test.js` "runs an instance of the compatible 1.4.0 controller version" |
| Pause and resume: admitted work finishes, the next state waits, `pauseSettled`, resume admits it with the KV set while paused | same file, "pauses admission without stopping admitted work, and resumes it" |
| A run paused before it began: recover dispatches it, it begins paused; cancel while paused | same file, "starts a run paused before it began as paused" |
| Concurrent creation, both orders, foreign and legacy rows, interrupted creation with another grant, the ordinary client and its handle | `packages/sdk/test/local/workflow-v2-admission.test.js` |
| A schema recorded at 0085 gets 0086; IR version 1 revisions run as stored; creation records of earlier fingerprints are continued or replayed without rewriting, and another grant or owner is refused | `packages/sdk/test/local/workflow-v2-compat.test.js` |
| A refused result whatever its text (empty error, empty marker) is `invalid_output`; a plain null is a valid result | `packages/sdk/test/local/workflow-v2-core.test.js` "treats an invalid marker as a refusal" and the strict-JSON probes |
| Exactly-once events, continue-as-new state, cancel winner, strict JSON, contracts | `packages/sdk/test/local/workflow-v2-core.test.js` |
