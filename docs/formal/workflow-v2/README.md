# Workflow v2 formal models

Six TLA+ modules model workflow v2 as the code in
`packages/sdk/src/workflow/v2` implements it in the same commit as this
file. Each is small and checks one group of boundaries; each has cases
with expected PASS and expected violations (earlier code revisions,
deliberate faults and witnesses).

| Module | Checks | Section |
|---|---|---|
| `WorkflowV2Run.tla` | One run: controller, effects, store transitions, crashes, wakes, cancellation, deletion, controller death and recover, the catch-all state | this section to "Regressions" |
| `WorkflowV2Wait.tla` | A wait state: the accepted-entry clock (W1), the store's elapse guard against skewed controller clocks, the first result kept, the deadline across retries and continue-as-new, pause, with a finite clock that stands for all later time at its bound | "Wait model" |
| `WorkflowV2Admission.tla` | Admission under the open KV and pause: the revision current at commit, KV_CHANGING, refusals, ordinals, the paused wait and its backstop, begin of a run paused before it began, the deletion trigger | "Admission model" |
| `WorkflowV2Lifecycle.tla` | Start of a run and cancels before begin: lost and skipped dispatch, the provider's drop, begin honoring an accepted cancel (C1), its recorded (nullable) requester and who is told (C2, M1), notification eligibility and each notification's outcome (A6), recover | "Lifecycle model" |
| `WorkflowV2SessionCommands.tla` | A parent session's cancel and delete for a v2 child through `sendCommandToSession`: receipts, redelivery, conflicts, the deleted-child path (D2), deletes applied in the store (D1) and the repeat of an earlier build's queued delete | "Session command model" |
| `WorkflowV2Receive.tla` | Messaging receive states and typed input: the claim at entry and in the input's acceptance, each decided at one reading of the store's clock, the deadline race, expiry (also of an input kept for a later, delayed entry), the durable order, the contract and correlation match, the sender decided in the admission and in the acceptance (R5), the stored receipt (R4) | "Receive model" |

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

### Migration assumption M1

Builds ae02665a to 183bb0b0 stored a `cancel` receipt for a run that had
not begun without ending the run, and the receipt records no requester.
Begin (from 31dc9888) ends such a run, and from b1d1d4b9 it records the
workflow's parent as `requestedBy` with `attributedFrom: "update_workflow"`,
so the parent is not told of a cancel it is assumed to have sent. That is
an assumption, M1, not identity read from the receipt, whose bytes stay
as stored: such a receipt was written through the `update_workflow` tool
by the workflow's parent. It rests on code paths only. In each of those
builds, `recordRunCancelRequest` is called only by `controlWorkflowV2Run`;
outside tests, `controlWorkflowV2Run` is called only by
`updateWorkflowFromTool`, after `authorizeParent` checks that the caller is
the parent in the workflow's session row and its definition; and the
package's `exports` map (`.`, `./api`, `./package.json`) and `src/index.ts`
do not export `workflow/v2`. A receipt written any other way (a test that
calls the service with another actor, direct SQL, a tool outside this
repository) is attributed the same way, and then the parent is not told
of that cancel. From 369beaf0 a cancel of a run that has not begun ends
the run in the receipt's transaction and records its actual requester, so
M1 applies only to receipts those earlier builds wrote.

## Switches

Each fix switch selects one code change. All fix switches FALSE is the
reviewed commit `63c8013b`; all TRUE is this commit. `CatchAll`,
`ExplicitHandlerRoute`, `HandlerLoop`, `ControllerDeath`, `Deletes` and the
crash budget select the workflow and environment, not a code revision.

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
| `HandlerLoop` | workflow | `H` routes its `ok` to a script state `R`, whose own failure route leads back to `H`; `R` routes `ok` to `T`. Requires `CatchAll`. |
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
| `Init` | `S` `createDefinition` 763, `insertRun` 725 | Run row `admitted` committed with the definition and receipt. |
| `Dispatch` | `V` `dispatchWorkflowV2Run` 122 | After admission commit; a deletion may commit before it. duroxide ignores a second start of an instance id (0.1.32 `WorkItemReader`). |
| `BeginExec` / `BeginRecord` | `R` 501 (call), 1018 (activity); `S` `beginRun` 1307 | Session row lock, then run lock; `admitted -> running` only if the session is live. |
| `PollCommand` | `R` 525 (call), `takeQueuedCommand` 475 | `race(dequeue, 10 ms timer)` until the timer wins or a command is read; only when the next state is about to be admitted. |
| `AdmitExec` / `AdmitRecord` | `R` 545 (call), 1060 (activity); `S` `enterNode` 1381 | Session and run locks; insert by deterministic id from history (scope, node, ordinal); idempotent on retry. Admitting the catch-all state sets `catchAllEntered` (559). |
| `StartEffect` | `R` 591 | `ctx.startOrchestrationVersioned`; instance id derived from the node execution id. |
| `CollectExec` / `CollectRecord` | `R` 642 (call), 1175 (activity), 1193 (effect watch), 649-674 (routing); `S` `readCompletedNodes` 1814 | Reads stored winners of the history-selected pending ids only. A route of the state wins (`ExplicitHandlerRoute` when it leads to `H`, and with `HandlerLoop` `R`'s failure route back to `H`); an unhandled runtime error goes to the catch-all state while it has not run. A route to the catch-all state after it ran fails the run (664-674). `catchAllEntered` is carried through continue-as-new. |
| `WaitMsg` / `WaitTimer` | `R` 694 | One durable `race`; an already queued message wins; a wake is only a hint. |
| `FinishExec` / `FinishFailExec` / `FinishRecord` | `R` 564-574 (terminal), 433 (`finishRun`), 412 (`persistently`), 1213 (activity), 1219 (no IR on the failure path); `S` `finishRun` 1826 | Session and run locks; run end, terminal node and pending nodes in one transaction. A failed attempt is retried on durable timers (about 30 minutes). A terminal's invalid output goes to the catch-all state while it has not run (1280); the model's `T` has no output, so this path is not modeled (see below). |
| `NotifyExec` / `NotifyRecord` | `R` 425 (`reportEnded`), 490 (after a command), 1374 (activity) | At least once; stable client message id; reads no IR. |
| `CancelTx` | `R` 485 (applyCommand), 1326 (activity); `S` `finishRun` 1826 | Run `cancelled` and pending nodes `winner = 'cancel'` in one transaction. |
| `CancelStop` | `R` 1348; `S` `listCancelledNodeIds` 1807 | After the commit; not transactional with it. Sends a cancellation request (`cancelInstance`) only to effects that are still running; it is a request, not a stop. |
| `CancelCrash` | `R` 1326 | Activity retry re-executes the whole body; the code's attempts are finite (store retry policy, then `persistently`); the model allows one crash, and running out is `ControllerFault`. |
| `CancelRecord` | `R` 485 | Controller resumes with the recorded result. |
| `ControllerFault` | `R` 453 (`workflowV2Controller`), 448 (`failRun`) | `controlRun` throws (an activity ran out of attempts, or a protocol fault), or the input does not parse but names the run; the run ends failed with the cause. |
| `ControllerDie` | `R` 412 (the last attempt's failure propagates); `R` 893 (pre-release versions 1.0.0 to 1.6.0 fail at once); or an external termination | The controller orchestration ends; its run stays active and `read_workflow` shows `needsRecovery`. |
| `Recover` | `V` `recoverWorkflowV2Run` 257; `T` `recoverWorkflowFromTool` 265; `S` `finishRun` 1826 | Parent-authorized write. Run `failed` (`controller_ended`), pending nodes `winner = 'controller'` and the request's receipt in one transaction. Then the parent notification starts (`V` `notifyRecoveredRun` 193, `R` `workflowV2Notify` 743); the model has no notification property, so this step is not modeled. A run admitted but never dispatched is dispatched instead (not modeled; see below). |
| `EffClaim` | `R` 729 (call), 1439 (activity), 1490; `S` `enterScript` 1555; `X` `start` 548, `enter` 605 | Session, run and node locks; enter only a pending node of an active run of a live session. With `EntryFence` the process starts inside the transaction (`spawned`), holding the session row lock. |
| `EffCommit` / `EffCommitFail` | `S` `enterScript` 1555 (commit); `X` 605-625 (a failed commit stops and awaits the process, then the activity reports `execution_failed`) | The process exists before the commit; a failed commit kills it but cannot undo what it already did. |
| `EffLaunch` | none in this commit; `159bdce5` `R` 852 (claim), 855 (binding read), 876 (runner) | Only without `EntryFence`: the process starts after the claim committed. |
| `EffComplete` | `R` 1480-1502, `scriptResult` 1545 | Script result enters the effect history before it is stored. |
| `EffStopDecided` | `R` 1470, 1492; `S` `isNodePending` 1580; `X` 574 | Liveness query every 1 s and the runner's 250 ms poll; it stops the script when its node is decided elsewhere, provided the store answers and the worker runs its timers. |
| `EffStopRequested` | duroxide cancellation of the effect instance; `X` 574 (`isCancelled`) | The effect acknowledges a stop request: its runner kills the script and it ends without storing a result. |
| `EffCrash` | `R` 729 | Activity re-dispatch after a worker crash; a crash inside the entry transaction rolls it back. A script process of the crashed worker may outlive it (not modeled; see below). Bounded only by A1. |
| `EffDie` | `R` 733 | Record activity exhausts retries, or the effect instance is terminated. |
| `EffRecord` | `R` 733 (call), 1505 (activity); `S` `completeNode` 1589 | Session lock, then compare-and-swap from `pending`; loser reads the stored winner. |
| `EffWake` / `EffWakeDup` / `EffWakeLost` | `R` 734 (call), 1526 (activity) | Enqueue to the controller queue only for an active run. |
| `SendCancel` | `management-client.ts` `sendCommand`; `V` `controlWorkflowV2Run` 556 (update_workflow operation `cancel`) | Command enqueued to the controller queue of a run that has begun. A cancel of a run that has not begun ends it in its own transaction instead (`S` `recordRunCancelRequest` 1084), and a command queued for a controller that has not started is dropped by the provider; neither is in this model (see below). |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `M` trigger 65-94 (0086), replaced in 0087 to also end paused runs | Soft delete, definition tombstone, run cancel and pending nodes `winner = 'delete'` in one transaction; waits for an entry transaction that holds the session row (`NoEntryInFlight`). |

`Writable` in the model is the session-row check that `S` `lockLiveSession`
(481) makes at the start of each locking transaction. Every v2 transaction
takes locks in one order (session, definition, run, node), and deletion
takes the session row first, so they serialize.

### Model simplifications

- One cursor (no parallel branches): the first slice has none.
- The catch-all state is one script state `H`. `S` reaches it by the
  catch-all route or, with `ExplicitHandlerRoute`, by its own failure route.
  With `HandlerLoop`, `H` routes its `ok` to a script state `R`, whose own
  failure route leads back to `H`; `R` runs at most once here (a bound of
  the model). `HNodes` has the ordinals 1 to 3 in every mode: `H` can be
  entered from `S`, by the catch-all route and from `R`, so a second
  admission is a state the checker can reach wherever the code would make
  it (`df-handler-reentry`, `df-handler-loop-reentry`), and a PASS of
  `Inv_CatchAllOnce` is not vacuous. Before this revision (07156798) `HNodes`
  had one ordinal with `HandlerOnce`, so that PASS was vacuous and the
  explicit and catch-all graphs were identical. `Wit_NoHandlerRouteBack`
  (expected to be violated) shows that `R`'s error reaches the routing step
  whose failure route leads back to `H`. `Inv_CatchAllOnce` states "at most
  once"; the code enforces it with `catchAllEntered`.
- The terminal `T` has no output, so a terminal's invalid output, which the
  code sends to the catch-all state once, is not modeled; the core
  regressions check it on the real runtime.
- `Recover` does not model the parent notification that follows it; no
  property here covers notification. A regression checks it.
- A lost dispatch (the controller start after admission never reaches
  duroxide) and the recover that dispatches it again are not modeled here
  (the lifecycle model has both): `Dispatch` is weakly fair, and
  `ControllerDie` cannot fire before it.
  The code stores that recover's receipt and its `workflow.recovered`
  event before the start (`S` `recordRecoverDispatch` 696), and a repeat of
  the request starts the controller again (`V` `dispatchRecoveredRun` 208;
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
- Pause, resume and the run's open KV are not modeled here; the admission
  model has them ("Admission model"). In the code a paused run is active
  (it can be cancelled, deleted and recovered, and work it already admitted
  finishes) but admits no new state: `S` `enterNode` refuses it, and the
  controller waits for a resume (551, 602). Without pause, the code's
  admitting statuses equal this model's `Active`, so the modeled actions
  keep their mapping.
- Wait states are not modeled here; the wait model has them ("Wait
  model").
- A command queued for a controller instance that has not started is
  dropped by the provider (see the lifecycle model). In this model a cancel
  sent before the run begins waits in the queue (`SendCancel` at any time),
  which the provider does not guarantee. The code never relies on it: a
  cancel of a run that has not begun ends the run in its own transaction
  (`S` `recordRunCancelRequest`), begin ends a run that has an accepted
  cancel receipt (`S` `beginRun`), and a parent session's lifecycle
  commands to a v2 child are applied in the store (`S`
  `recordSessionCommand`). The lifecycle model and the session command
  model check these paths.
- Messaging receive states (controller 1.7.0, IR version 5) are modeled
  in the receive model ("Receive model") within its bounds; the messaging
  regressions are the evidence for the rest (its limits). A receive
  takes one typed message of its contract, from its sender (the parent, a
  named session or any allowed sender) and with its correlation, that a
  session gave the run with `send_workflow_input`. Only the workflow's
  live parent (the parent of both its session row and its definition), or
  a live session owned by the same user as the workflow (provider and
  subject exactly equal, neither a system session), may give it input;
  unknown, partial, blank or system ownership grants nothing. The store
  decides that in the transaction that accepts a fresh input (`S`
  `acceptInput`) or admits a receive that names a sender (`S` `enterNode`),
  after it locks the workflow's and the sender's session rows (ascending
  session id; the sender's `FOR SHARE`, `S` `lockInputSessions`): a sender
  deleted before that transaction is refused, and its deletion waits for a
  transaction that holds the lock. The service checks the same rule on the
  catalog first; that check alone decides whether a repeat of an accepted
  input is answered. The input is accepted once per (workflow, sender,
  operation id) in one transaction under the session and run locks. One
  reading of the store's clock, taken after the locks and compared and
  stored exactly (microseconds), decides the inbox bounds, the input's
  accepted and
  expiry times, and whether a receive that waits for it, and whose wait's
  deadline is after that reading, takes it in that same transaction
  (winner `message`). The acceptance's receipt (the request and payload
  hashes, the exact times and the receive that took the input then) is
  stored with the input and returned unchanged to every repeat. An input
  no receive waits for stays, in the run's order (`seq`), until a receive
  takes it when it is entered (`S` `enterNode`, the same transaction as the
  admission) or it expires. The entry decides at one reading of the
  store's clock, taken after its locks and guards: it takes only an input
  unexpired at that reading, and that reading is its entered, completed
  and consumed time however late it commits. A wait that elapses first
  does not discard the input, and an input accepted at or after a
  receive's deadline is late for that receive. A receive's wait is a wait
  state's deadline in the store's clock, elapsed by the same
  compare-and-swap (`S` `elapseWait`). The sender, correlation and wait are
  resolved and frozen when the receive is entered; a sender, named or the
  parent, that is not live when the receive is admitted fails it with
  `unavailable`, and one that may not give the workflow input fails it with
  `forbidden`. A retry of a committed admission returns it as stored. A
  wake after the claim is a hint; the backstop collects the result.
- Continue-as-new is not modeled here. It carries the exact controller
  state (cursor, ordinals, steps, `catchAllEntered`); the 30-step loop
  regression checks it. The wait model checks the cursor's deadline across
  it, and the admission model a pause across it.
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
- Controller versions: a build replays only histories of its own controller
  version. An instance of an earlier pre-release version (1.0.0 to 1.6.0)
  fails at once (`ControllerDie` before `BeginExec`), and recover ends its
  run. That is a visible recovery policy, not replay compatibility: no test
  replays a history that an earlier build wrote, and replay of earlier
  histories remains an open requirement.

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
| `Wit_NoHandlerRouteBack` | Witness, expected to be violated with `HandlerLoop`: `R`'s error reaches the routing step whose own failure route leads back to `H`. |
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
| `hd-catchall-loop-safety` | this commit, catch-all route, `H` `ok` to `R`, `R` `error` back to `H` (`MaxLoops = 0`) | all except controller death | no | all safety, `Inv_CatchAllOnce` | PASS |
| `hd-catchall-loop-explicit-safety` | as `hd-catchall-loop-safety` with the explicit route from `S` to `H` | the same | no | the same | PASS |
| `hd-catchall-loop-live-terminates` | as `hd-catchall-loop-safety` | wake loss, effect faults | 1 | `Live_Terminates` | PASS |
| `df-handler-loop-reentry` | `hd-catchall-loop-safety` without `HandlerOnce` (controller 1.2.0) | none | no | `Inv_CatchAllOnce` | safety violation |
| `wit-handler-route-back` | as `hd-catchall-loop-safety` | none | no | `Wit_NoHandlerRouteBack` | safety violation (witness) |

The `hd-catchall-loop-*` cases and their twins use `MaxLoops = 0` (`S` has
no "again"), which keeps the larger graph near the size of the catch-all
cases. Every case before them keeps its constants with `HandlerLoop =
FALSE`; there the new ordinals of `H` and the state `R` stay absent.

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

Run from this folder with the TLA+ tools jar (`tla2tools.jar`). Each case
names its module by its prefix: `wait-` and `wit-wait-` cases are for
`WorkflowV2Wait.tla`, `adm-` for `WorkflowV2Admission.tla`, `lc-` and
`wit-lc-` for `WorkflowV2Lifecycle.tla`, `cmd-` and `wit-cmd-` for
`WorkflowV2SessionCommands.tla`, `rcv-` and `wit-rcv-` for
`WorkflowV2Receive.tla`, and every other case for `WorkflowV2Run.tla`.

```sh
java -cp tla2tools.jar tla2sany.SANY <module>.tla
java -XX:+UseParallelGC -Xmx8g -cp tla2tools.jar tlc2.TLC -workers 4 -deadlock \
    -config <case>.cfg -metadir states/<case> <module>.tla
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
| Pre-release controller versions (1.1.0, and 1.4.0, 1.5.0 and 1.6.0, whose histories no test replays) fail visibly; recover ends the run | same file, "fails a controller instance of each pre-release version visibly" |
| Continue-as-new with a pending state | same file, "carries a pending state across continue-as-new" |
| Parent notification after a crash past the parent's enqueue (at least once, one id) | same file, "notifies the parent at least once with one stable message id" |
| Cancel behind a wake; cancel during a chain of states that complete at admission (`CommandPoll`) | same file, "takes a cancel that arrives after a result's wake" and "takes a queued cancel within one step of a long chain" |
| Catch-all state: compiled, entered once, a failing handler fails the run, own routes win | `packages/sdk/test/local/workflow-v2-core.test.js` "compiles a workflow-wide catch-all state" and "routes an unhandled runtime error to the catch-all state once" |
| Catch-all state once by any route (`HandlerOnce`, `ExplicitHandlerRoute`); a terminal's invalid output goes there once; the catch-all terminal's own invalid output fails the run | same file, "enters the catch-all state at most once by any route, and hands it a terminal's invalid output" |
| Worker crashes inside the entry transaction, one and then two, then a healthy worker (A1, `EffCrash` from `spawned`) | `packages/sdk/test/local/workflow-v2-faults.test.js` "runs a script once, on a healthy worker, after one and after two worker crashes inside its entry transaction" |
| Recover of a run whose controller ended notifies the parent once with the stable id; recover receipts replay, a reused id is refused | same file, "notifies the parent when a recover ends a run whose controller ended" |
| Parent notification outcomes (lifecycle model `AuthorityLoss`): a delivery that finds the parent's authority gone records a skip with its reason and returns; the controller's own report and the notifier started by a recover complete with their results, nothing is delivered, and each run stays as it ended; with the authority back, a later notification of the same run (another notifier instance) finds its skip and tells no one; control: with the authority back, a new run's report is delivered once with the stable id and its controller completes with the run's result | same file, "records a skip and completes when a delivery finds the parent's authority gone" |
| A delivery that runs out (`NotifyFaults`, `CtlFallback`; fault injection on time: each of the nine finalize delays becomes 10 ms, so the ten batches of five attempts run in seconds): the notifier of a recovered run fails after 50 attempts, and the recover's receipt is kept; the controller's report runs out, its failure path keeps the completed run and delivers once more, which runs out too, and the controller fails after 100 attempts; each run's end is kept. Path coverage only: the shortened delays do not qualify the production timing | same file, "fails the notifier when a delivery runs out" |
| A begin whose notifier start runs out (`NotifyFaults`, `CtlFallback`; fault injection at the begin activity's client, five attempts) for a run a system actor's cancel ended before it began: the controller's failure path keeps the cancelled run and tells the parent once, and the controller completes with the run's cancelled result (its outcome null, as the cancel stored it); or its delivery runs out too (50 attempts, the delays as above) and the controller fails; nothing begins, the notifier never starts, and the cancel's receipt is kept | same file, "takes the controller's failure path when a begin's notifier start runs out" |
| Recover's dispatch receipt is stored before the start: a concurrent repeat that decides after the dispatch, two requests that both decide to dispatch, an interruption before and after the start, a reused id, and the run's stable controller instance id | same file, "stores a recover's dispatch receipt before it starts the controller" |
| Read and recover refuse another workflow's run, or no run, before any effect | same file, "refuses a read or a recover that selects a run of another workflow" |
| Open KV: initial map, one atomic set/delete batch at the expected revision, receipts, limits, refusal after the run ends; each state's pinned snapshot (a running script keeps its own) | `packages/sdk/test/local/workflow-v2-control.test.js` "pins each state's KV snapshot at admission" |
| Any valid KV key is plain data ("__proto__", "constructor", "toString"): creation, unrelated updates, direct set, replay, object and null values, explicit delete, the script's snapshot and bindings | same file, "keeps any valid KV key" |
| A set_vars that commits while an admission is evaluated: the admission pins the new revision | same file, "pins the KV revision current when an admission commits" |
| `KV_CHANGING` at the code's budget: a set_vars commits before each evaluation of one admission reaches the store (fault injection); the store refuses all 25 (five evaluations in each of five attempts) for `kv_changed`; the controller's failure path ends the run as failed (`controller_error`) and completes with that result; nothing is admitted | same file, "ends the run as failed with KV_CHANGING" |
| Wait state: compile rules and IR version 4; a one-second durable wait with no effect orchestration; seconds read once at entry (a later KV change does not move the deadline; bad seconds are invalid_input); the deadline across a worker restart and continue-as-new; elapsing while paused; cancel while waiting. Every time is the stored one, in the store's clock: deadline minus entry is the seconds exactly, completion is at or after the deadline. The store refuses an early elapse and reports the time left; a controller whose clock runs 3 s ahead (fault injection: the stored deadline moves after the controller read it) waits that time; a later elapse keeps a cancellation | `packages/sdk/test/local/workflow-v2-wait.test.js` |
| W1, the accepted-entry clock: an admission whose transaction begins and then waits 2.5 s for the run row (held unchanged by the test) enters at the clock reading after the lock, at least 2.5 s after its transaction began, and its 1 s passes after the release; an admission that reaches the store 2.5 s after its seconds were read counts them from its entry | same file, "counts a wait's seconds from the store's clock when its admission is accepted, after a lock wait" and "counts a wait's seconds from its accepted entry when its admission reaches the store late" |
| Bindings name any KV key: `??`, quotes, backslashes, `${` and `}` inside a JSON-string key or default are data, in ordinary spelling; present, own null and missing values with and without a default; refusals outside strings; a typed script input and terminal output on the real runtime, with a wrong-type negative control | `packages/sdk/test/local/workflow-v2-control.test.js` "reads ??, quotes, backslashes" and "gives a typed script the values those keys name" |
| Pause and resume: admitted work finishes, the next state waits, `pauseSettled`, resume admits it with the KV set while paused | same file, "pauses admission without stopping admitted work, and resumes it" |
| A run paused before it began: recover dispatches it, it begins paused; cancel while paused | same file, "starts a run paused before it began as paused" |
| C1: a cancel of a run that has not begun ends it in the cancel's transaction, with its receipt, admitted or paused before begin; no command is queued and nothing needs recovery; a repeat, a recover and a late original dispatch change nothing; the parent is notified at least once with the stable id unless it asked, also when the request is interrupted after the commit and before the notifier starts | `packages/sdk/test/local/workflow-v2-control.test.js` "ends a run that has not begun at once when it is cancelled" |
| C1: begin and cancel in both orders under the session and run locks, with the controller instance running: cancel first ends the run (admitted, and paused before begin) and begin then admits nothing; begin first makes the cancel a queued command that the controller applies before any admission (receipt status running); the first run end stands | same file, "orders a cancel and the run's begin under the same locks" |
| A parent session's lifecycle commands through the real `sendCommandToSession` activity, scheduled in a real runtime under the parent's instance id: cancel, done and delete of v2 children whose runs have not begun, and of drafts, applied in the store with receipts keyed by the command id (retry replays, another request with the id is refused); nothing queued for a controller that does not exist; refused for a session that is not the parent and for a requestedBy that is not the sender; positive controls: a begun child's controller applies the queued cancel and done (stopped), and an ordinary agent child's orchestration receives the exact command; D2: a retry that read the child live and then found it deleted by the first attempt (stopped after its commit, before the facts cleanup) completes the cleanup under the same receipt, and a changed request with that id is refused in the same race; a delete applied whatever the run did: a running run ends by the deletion (winner delete), a run that ended on its own keeps its result, and a delete that an earlier head accepted as queued and never queued (the run then ended) is applied by its same-id repeat with its receipt unchanged; the child's facts are removed in each case (a real facts store) | `packages/sdk/test/local/workflow-v2-session-commands.test.js` |
| C2: an earlier build's accepted cancel ended at begin (by a recover's dispatch, its first begin interrupted after its commit; or by a late original dispatch) records the parent as its requester (attributed from update_workflow) and tells no one; the parent's same-id repeat returns the stored receipt and is not reported to it; another requester's cancel whose request stopped after its commit, before the notifier, and was never repeated, is reported to the parent once (stable id) when the run's controller starts late, after that begin's own post-commit interruption | same file, "loses a command queued..." and "tells the parent of a run another requester's cancel ended before it began" |
| C1: the PostgreSQL provider drops a command queued for an instance that has not started (seen in its tables: queue row gone, an execution row, no instance), so a later recover runs the whole run (no receipt: the negative control); a repeat of a cancel accepted that way by an earlier build ends the run that has not begun, returns its accept-time receipt and leaves the stored receipt unchanged, and another request with that id is refused; with no repeat, a recover's dispatch reaches begin, which finds the accepted cancel and ends the run, admitting nothing | same file, "loses a command queued before its controller started" |
| Messaging receive: compile rules and IR version 5; input given before the receive was entered is taken in the run's order, an expired one is skipped, once per operation id (a repeat returns the acceptance's stored receipt unchanged, although a receive took the input since, and an input stored without a receipt is not repeated; another request with the id is refused), and refused after the run ended; one reading of the store's clock decides each entry and each acceptance, recorded exactly; an input accepted before the deadline claims the waiting receive in its own transaction, one accepted after a (fault-injected) earlier deadline is late and kept, and an input given while no receive waits is taken by the next receive, not the one that elapsed; an input late for a receive (the same fault injection) is kept, and the next receive takes it at its entry, or, when that entry's admission is held (fault injection) until the input expired, the entry does not take it and the receive waits for a fresh input (receive model `Wit_TimerWinKeepsInput`, `Wit_LateInputExpires`); the deadline to the microsecond (fault injection: an input accepted at its receive's deadline, or a microsecond after it, is late; one a microsecond before it wins); an entry held past the input's expiry (fault injection) still takes it at its own earlier reading; another sender or correlation is not taken, an undeclared contract or an invalid payload stores nothing, and the deadline does not move; input across users is refused, and so is input from a session of unknown, partial, blank or system ownership or of another identity (a workflow no user owns takes its parent's input only); a receive that names such a session, another user's, a deleted one or none fails on entry, and a receive from a deleted parent fails with unavailable without taking the parent's earlier input; the sender is decided in the store's transaction (fault injection: the store call is stopped after the receive was resolved, or after the send was checked, and the sender is deleted): a parent or named sender deleted then fails the receive with unavailable, with no deadline and no claim, and a fresh input from a sender deleted then is refused with nothing stored or recorded, with live controls and a repeat of a committed admission returned as stored; the store refuses a direct acceptance from another user, an unowned session, a missing or a deleted one; a paused run takes input without admitting anything until resumed; the per-sender inbox bound | `packages/sdk/test/local/workflow-v2-messaging.test.js` |
| Concurrent creation, both orders, foreign and legacy rows, interrupted creation with another grant, the ordinary client and its handle | `packages/sdk/test/local/workflow-v2-admission.test.js` |
| A schema recorded at 0085 gets 0086; IR version 1 revisions run as stored; creation records of earlier fingerprints are continued or replayed without rewriting, and another grant or owner is refused | `packages/sdk/test/local/workflow-v2-compat.test.js` |
| A refused result whatever its text (empty error, empty marker) is `invalid_output`; a plain null is a valid result | `packages/sdk/test/local/workflow-v2-core.test.js` "treats an invalid marker as a refusal" and the strict-JSON probes |
| Exactly-once events, continue-as-new state, cancel winner, strict JSON, contracts | `packages/sdk/test/local/workflow-v2-core.test.js` |

## Wait model

`WorkflowV2Wait.tla` models one wait state of a run whose controller began
it: its admission, its deadline, the controller's timer and the store's
elapse, and the transactions that may decide the wait first (a cancel that
the controller applies, a deletion, a recover after the controller ended,
whose last elapse activity may still run). After the wait, the terminal
state ends the run. `clk` is the store's clock in whole seconds; the
controller and the workers read `clk` plus 1, 0 or -1 (`ClockOffset`).
The store's clock advances freely to `MaxPre` while the wait is not stored
(a delay before the transaction, a lock wait, the time between the insert
and its commit), then while a timer of the store or of the controller is
still ahead. The code and the model assume that the store's clock does not
go back between the admission and the elapse.

The clock: `clk` stops at `ClockCap` (`MaxPre + Secs + 2 * |offset| + 1`),
and `ClockCap` stands for every time from `ClockCap` on. Every stored
deadline in these bounds is before `ClockCap`, and so is the controller's
first ask, so the store decides the same way at every later time (it
elapses a pending wait unless the run is deleted, or paused in the
`ElapseWhilePaused = FALSE` fault, and it reports at least 1 s left). A
controller timer that a not-due answer re-arms for a later time has fired
by some later time; at `ClockCap` the controller may therefore ask again
(`CtrlAsk`). Without that rule the be9aa9b3 model let the clock saturate
during repeated not-due answers while the run was paused, and after a
resume no fair step was enabled (`wait-df-frozen-while-paused`, finding
`be9aa9b3-wait-clock-saturation`): a stall caused by the bound, not by the
pause. With the rule, a wait of a paused run stalls only while the run stays
paused, and `wait-df-frozen-while-paused-resumed` checks that a resumed run's
wait is decided.

| Constant | Kind | Code |
|---|---|---|
| `EntryClock` | revision | What the deadline counts from: `"evaluation"`, the worker's `Date.now()` when the activity read the seconds (a93c105c); `"begin"`, the transaction's `now()` (659dc63f); `"accepted"`, one `clock_timestamp()` reading in the inserting statement, after the locks and the guards (183bb0b0 and this commit). |
| `StoreElapseGuard` | fix | 659dc63f: the store elapses a wait only when its own clock reached the deadline, and otherwise reports the time left. Without it (a93c105c) the controller's timer decided. |
| `Cas` | deliberate fault when FALSE | The elapse is a compare-and-swap from pending. |
| `CanKeepsDeadline` | deliberate fault when FALSE | Continue-as-new carries the cursor's deadline. |
| `ElapseWhilePaused` | deliberate fault when FALSE | The store elapses a wait of a paused run: a pause does not freeze the deadline. |
| `Pauses`, `Cancels`, `Deletes` | environment | The parent pauses the run (once) and resumes it, or cancels it; the session is deleted. |
| `ControllerDeath` | fault | The controller ends without ending its run; the parent recovers it (A3). |
| `ResumeFair` | environment | A paused run is eventually resumed (weak fairness of `Resume`); a control for the paused cases. |
| `MaxCrashes` | assumption A1 | Worker crashes in the enter and elapse activities. |
| `Secs`, `MaxPre`, `ClockOffset` | bounds | The wait's seconds; the clock bound while the wait is not stored; the controller's clock against the store's. |

| Wait action | Code | Boundary |
|---|---|---|
| `AdmEval` | `R` 1060 (activity), 1075 (a retry reads the stored row), 1088 (evaluation), 1115 (the seconds, read once) | Outside the transaction. a93c105c computed the deadline here from the worker's `Date.now()` (`EntryClock = "evaluation"`). |
| `AdmBegin` / `AdmLock` | `S` `enterNode` 1381, `lockLiveSession` 481 | `now()` is the transaction's start (659dc63f counted from it); the session and run locks may wait for other transactions. |
| `AdmInsert` / `AdmCommit` | `S` 1438 (inactive), 1499 (the insert) | One `clock_timestamp()` reading in the inserting statement, after the locks and the live, status and KV guards, is `entered_at` and the start of the seconds; the commit may come later. |
| `AdmRecord` | `R` 545 (call), 551 (paused refusal), 580 (the cursor's deadline) | The controller keeps the stored deadline in its cursor. |
| `AdmCrash` / `ElapseCrash` | `R` 545, 628 (store retry policy) | A worker crash re-dispatches the activity; a committed admission is read back, an uncommitted one rolls back. |
| `CtrlAsk` | `R` 626 | The controller's clock is `utcNow`, recorded in its history; it only decides when to ask. At `ClockCap`, which stands for every later time, a re-armed timer has fired (the clock paragraph above). |
| `ElapseExec` / `ZombieElapse` | `R` 1413 (activity); `S` `elapseWait` 1624, 1634 (guard), 1644 (time left) | One reading of the store's clock after the session lock decides and is stored; compare-and-swap from pending; an activity may outlive its controller. |
| `ElapseRecord` | `R` 628, 636 | A wait not yet due waits the reported time from the controller's clock. |
| `CtrlCollect` / `Collect` / `Finish` | `R` 642 (collect), 649 (routing), 564 (terminal finish) | The next state's admission is refused for a paused or ended run. |
| `CtrlCan` | `R` 513, 697 | The controller state, with each cursor's deadline, is the next execution's input. |
| `PausedRetry` | `R` 602, 611 | The race of a command and the backstop timer; continue-as-new after idle waits. |
| `ApplyCancel` | `R` 485, 1326; `S` `finishRun` 1826 | The run's end decides a pending wait in its transaction. |
| `Delete` | `migrations/workflow-v2-0087.ts` 58 | Soft delete ends the run and decides a pending wait in one transaction. |
| `Pause` / `Resume` | `S` `setRunPaused` 1022 | Takes the session lock; a stored deadline does not change. |
| `CtrlDie` / `Recover` | `V` `recoverWorkflowV2Run` 257; `S` `finishRun` 1826 | The controller ended; recover ends the run as failed and decides a pending wait. |
| `Tick` | none | The store's clock (PostgreSQL), assumed never to go back. |

| Property | Meaning |
|---|---|
| `Inv_NotEarly` | A wait elapses no earlier than its seconds after its accepted entry, in the store's clock. |
| `Inv_RunEndDecidesWait` | A run that ended has no pending wait. |
| `Inv_ExitEndedRun` | The controller ends only with its run. |
| `WaitSafety` | `TypeOK` and the three invariants above. |
| `Prop_DeadlineFixed`, `Prop_EntryFixed` | The stored deadline and entry never change (enter retries, continue-as-new). |
| `Prop_FirstResultKept` | The first stored result is kept. |
| `Live_WaitDecided` | A pending wait is eventually decided, also while its run stays paused. |
| `Wit_FromVisibility` | Witness, expected to be violated: the seconds count from the accepted entry, not from the commit. |

`Secs = 2`, `MaxPre = 3`. The safety cases allow every environment action
and one crash; each violation case turns off what its counterexample does
not need.

| Case | Mode | Checked | Expected |
|---|---|---|---|
| `wait-hd-safety` | this commit, controller clock ahead | `WaitSafety`, the three `Prop_` properties | PASS |
| `wait-hd-safety-behind` | this commit, controller clock behind | the same | PASS |
| `wait-hd-liveness` | this commit, controller clock ahead; the run may stay paused | `Live_WaitDecided` | PASS |
| `wait-rv-a93c105c` | deadline from the worker's clock at evaluation, no store guard | `Inv_NotEarly` | safety violation |
| `wait-rv-659dc63f` | deadline from the transaction's `now()`, store guard, clocks equal | `Inv_NotEarly` | safety violation (W1: a lock wait) |
| `wait-df-no-store-guard` | this commit without the store guard, controller clock ahead | `Inv_NotEarly` | safety violation |
| `wait-df-no-cas` | this commit without the compare-and-swap; an elapse activity outlives its controller after recover | `Prop_FirstResultKept` | safety violation |
| `wait-df-can-drops-deadline` | this commit with continue-as-new dropping the cursor's deadline | `Live_WaitDecided` | liveness violation |
| `wait-df-frozen-while-paused` | this commit with the store refusing to elapse a paused run's wait | `Live_WaitDecided` | liveness violation (the run stays paused) |
| `wait-df-frozen-while-paused-resumed` | as `wait-df-frozen-while-paused`, and a paused run is eventually resumed | `Live_WaitDecided` | PASS (control: the stall needs a run that stays paused, not the clock bound) |
| `wit-wait-from-visibility` | this commit, clocks equal | `Wit_FromVisibility` | safety violation (witness) |

Limits:

- One wait and one cursor. The controller chooses the due waits with
  `utcNow` recorded in its history, so replay repeats the choice; the store
  decides. Replay itself is not modeled.
- The seconds are a constant: their binding is evaluated once, with the KV
  revision the admission pins (the admission model).
- Whole seconds; the store reports at least 1 s left (the code: at least
  1 ms).
- The controller version boundary is the run model's `ControllerDie`:
  pre-release versions fail at once and recover ends their runs. Replay of
  an earlier version's history is not claimed.
- The controller ends between its activities, or while its elapse activity
  runs (that activity may still commit after it: `ZombieElapse`). An enter
  activity that a terminated controller had scheduled could also still
  commit its row; the recover then decides that wait (no elapse was
  scheduled for it). That interleaving is not modeled.

## Admission model

`WorkflowV2Admission.tla` models the admissions of one run under its open KV
and pause: the controller begins the run, admits state 1 (a script), and
after its result admits state `Steps` (the terminal), which ends the run.
Each admission evaluates its input with the run's current KV revision and
is accepted only while the run admits and that revision is still current.
set_vars, pause (also before begin), resume (its wake may be lost), a
cancel and a deletion may come at any time. KV revisions are numbers; the
KV contents are not modeled.

| Constant | Kind | Code |
|---|---|---|
| `KvCheck` | fix | 69e2667b: `S` `enterNode` refuses an admission evaluated with a revision that is no longer current (`kv_changed`). Without it (499541be) the admission pinned the revision read before its transaction. |
| `PauseGuard`, `InactiveFirst`, `PausedRefusalWaits`, `PausedBackstop`, `CountOnAdmitted`, `BeginMarksBegun` | deliberate faults when FALSE | A paused run admits nothing; the inactive refusal comes before the KV check; a paused refusal waits for the resume; the paused wait races a backstop timer; the ordinal counts only a stored admission; begin of a run paused before it began records `paused_from` running. |
| `TriggerEndsPaused` | migration | 0087 ends a paused run on deletion; FALSE is the 0086 trigger, which 0087 replaced when it added pause. |
| `LoseWake` | fault | A resume's wake is lost. |
| `PauseBeforeBegin`, `Cancels`, `Deletes` | environment | A pause before the controller begins the run; a cancel after begin; deletion. |
| `Steps`, `MaxKv`, `MaxEvals`, `MaxAttempts`, `MaxPauses` | bounds | States; KV revisions; evaluations per enter attempt and enter attempts (the code: 5 and 5); pause commands. |

Assumption A4, for liveness only: a paused run is eventually resumed (weak
fairness of `Resume`). Without it a run may stay paused, as designed.

| Admission action | Code | Boundary |
|---|---|---|
| `BeginTx` | `R` 501 (call), 502 (a run that is not active ends the controller); `S` `beginRun` 1307, 1327 (paused before begin) | Session and run locks; `admitted -> running`; a run paused before it began gets `paused_from` running. |
| `Eval` | `R` 1060 (activity), 1088 (each evaluation reads the run's current revision) | Outside the transaction. |
| `InsertTx` | `S` `enterNode` 1381: 1438 (inactive first), 1439 (`kv_changed`), 1499 (insert); `R` 1170 (`KV_CHANGING` after the last evaluation) | `set_vars` locks the run row too, so it commits before or after the admission. |
| `Record` | `R` 545 (call), 551 (paused refusal), 555 (ordinal and step only when stored) | A paused refusal is not an end. |
| `NodeDone` / `Collect` | `R` 733 (the effect stores its result), 642 (collect) | Admitted work finishes while paused. |
| `Finish` / `Fail` | `R` 564 (terminal), 453 (`controlRun` throws), 448; `S` `finishRun` 1826 | `KV_CHANGING` in every attempt ends the run as failed (`controller_error`). |
| `PausedWake` / `PausedTimer` | `R` 602 (race), 611 (continue-as-new) | A wake is a hint; the backstop timer finds a resume whose wake was lost; the next execution starts at the same admission and reads the pause from the store. |
| `SendCancel` / `ApplyCmd` | `V` 585; `R` 525 (poll), 485 | A cancel of a run that has begun is queued for its controller. |
| `Pause` / `Resume` | `S` `setRunPaused` 1022; `V` 606 (the wake) | `paused_from` records the status; the wake is sent only for a run that admits again. |
| `SetVars` | `S` `setRunVars` 970 | Session, definition and run locks; a new immutable revision. |
| `Delete` | `migrations/workflow-v2-0087.ts` 58; `workflow-v2-0086.ts` 80 | 0087 ends paused runs too; 0086 ended only admitted and running runs. |

| Property | Meaning |
|---|---|
| `Inv_AdmitOnlyAdmitting` | A state is admitted only while the run admits (never while paused). |
| `Inv_PinCurrent` | Each admission pins the KV revision current when it is inserted. |
| `Inv_KvRefusalAdmitting` | `kv_changed` is returned only for a run that admits: inactive wins. |
| `Inv_OrdinalCountsAdmissions` | A refusal uses no ordinal. |
| `Inv_AdmissionOrder` | A state is admitted after its predecessor completed. |
| `Inv_PausedFrom` | `paused` exactly when `paused_from` is set (the 0087 check constraint). |
| `Inv_ExitEndedRun` | Pause is not an end: the controller ends only with its run. |
| `Inv_DeletedNotActive` | A deleted workflow has no active run. |
| `Inv_BegunStaysBegun` | A run its controller began is never again a run that has not begun. |
| `AdmissionSafety` | `TypeOK` and every invariant above. |
| `Live_Terminates`, `Live_ControllerDone` | The run ends; the controller ends. |

`Steps = 2`, `MaxKv = 3`, `MaxEvals = 2`, `MaxAttempts = 1`, `MaxPauses = 2`:
two set_vars during the two evaluations of one attempt reach `KV_CHANGING`
and the run's failure. These bounds do not stand for the code's budget of
five evaluations and five attempts; the control regression "ends the run as
failed with KV_CHANGING" runs that budget on the real runtime.

| Case | Mode | Checked | Expected |
|---|---|---|---|
| `adm-hd-safety` | this commit, every environment action, lost wakes | `AdmissionSafety` | PASS |
| `adm-hd-liveness` | this commit, lost wakes, A4 | `Live_Terminates`, `Live_ControllerDone` | PASS |
| `adm-rv-499541be` | no KV check at commit | `Inv_PinCurrent` | safety violation |
| `adm-df-no-pause-guard` | a paused run admits | `Inv_AdmitOnlyAdmitting` | safety violation |
| `adm-df-kv-before-inactive` | the KV check before the inactive refusal | `Inv_KvRefusalAdmitting` | safety violation |
| `adm-df-paused-refusal-exits` | the controller ends on a paused refusal | `Inv_ExitEndedRun` | safety violation |
| `adm-df-refusal-counts-ordinal` | a refusal counts the ordinal | `Inv_OrdinalCountsAdmissions` | safety violation |
| `adm-df-begin-keeps-admitted` | begin leaves `paused_from` admitted | `Inv_BegunStaysBegun` | safety violation |
| `adm-df-trigger-0086` | the 0086 deletion trigger | `Inv_DeletedNotActive` | safety violation |
| `adm-df-no-paused-backstop` | no backstop timer in the paused wait, lost wakes | `Live_Terminates` | liveness violation |
| `adm-hd-liveness-wake-kept` | no backstop timer, no lost wake (positive control) | `Live_Terminates` | PASS |

Limits:

- Crashes and the idempotent retry of an admission are the run model's
  (`AdmitExec`); here an enter attempt runs to its result.
- The command poll that drops a wake ahead of a command is not modeled: a
  stale wake only adds one refused attempt.
- Continue-as-new while paused is the paused retry: the next execution
  starts at the same admission and reads the pause from the store.

## Lifecycle model

`WorkflowV2Lifecycle.tla` models the start of a live run and the cancels
that can come before its controller begins it: the dispatch after
admission (lost, or skipped for a run that already ended), duroxide's
start, the provider's drop of queue messages for an instance that has not
started, the controller's begin, the parent's recover, a cancel by the
parent, by another agent session (`other`) or by a system actor (`system`),
a cancel receipt that an earlier build stored, and who is told that the run
ended. A cancel records its requester as `controlWorkflowV2Run` does: an
agent's session id, or null for any other actor (`Rec`); the model keeps
the actual requester (`endTruth`) apart from that recorded, nullable value
(`endReq`). `update_workflow` admits only the parent, so `other` and
`system` are service callers, not production entry points; the system actor
is the input of the control regression "tells the parent of a run another
requester's cancel ended before it began" (finding
`be9aa9b3-lifecycle-requester`). Pause before begin is in the admission
model.

Assumption A6 (notification), for the liveness cases that need it: the
workflow has a parent and asked to be told (`NotifyEnabled`), the parent's
authority to receive it holds when a delivery is attempted (`AuthorityLoss
= FALSE`), and each notifier start and delivery succeeds within its retry
budget (the begin activity's store retry policy; the notifier's and the
controller's `persistently` batches), so none fails for good (`NotifyFaults
= FALSE`). Without A6 each notification effect has the outcome the code
gives it (finding `f96d2bea` F2):

- A delivery (`notifyParent`) that finds the parent's authority gone
  records `workflow.parent_notification_skipped` and returns normally
  (`skipped`); its caller goes on as after a delivery, and no later call
  delivers (the dedup by the run's events).
- A delivery that runs out fails its caller. The notifier orchestration
  ends `failed`. The controller takes its failure path (`CtlFallback`):
  `failRun`'s finish keeps the run's end, and `reportEnded` calls
  `notifyParent` once more; the controller completes when that call
  returns, and fails when it runs out too.
- A notifier start that fails for good fails its caller. A cancel or a
  recover request returns an error after its commit (`req` or `rnotify`
  `error`), and a cancel requester may repeat it with its operation id
  (A5). The begin activity fails, and the controller takes its failure
  path. The start of a begin activity whose controller ended fails unseen
  (`zBegin = "lost"`).

A workflow that did not ask is never told. A3 (recover) does not repair a
lost notice: a cancelled run is not active, so recover does not act on it
(finding `be9aa9b3-notification-assumptions`).

| Constant | Kind | Code |
|---|---|---|
| `CancelEndsBeforeBegin` | fix | 369beaf0: a cancel ends a run that has not begun in its own transaction, also on a repeat. Before (ae02665a to 183bb0b0) the receipt was stored and the command queued. |
| `BeginHonorsReceipt` | fix | 31dc9888: begin ends a run that has not begun and has an accepted cancel receipt. |
| `C2Fix` | fix | b1d1d4b9: begin names the parent as that receipt's requester (M1) and starts the notifier for a requester that is not the parent; the cancel service and `notifyParent` do not report the parent's own cancel to it. |
| `LegacyWriter` | migration | Who wrote a receipt that an earlier build stored without ending the run: `"none"`, `"parent"` (M1 holds), or `"other"` or `"system"` (M1 does not hold). |
| `Cancellers` | environment | Who sends a cancel: `parent`, `other` (another agent session) and `system` (a non-agent actor; requester null). |
| `LoseDispatch`, `Interrupts`, `ControllerDeath` | faults | The start after admission never reaches duroxide; a cancel request stops after its commit, and the begin activity runs again after its commit; the controller ends without ending its run, and a begin activity it scheduled may still commit and start the notifier afterwards (`ZombieBeginTx`, `ZombieBeginNotify`, not fair). |
| `NotifyEnabled` | workflow | The workflow has a parent and asked to be told (`notifyParent`). |
| `NotifyFaults` | fault | A notifier start, or a delivery that `notifyParent` attempts, fails for good: its retries run out. |
| `AuthorityLoss` | environment | The parent's authority to be told is gone when a delivery is attempted: `notifyParent` records a skip and returns. A6 is `NotifyEnabled`, not `AuthorityLoss` and not `NotifyFaults`. |
| `DropOrphans` | provider | duroxide-pg drops queue messages of an instance with no row and no history. |
| `Repeats`, `Recovery` | assumptions A5 and A3 | A requester repeats, with its operation id, a cancel that was interrupted after its commit or that returned an error, and the repeat completes; the parent recovers a run that needs it. |

| Lifecycle action | Code | Boundary |
|---|---|---|
| `DispatchSend` / `DispatchLose` | `V` `dispatchWorkflowV2Run` 122 | Skips a run that is not active; the start may never reach duroxide. |
| `Start` / `OrphanDrop` | duroxide 0.1.32; duroxide-pg 0.1.38 `provider.rs` 1132-1161, migrations 0025 and 0026 | A second start of an instance id is ignored; queue messages fetched for an instance with no row and no history are acknowledged, which deletes them. |
| `BeginTx` | `S` `beginRun` 1307, 1315 (the earliest accepted cancel receipt), 1322 (requester attributed to the parent, M1) | Session and run locks, as the cancel's transaction takes. |
| `BeginNotify` / `BeginRetry` | `R` 1018 (activity), 981 (enabled and requester checks), 1038 (notifier start) | After the commit; the activity runs again until the start succeeds. A start that fails for good (`NotifyFaults`) fails the activity, and the controller takes its failure path (`CtlFallback`). |
| `ApplyCmd` / `RunFinish` | `R` 485, 490 (notify with the requester), 425 | The controller reports its run's end at least once. A delivery may record a skip and return (`AuthorityLoss`), or run out (`NotifyFaults`); then the controller takes its failure path. |
| `CtlFallback` | `R` `workflowV2Controller` 453, `failRun` 448, `finishRun` 433; the finish activity 1213 returns a run that ended as it is | The run already ended (`Inv_FallbackAfterEnd`). `reportEnded` calls `notifyParent` once more, with no requester: the controller completes when that call returns, and fails when it runs out. |
| `CancelTx` | `V` `controlWorkflowV2Run` 556, 581 (the requester: an agent's session, otherwise null); `S` `recordRunCancelRequest` 1084, `cancelBeforeBegin` 1116 | Session, definition and run locks; the receipt and the before-begin end in one transaction; a repeat ends a run that has not begun. |
| `CancelFollow` / `CancelInterrupt` | `V` 585 (enqueue), `notifyCancelledBeforeBegin` 225 | After the commit; not transactional with it. A notifier start that fails for good is an error the request returns; its repeat with the operation id starts the notifier again (A5). |
| `RecoverDispatch` / `RecoverEnd` / `RecoverNotify` | `V` `recoverWorkflowV2Run` 257, 285 (dispatch); `S` `recordRecoverDispatch` 696, `finishRun` 1826; `V` `notifyRecoveredRun` 193 | The dispatch receipt is stored before the start. The end commits before the notifier start, which may fail for good: an error the request returns, and the end stays. |
| `CtrlDie` | `R` 412, 893, or an external termination | The controller ends; its run stays as it is. |
| `ZombieBeginTx` / `ZombieBeginNotify` | `R` 1018 (the begin activity) | duroxide does not stop an activity of an instance that ended: a begin activity in flight may still commit and start the notifier, and that start may fail for good, unseen (not fair). |
| `NotifierRun` | `R` `workflowV2Notify` 743, `notifyParent` 1374, 1379 (enabled), 1381 (the requester the end names), 1383 (told or skipped already), 1385 (authority skip) | At least once, with the stable client message id. A delivery records a skip and returns when the parent's authority is gone (`AuthorityLoss`: the notifier completes), or runs out (`NotifyFaults`: the notifier fails). |

| Property | Meaning |
|---|---|
| `Inv_AcceptedCancelWins` | A cancel accepted before the run began wins: the run's work never runs to its end (C1). Its controller may begin it, then applies the queued cancel before it admits anything. |
| `Inv_EndedBeforeBegin` | This commit ends such a run before its controller begins it: in the cancel's transaction (369beaf0), or at begin (31dc9888). |
| `Inv_NoSelfNotice` | The parent is never told of a cancel it asked for (C2). |
| `Inv_EndNamesRequester` | A before-begin end records no requester (null) exactly when a system actor asked: an agent's cancel, and a legacy receipt under `C2Fix`, name a session. |
| `Inv_AttributionTruthful` | The recorded requester is the one that asked (null for a system actor). For a legacy receipt it holds under M1 only. |
| `Inv_NoticeEnabled` | The parent is told only when the workflow asked for it. |
| `Inv_FallbackAfterEnd` | The controller takes its failure path only for a run that already ended, so `failRun`'s finish keeps that end. |
| `LifecycleSafety` | `TypeOK` and the seven invariants above. |
| `Live_OtherTold` | The parent is told of a run that a requester other than the parent (an agent or a system actor) ended with its cancel. Needs A5 and A6. |
| `Live_OtherToldOnceStarted` | The same, at least when the run's controller starts after a before-begin end. Needs A6, not A5. |
| `Live_OtherOutcomeVisible` | Without A6: the parent is told, a delivery recorded a skip, or a notification visibly failed for good (the notifier or the controller failed, or a cancel request returned an error). Needs A5. It replaces `Live_OtherToldOrFailed` of `f96d2bea`, whose failure ghost did not tell these outcomes apart. |
| `Wit_SkipCompletes` | Witness: a delivery recorded a skip, and the notifier completed. |
| `Wit_ErrorRepeated` | Witness: a request returned an error, and its repeat with the same operation id completed. |
| `Wit_FallbackTells` | Witness: the begin activity's notifier start failed for good, and the controller's failure path told the parent and completed. |
| `Wit_FallbackFails` | Witness: the controller's failure path ran out too, and the controller failed. |
| `Wit_RecoverStartFails` | Witness: a recover's notifier start failed for good. |
| `Wit_ZombieStartLost` | Witness: the notifier start of a begin activity whose controller ended failed for good. |

| Case | Mode | Checked | Expected |
|---|---|---|---|
| `lc-hd-safety` | this commit, an earlier build's receipt by the parent (M1), the parent, another agent and a system actor, every fault including `NotifyFaults`, `AuthorityLoss` and controller death, A5 | `LifecycleSafety` | PASS |
| `lc-hd-safety-fresh` | the same with no earlier build's receipt | `LifecycleSafety` | PASS |
| `lc-hd-notify-disabled` | as `lc-hd-safety`, and the workflow asked not to be told | `LifecycleSafety` | PASS |
| `lc-hd-live-other` | this commit, the parent and another agent, A5, A6 | `Live_OtherTold` | PASS |
| `lc-hd-live-other-started` | the same, no repeat | `Live_OtherToldOnceStarted` | PASS |
| `lc-hd-live-system` | this commit, the parent and a system actor (requester null), A5, A6 | `Live_OtherTold` | PASS |
| `lc-hd-live-system-started` | the same, no repeat (the control regression's input) | `Live_OtherToldOnceStarted` | PASS |
| `lc-hd-notify-faults-qualified` | this commit, the parent and another agent, A5, without A6 (`NotifyFaults`, `AuthorityLoss`) | `Live_OtherOutcomeVisible` | PASS |
| `lc-lim-notify-faults` | this commit, the parent and another agent, A5, `NotifyFaults` | `Live_OtherTold` | liveness violation: the stated limit (A6 is needed for a notice) |
| `lc-lim-authority-skip` | the same with `AuthorityLoss` instead of `NotifyFaults` | `Live_OtherTold` | liveness violation: the stated limit (a skip is not a notice) |
| `lc-lim-outcome-needs-repeat` | as `lc-hd-notify-faults-qualified`, no repeat | `Live_OtherOutcomeVisible` | liveness violation: the stated limit (A5) |
| `lc-lim-other-told-needs-repeat` | this commit, A6, no repeat | `Live_OtherTold` | liveness violation: the stated limit (a notice lost after the commit stays lost when no controller starts and the requester does not repeat) |
| `lc-rv-183bb0b0` | the cancel is queued and dropped | `Inv_AcceptedCancelWins` | safety violation (C1) |
| `lc-rv-369beaf0` | an earlier build's receipt and a late start | `Inv_AcceptedCancelWins` | safety violation |
| `lc-rv-31dc9888` | begin's repair records no requester; the parent repeats | `Inv_NoSelfNotice` | safety violation (C2) |
| `lc-rv-31dc9888-live-other-started` | 31dc9888, no repeat | `Live_OtherToldOnceStarted` | liveness violation (C2) |
| `lc-df-m1-broken` | this commit with an earlier build's receipt by another requester | `Inv_AttributionTruthful` | safety violation |
| `wit-lc-skip-completes` | as `lc-hd-notify-faults-qualified` without `NotifyFaults` | `Wit_SkipCompletes` | safety violation (witness) |
| `wit-lc-error-repeated` | as `lc-hd-notify-faults-qualified` without `Interrupts` | `Wit_ErrorRepeated` | safety violation (witness) |
| `wit-lc-fallback-tells` | as `lc-hd-notify-faults-qualified` | `Wit_FallbackTells` | safety violation (witness) |
| `wit-lc-fallback-fails` | as `lc-hd-notify-faults-qualified` | `Wit_FallbackFails` | safety violation (witness) |
| `wit-lc-recover-start-fails` | as `lc-hd-notify-faults-qualified` with controller death | `Wit_RecoverStartFails` | safety violation (witness) |
| `wit-lc-zombie-start-lost` | as `lc-hd-notify-faults-qualified` with controller death | `Wit_ZombieStartLost` | safety violation (witness) |

Limits:

- `notice` records that the parent was told at least once; the stable
  client message id, the recent-id window and the full receipt and
  terminal payload bytes are not modeled (the control regressions compare
  them). A `notifyParent` call is one step here, after its dedup read: the
  code reads the run's events first, so two calls at once (the notifier and
  the controller's failure path) may both deliver (with one client message
  id), or one deliver and the other record a skip.
- The provider's drop is conservative: any message queued before the
  instance's start is processed may be dropped.
- No deletion here: the run model and the session command model have it.
- `CancelFollow` decides the enqueue from the run's current status; the code
  uses the run its transaction returned. They differ only when the run
  ended between the commit and the follow-up, where the code enqueues a
  command that no controller applies (a moot enqueue, omitted here).
- `NotifyFaults` is a start or a delivery that runs out. A store outage
  that exhausts anything else is not modeled here: a `notifyParent` call
  with nothing to deliver (its reads), the record of a skip, the failure
  path's finish, or a cancel request's enqueue. Such store faults are the
  run model's (`ControllerFault`).
- After a recover's notifier start failed, a repeat of the recover starts
  it again (`V` `recoverWorkflowV2Run` replay); the model does not repeat
  it, as no property here concerns the notice of a recover's end.
- `RunFinish` abstracts the run's own work. It needs an empty queue: the
  controller polls its queue before each admission, so a command queued
  before begin is applied first. The race of a late command with the
  terminal's finish is the run model's (`PollCommand`, `CancelTx`).
- A controller terminated before or during begin may leave its begin
  activity running: it may still commit, and then start the notifier
  (`ZombieBeginTx`, `ZombieBeginNotify`), fail that start unseen, or never
  complete. A notice lost that way is not repaired by recover (A3); the
  liveness cases exclude controller death.

## Session command model

`WorkflowV2SessionCommands.tla` models one lifecycle command (cancel or
delete; done takes cancel's path) that a parent's durable session sends to
its v2 workflow child through the `sendCommandToSession` activity. The
activity is at least once: attempt 1 may stop after any step, and attempt
2 is its redelivery, which may overlap it. Attempt 3 is a different
request that reuses the command's id. The child's controller may begin its
run, end it, and apply a queued command, and another path may delete the
child. With `Legacy`, the run starts from history: an earlier build
(9fda34bd) stored this delete's receipt as queued for a begun run, its
attempt stopped before the command was applied (the command may wait in the
queue when the run is still running), the child is live, and its run is
running or already completed. Attempt 2 is this build's same-id repeat,
which must delete the child and remove its facts while the receipt stays as
stored and an ended run keeps its result (the session-commands regression
"applies an accepted delete whatever its child's run did since"; finding
`be9aa9b3-command-legacy-receipt`).

| Constant | Kind | Code |
|---|---|---|
| `DeleteInStore` | fix | 0f373abc: every new delete is applied in the store. Before (9fda34bd) a begun run's delete was queued for its controller. |
| `ReplayRepair` | fix | 0f373abc: a repeat of an accepted delete whose child is live deletes it (`S` `recordSessionCommand`, the replay branch). FALSE alone is a deliberate fault. |
| `Legacy` | history | `"none"`, or an earlier build's queued delete receipt with the run `"running"` or `"ended"`. |
| `DeletedChildPath` | fix | b1d1d4b9: a deleted child, seen by the link read or by the transaction, gets the receipt check and a delete's facts cleanup. Before (31dc9888) only the link path read the receipt, and the transaction path answered applied with neither. |
| `Command`, `Conflict`, `OtherDelete` | environment | The command; a different request with its id; another deletion path. |

| Session command action | Code | Boundary |
|---|---|---|
| `StartAtt` / `LoseFirst` | `session-proxy.ts` 1085 (`scheduleActivity`), 5862 | At least once: a worker crash redelivers the activity, and the redelivery may overlap the first attempt. |
| `ReadLink` | `V` `applySessionCommandToWorkflowV2` 652; `S` `readSessionLink` 1223 | Before any lock; the caller's authority (a regression checks it) comes next. |
| `StoreTx` | `S` `recordSessionCommand` 1166, 1197 (a repeat applies an accepted delete: `ReplayRepair`) | Session, definition and run locks; the receipt with the soft delete (trigger) or the before-begin end in one transaction; a repeat returns the receipt as stored. |
| `DeletedChild` | `V` `deletedChild` 680, 685, 693; `S` `readOperationReceipt` 641 | Another request's receipt is refused; a delete removes the facts (idempotent). |
| `After` / `Cleanup` / `Enqueue` | `V` 698 (facts cleanup), 703 (enqueue) | After the commit. |
| `CtlBegin` / `RunEnd` / `CtlApply` / `CtlExit` | `S` `beginRun` 1307; `R` 485, 1361 | The first run end stands; a command queued for a controller that ended is not applied. |
| `DeleteOther` | `cms_soft_delete_session` and the 0087 trigger 58 | Another deletion path, with its facts cleanup. |

| Property | Meaning |
|---|---|
| `Inv_DeleteAnswerClean` | An attempt that answers applied for the delete has deleted the child and removed its facts. |
| `Inv_ConflictRefused` | A request whose id holds another request's receipt is refused. |
| `Inv_CancelBeforeBeginWins` | A cancel accepted before the run began wins. |
| `CommandSafety` | `TypeOK` and the three invariants above. |
| `Prop_ReceiptImmutable` | A stored receipt is never rewritten: the repeat that applies an earlier build's queued delete leaves it queued. |
| `Prop_RunEndKept` | The run's first end stands: deleting a child whose run ended keeps that run's result. |
| `Live_DeleteTakesEffect` | An accepted delete takes effect: the child is deleted and its facts are removed, whatever its run does. |
| `Wit_ReplayRepair` | Witness, expected to be violated: the replay repair branch is reached. |

| Case | Mode | Checked | Expected |
|---|---|---|---|
| `cmd-hd-delete` | this commit, delete, overlapping redelivery, a conflicting request, another deletion | `CommandSafety`, `Prop_ReceiptImmutable`, `Prop_RunEndKept` | PASS |
| `cmd-hd-delete-live` | the same | `Live_DeleteTakesEffect` | PASS |
| `cmd-hd-cancel` | this commit, cancel, the same environment | `CommandSafety`, `Prop_ReceiptImmutable`, `Prop_RunEndKept` | PASS |
| `cmd-hd-legacy-running` | this commit, an earlier build's queued delete receipt, the run running, its same-id repeat, a conflicting request, another deletion | `CommandSafety`, `Prop_ReceiptImmutable`, `Prop_RunEndKept` | PASS |
| `cmd-hd-legacy-ended` | the same, the run already completed | the same | PASS |
| `cmd-hd-legacy-running-live` | as `cmd-hd-legacy-running` | `Live_DeleteTakesEffect` | PASS |
| `cmd-hd-legacy-ended-live` | as `cmd-hd-legacy-ended` | `Live_DeleteTakesEffect` | PASS |
| `wit-cmd-legacy-repair` | this commit, the queued receipt, the run completed | `Wit_ReplayRepair` | safety violation (witness) |
| `cmd-df-no-replay-repair` | the same without the replay repair only | `Live_DeleteTakesEffect` | liveness violation |
| `cmd-rv-9fda34bd` | a begun run's delete is queued, and the run ends first | `Live_DeleteTakesEffect` | liveness violation (D1) |
| `cmd-rv-31dc9888` | the transaction path answers applied without the cleanup | `Inv_DeleteAnswerClean` | safety violation (D2) |
| `cmd-rv-31dc9888-conflict` | the transaction path answers applied without the receipt check | `Inv_ConflictRefused` | safety violation (D2) |

Limits:

- One interruption: attempt 1 may stop, and its redelivery completes.
- The caller's authority is checked before the store (a regression checks
  it); the model's commands come from the parent.
- The cancel activity's delete of a queued delete (9fda34bd) is modeled as
  removing the facts too, which only helps that revision.
- `After` decides the enqueue from the run's current status; the code uses
  the run its transaction returned (a moot enqueue for a run that ended
  meanwhile is omitted, as in the lifecycle model).
- The receipt is two digests and an applied label; its bytes, kind field,
  creation time, the terminal payload and node winners, a facts cleanup
  that fails and later fact writers are not modeled (the session-commands
  regressions compare the stored rows).

## Receive model

`WorkflowV2Receive.tla` models messaging receive states and typed input
(controller 1.7.0, IR version 5). A run enters receive state 1 and, when
that one received or elapsed, receive state 2. Both name one sender
(`From`: a session, `p` or `q`, or any sender) and race a wait of `Secs`
in the store's clock, or none (`HasWait = FALSE`). Two inputs are
given, each in two steps: the service's check on the catalog's rows
(`SendCheck`) and the store's acceptance (`SendAccept`). A sender's session
may be deleted (`Delete`), which does not end the workflow, and the run may
be cancelled. One integer clock is the store's, which the controller reads
too (skew is the wait model's). Times are integers in one abstract unit:
`Secs`, `Ttl` and the clock count the same unit, and only their order and
differences matter; they are not seconds or microseconds. The controller
may be late at any step (`Tick`, below), so an input kept unclaimed can
expire before the next receive is entered. It checks the receive review
findings R2 to R5 against their earlier commits, and the claims, the
deadline race, expiry, the durable order and the contract and correlation
match against deliberate faults.

The authority rule is a constant here (`Authorized`: the sessions it allows
while they are live). Its cases (unknown, partial, blank and system
ownership, exact identities, a parent in both records) are the regressions'
(R1); the model checks when the rule is decided, not the rule.

| Constant | Kind | Code |
|---|---|---|
| `From`, `Sender1`, `Sender2`, `Authorized`, `Matching` | environment | The receives' sender; each input's sender; the sessions the authority rule allows; the inputs whose contract and correlation match. |
| `Secs`, `HasWait`, `Ttl`, `MaxPre` | bounds | The receives' wait; how long an input stays eligible (`ttl_seconds`); the clock's free range (with a wait, receive state 1 is admitted by `MaxPre`). The clock ends at `ClockCap = MaxPre + 2 * Secs`. |
| `Deletes`, `Cancels` | environment | A sender's session is soft-deleted; the run is cancelled. |
| `AdmitDecides`, `AcceptDecides` | fix 63f55d71 (R5) | The admission (`S` `enterNode`) and the acceptance (`S` `acceptInput`) decide the sender under the session locks. FALSE: 6a2819f4, which kept the resolution's decision and the service's check. |
| `OneReading` | fix 6a2819f4 (R3) | One reading of the store's clock decides an entry. FALSE: ba01ef8e selected at one reading and inserted at a later one (`AdmitInsert`). |
| `Granule` | fix 6a2819f4 (R2) | 1: exact times. 2: ba01ef8e compared a deadline with an acceptance time truncated to a coarser unit (a microsecond deadline with a millisecond `Date`); here the acceptance time is truncated to an even number of units. Any granule coarser than one unit gives the same boundary; 2 is not a scale of microseconds to milliseconds. |
| `ReceiptStored` | fix 6a2819f4 (R4) | A repeat returns the acceptance's stored receipt. FALSE: ba01ef8e returned the input's current claim. |
| `EntryClaim`, `IngressClaim`, `DeadlineCheck`, `ConsumeOnClaim`, `EarliestFirst`, `FitCheck`, `Cas` | code | The claim at entry, the claim in the acceptance, its deadline check, the consumption mark, the durable order, the contract and correlation match of both claims, the elapse's compare-and-swap. FALSE: deliberate faults. |

| Receive action | Code | Boundary |
|---|---|---|
| `Resolve` | `R` `resolveReceive` 937, called in the enter activity 1122; the refusals it carries 968 | Before the admission's transaction: the definition's parent or the binding's session, frozen for this entry. It decides nothing about the sender; 6a2819f4 decided its authority here. |
| `Admit` / `AdmitInsert` | `S` `enterNode` 1381, `lockInputSessions` 509 (514, the locks), 1462 (a refused sender), 1479 (the one reading), 1485 (the earliest eligible input) | The session rows in ascending session id (the sender's `FOR SHARE`), then the run. One reading decides the input taken, `entered_at`, `consumed_at` and the deadline. `AdmitInsert` is ba01ef8e's later insert only. |
| `AdmitEnded` | `S` 1438 | A run that ended admits nothing; the controller ends. |
| `SendCheck` | `V` `sendWorkflowInputV2` 758; `A` `decideTypedInputAuthority` 62 | The catalog's rows; an earlier refusal, and the only check of a repeat. |
| `SendAccept` | `S` `acceptInput` 1687, 1724 (the sender), 1730 (the one reading), 1761 (the waiting receive, before its deadline), 1783 (the receipt) | One transaction under the session and run locks: the sender, `accepted_at`, `expires_at`, the claim and the receipt. The ghost `mDue` records whether a receive still waited at or after its deadline (the input is late for it). |
| `Repeat` | `S` 1722 | The stored receipt, after the service's check allowed the sender. |
| `Delete` | `cms-migrations.ts` `cms_soft_delete_session`; `S` 514 | Waits for a transaction that holds the sender's row lock; the workflow stays live. With `AdmitDecides`, not between ba01ef8e's selection and insert (the admission holds the sender's lock). |
| `Elapse` | `R` 628 (call); `S` `elapseWait` 1624, 1634 (guard) | Compare-and-swap from pending at or after the deadline. |
| `Collect` | `R` 642 (collect), 649 (routing) | Receive state 1 routes to receive state 2; a refusal routes to a failed terminal. |
| `Cancel` | `R` 485; `S` `finishRun` 1826; `migrations/workflow-v2-0087.ts` 58 | The run's end decides a pending receive in its transaction. |
| `Tick` | none | The store's clock (PostgreSQL `clock_timestamp()`), assumed never to go back. It advances freely to `MaxPre`; while a pending receive's deadline is ahead; and while the controller is late in a running run (a due wait not yet elapsed, a result not yet collected, receive state 2 not yet resolved or admitted), as long as each wait it has yet to begin still ends within `ClockCap`. With a wait, receive state 1 is admitted by `MaxPre` and receive state 2 by `ClockCap - Secs`; every deadline can still pass. An input kept unclaimed may expire during such a delay; the next entry skips it (`S` 1484). |

| Property | Meaning |
|---|---|
| `Inv_NoMissedClaim` | A receive never waits before its deadline while an input it could take exists: one accepted before it was entered is taken at entry, one accepted while it waits is taken at once (R08). |
| `Inv_NotLate` | An input taken in its own acceptance was accepted before the receive's deadline, compared exactly (R2). |
| `Inv_EntryUnexpired` | An input taken at entry was accepted before the entry and was unexpired at the entry's one reading, its `entered_at` (R3). |
| `Inv_TakeOnce` | An input is taken by at most one receive, and the receive that took it and the input's consumption name each other. |
| `Inv_TakeFits` | A receive takes only an input that fits it (contract, correlation, sender). |
| `Inv_InOrder` | An entry takes the earliest eligible input: no input earlier in the durable order is still eligible. |
| `Inv_AdmittedSenderOk` | A receive is admitted only while its sender is live and allowed (R5). |
| `Inv_AcceptedSenderOk` | An input is accepted only while its sender is live and allowed (R5). |
| `Inv_RepeatReceipt` | A repeat returns the acceptance's receipt, whatever happened to the input since (R4). |
| `Inv_RefusedBare` | A refused receive has no deadline and takes nothing. |
| `ReceiveSafety` | `TypeOK` and the ten invariants above. |
| `Prop_FirstResultKept` | The first stored result of a receive is kept. |
| `Live_ReceiveDecided` | A pending receive is eventually decided. Needs its wait. |
| `Live_RunEnds` | The controller eventually ends. |
| `Wit_EntryClaim`, `Wit_IngressClaim` | Witnesses: a receive takes an input at its entry; an input takes the waiting receive. |
| `Wit_TimerWinKeepsInput` | Witness: the timer wins and the input is kept. An input accepted while receive state 1 still waited at or after its deadline is late for it (its receipt names no receive), stays unclaimed while that wait elapses, and receive state 2 takes it at its entry. |
| `Wit_KeptBetween` | Witness: an input given after receive state 1 elapsed, while no receive waits, is kept, and receive state 2 takes it at its entry. |
| `Wit_LateInputExpires` | Witness: an input late for receive state 1 is kept unclaimed, but expires before receive state 2's delayed entry, which does not take it and waits. |
| `Wit_RefusedAtAdmission` | Witness: a sender that the resolution allowed is deleted, and the admission fails the receive. |
| `Wit_RefusedAtAcceptance` | Witness: a sender that the service's check allowed is deleted, and the acceptance refuses its input. |

| Case | Mode | Checked | Expected |
|---|---|---|---|
| `rcv-hd-safety` | this commit, sender `p`, inputs from `p` and `q`, deletions and the cancel | `ReceiveSafety`, `Prop_FirstResultKept` | PASS |
| `rcv-hd-safety-any` | the same, any sender | the same | PASS |
| `rcv-hd-safety-forbidden` | the same, sender `q`, which the rule does not allow | the same | PASS |
| `rcv-hd-safety-nowait` | as `rcv-hd-safety`, no wait | the same | PASS |
| `rcv-hd-safety-mismatch` | as `rcv-hd-safety-any`, input 2 of another contract or correlation (`Matching = {1}`) | the same | PASS |
| `rcv-hd-live` | as `rcv-hd-safety` | `Live_ReceiveDecided`, `Live_RunEnds` | PASS |
| `rcv-hd-live-any` | as `rcv-hd-safety-any` | `Live_ReceiveDecided`, `Live_RunEnds` | PASS |
| `rcv-lim-no-wait` | as `rcv-hd-safety-nowait` | `Live_ReceiveDecided` | liveness violation: the stated limit (with no wait, only an input or the run's end decides a receive) |
| `wit-rcv-entry-claim` | as `rcv-hd-safety` | `Wit_EntryClaim` | safety violation (witness) |
| `wit-rcv-ingress-claim` | as `rcv-hd-safety` | `Wit_IngressClaim` | safety violation (witness) |
| `wit-rcv-timer-win-keeps-input` | as `rcv-hd-safety` | `Wit_TimerWinKeepsInput` | safety violation (witness) |
| `wit-rcv-kept-between` | as `rcv-hd-safety` | `Wit_KeptBetween` | safety violation (witness) |
| `wit-rcv-late-input-expires` | as `rcv-hd-safety` | `Wit_LateInputExpires` | safety violation (witness) |
| `wit-rcv-refused-at-admission` | as `rcv-hd-safety` | `Wit_RefusedAtAdmission` | safety violation (witness) |
| `wit-rcv-refused-at-acceptance` | as `rcv-hd-safety` | `Wit_RefusedAtAcceptance` | safety violation (witness) |
| `rcv-rv-ba01ef8e-coarse` | this commit with ba01ef8e's truncated comparison (`Granule = 2`) | `Inv_NotLate` | safety violation (R2) |
| `rcv-rv-ba01ef8e-two-readings` | this commit with ba01ef8e's two readings of an entry | `Inv_EntryUnexpired` | safety violation (R3) |
| `rcv-rv-ba01ef8e-receipt-view` | this commit with ba01ef8e's repeat | `Inv_RepeatReceipt` | safety violation (R4) |
| `rcv-rv-6a2819f4-admit` | this commit with 6a2819f4's admission | `Inv_AdmittedSenderOk` | safety violation (R5) |
| `rcv-rv-6a2819f4-accept` | this commit with 6a2819f4's acceptance | `Inv_AcceptedSenderOk` | safety violation (R5) |
| `rcv-df-no-entry-claim` | this commit without the entry's claim | `Inv_NoMissedClaim` | safety violation |
| `rcv-df-no-ingress-claim` | this commit without the acceptance's claim | `Inv_NoMissedClaim` | safety violation |
| `rcv-df-no-deadline-check` | this commit without the deadline check | `Inv_NotLate` | safety violation |
| `rcv-df-no-consume` | this commit without the consumption mark | `Inv_TakeOnce` | safety violation |
| `rcv-df-no-cas` | this commit without the elapse's compare-and-swap | `Prop_FirstResultKept` | safety violation |
| `rcv-df-latest-first` | as `rcv-hd-safety-any`, the latest eligible input first | `Inv_InOrder` | safety violation |
| `rcv-df-no-fit-check` | as `rcv-hd-safety-mismatch`, without the contract and correlation match | `Inv_TakeFits` | safety violation |

Each `rcv-rv-` case sets one switch of its earlier commit and keeps this
commit's others, so its counterexample shows that one boundary. It models
that boundary as the earlier source shows it; it is not an execution of the
earlier build, and no native test was run against those builds.

Limits:

- One run with two receive states in sequence and one sender; one receive
  is pending at a time (parallel states are not implemented), so the
  acceptance's choice of the earliest waiting receive is not exercised.
- The controller's delays are bounded: with a wait, receive state 1 is
  admitted by `MaxPre` and receive state 2 by `ClockCap - Secs`, so
  receive state 2's entry follows receive state 1's decision at time `t`
  by at most `ClockCap - Secs - t`. A longer delay is not explored.
  Admitting a receive whose deadline would pass `ClockCap` is never
  allowed, so each deadline can still pass in the model.
- The authority rule is a constant. That the store reads both sessions and
  their owners in one statement after the locks, the owner's single
  assignment and the placeholder merge are not modeled; the store
  regressions refuse another user's, an unowned, a missing and a deleted
  session in the acceptance itself.
- A sender deleted after a receive's admission does not change that
  admission: the receive waits for an input that can no longer come, until
  its wait elapses or the run ends (`rcv-lim-no-wait` shows that a
  receive with no wait is decided only by an input or the run's end).
- The service's check, the store's acceptance, an admission and a
  deletion are each one atomic step. The session-row locks serialize the
  last three; a lock cycle with another writer, which PostgreSQL aborts
  and the caller retries, is not modeled. A retry of a committed
  admission, which returns it as stored, has no action here (its
  regression is native).
- The model keeps a receive's state, outcome and the input it took, and an
  input's receipt as its `claimedBy`; the winner, the receive spec, the
  output and completion time are not variables, so `Prop_FirstResultKept`
  and `Inv_RefusedBare` say nothing about them (the regressions check
  them).
- Not modeled; the messaging regressions check examples of them, which is
  not a proof: the inbox bounds and the rate window, pause (a paused run
  takes input and admits nothing), continue-as-new, controller death and
  crashes, the wake hint, payload validation, operation conflicts (another
  request with an operation id), the receipt's request and payload hashes,
  and the refusal to repeat an input stored without a receipt.
