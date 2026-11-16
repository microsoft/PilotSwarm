# Formal configuration summary

This file answers how many configurations check each model and where to find their exact settings. For example, `WfIdleWake` has seven active configurations for idle-wake counting and command preservation.

Source: `4fa702dc8b078b93c3e26339dc833b53d8acfee4`. Counts below come from each folder's `cases.tsv`. They count configurations that name a module as their entry point, not successful TLC runs. A module with zero entry configurations is imported by another model or wrapper.

The linked `cases.json` files contain individual case IDs, bounds, specifications, invariant/property lists and expected results. `tlc-templates.json` defines rendering details. The `.cfg` files are generated and are not committed. See the [module inventory](formal-modules.md) for predicates and the [test and model guide](tests-and-models.md#formal-models) for recorded results.

## How to run

Each table uses its folder's runner. Run `check-packet.sh` first, then `run-tlc.sh`, with Java 17 or later, Python 3 and the pinned `tla2tools.jar` in `TLA_TOOLS`. The commands below are examples to run from the repository root; `<tools>` and `<out>` are local directories.

The runner generates the configurations, runs SANY, then TLC for the active cases. Defaults are two TLC workers, a 2 GiB heap and 300 s per case. Read `executions.tsv` and each `tlc.log`; a timeout is partial, not a pass. TLC runs locally or on demand, not in CI. Source: [runner](../../../docs/formal/workflow/run-tlc.sh).

## session-orchestration

19 modules; 184 active configurations. Sources: [case list](../../../docs/formal/session-orchestration/cases.tsv), [case settings](../../../docs/formal/session-orchestration/cases.json), [templates](../../../docs/formal/session-orchestration/tlc-templates.json).

```sh
cd docs/formal/session-orchestration
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`CarriedGiveBack`](../../../docs/formal/session-orchestration/CarriedGiveBack.tla) | 34 | Return a dropped prompt's child digest and rehydration notice without overwriting newer data | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L3494) |
| [`ChildDelivery`](../../../docs/formal/session-orchestration/ChildDelivery.tla) | 7 | Child-update digest rank, ownership and cancellation of its carrier | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L1111) |
| [`DeliveryIdentity`](../../../docs/formal/session-orchestration/DeliveryIdentity.tla) | 5 | The bounded recent-message-ID window and retries | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L903) |
| [`DigestWindow`](../../../docs/formal/session-orchestration/DigestWindow.tla) | 5 | Child digest age, order and delivery within a batch window | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L5913) |
| [`ForcedRefresh`](../../../docs/formal/session-orchestration/ForcedRefresh.tla) | 6 | Forced continue-as-new preserves queued, carried and due work | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L5731) |
| [`IntakeDrain`](../../../docs/formal/session-orchestration/IntakeDrain.tla) | 15 | Due intake writes, carried arrival, history-cap handoff refusal and version routing | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L2653) |
| [`MergeRule`](../../../docs/formal/session-orchestration/MergeRule.tla) | 15 | Separate human, agent, system and unknown prompt authors at a merge boundary | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L6285) |
| [`OwnedRetry`](../../../docs/formal/session-orchestration/OwnedRetry.tla) | 21 | Retry-owned prompt/key, carried retry state and terminal Workflow-turn failure reporting | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L2161) |
| [`RehydrationNotice`](../../../docs/formal/session-orchestration/RehydrationNotice.tla) | 11 | Notice ownership across prompt/timer handoff, cancellation and hydration give-up | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L1527) |
| [`RollingDeploy`](../../../docs/formal/session-orchestration/RollingDeploy.tla) | 2 | Old workers dispatching an unregistered new orchestration version | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L6215) |
| [`SnapshotWarmDrop`](../../../docs/formal/session-orchestration/SnapshotWarmDrop.tla) | 7 | Drop an unsettled aborted warm run before committing a snapshot | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L1921) |
| [`TimerGeneration`](../../../docs/formal/session-orchestration/TimerGeneration.tla) | 7 | A due timer behind a prompt that changes or cancels its schedule | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L489) |
| [`TimerHandoff`](../../../docs/formal/session-orchestration/TimerHandoff.tla) | 2 | Release and restoration of a timer when queued work cannot run | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L245) |
| [`TimerInterrupt`](../../../docs/formal/session-orchestration/TimerInterrupt.tla) | 5 | Remaining wait time, rounding and interruption by a prompt | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L319) |
| [`TimerStarvation`](../../../docs/formal/session-orchestration/TimerStarvation.tla) | 4 | Finite, gapped and continuous prompt backlogs versus timer progress | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L759) |
| [`TurnCommit`](../../../docs/formal/session-orchestration/TurnCommit.tla) | 3 | One turn across crash/retry; snapshot key and saved-result adoption; limits of model-call at-most-once | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L1431) |
| [`TurnLoop`](../../../docs/formal/session-orchestration/TurnLoop.tla) | 5 | FIFO, input batching, bootstrap, cancellation, queue bounds and finite-input progress | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L3) |
| [`VersionHandoff`](../../../docs/formal/session-orchestration/VersionHandoff.tla) | 19 | Recorded 1.0.82 replay and input/queue/timer handoff to 1.0.83 | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L4966) |
| [`WorkerShutdown`](../../../docs/formal/session-orchestration/WorkerShutdown.tla) | 11 | Bounded shutdown, overlapping unfinished phases and legacy snapshot loss limit | Folder runner; [cases](../../../docs/formal/session-orchestration/cases.json#L3095) |

## workflow

7 modules; 129 active configurations. Sources: [case list](../../../docs/formal/workflow/cases.tsv), [case settings](../../../docs/formal/workflow/cases.json), [templates](../../../docs/formal/workflow/tlc-templates.json).

```sh
cd docs/formal/workflow
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WorkflowAdmission`](../../../docs/formal/workflow/WorkflowAdmission.tla) | 10 | KV pinning, admission counts, pause/begin and inactive-first guards | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L3) |
| [`WorkflowLifecycle`](../../../docs/formal/workflow/WorkflowLifecycle.tla) | 20 | Lost dispatch, pre-begin cancel, recovery, requester attribution and notification | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L1616) |
| [`WorkflowReceive`](../../../docs/formal/workflow/WorkflowReceive.tla) | 27 | Buffered typed input, matching, TTL, one consumption and timer race | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L2092) |
| [`WorkflowRun`](../../../docs/formal/workflow/WorkflowRun.tla) | 30 | Controller/effect scheduling, single result, route/catch-all and terminal cleanup | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L662) |
| [`WorkflowSend`](../../../docs/formal/workflow/WorkflowSend.tla) | 19 | Outbox delivery, stable identity, recipient admission, retries and cancellation | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L3228) |
| [`WorkflowSessionCommands`](../../../docs/formal/workflow/WorkflowSessionCommands.tla) | 12 | Parent lifecycle commands when a controller is absent or delayed | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L364) |
| [`WorkflowWait`](../../../docs/formal/workflow/WorkflowWait.tla) | 11 | Store-clock deadline versus controller timer, skew and wait completion | Folder runner; [cases](../../../docs/formal/workflow/cases.json#L3579) |

## workflow/continued-session

1 modules; 101 active configurations. Sources: [case list](../../../docs/formal/workflow/continued-session/cases.tsv), [case settings](../../../docs/formal/workflow/continued-session/cases.json), [templates](../../../docs/formal/workflow/continued-session/tlc-templates.json).

```sh
cd docs/formal/workflow/continued-session
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WfContinuedSession`](../../../docs/formal/workflow/continued-session/WfContinuedSession.tla) | 101 | Visit-bound results/stops, replacement only after end, deleted-session safety and owed ends | Folder runner; [cases](../../../docs/formal/workflow/continued-session/cases.json#L3) |

## workflow/fork-join

3 modules; 91 active configurations. Sources: [case list](../../../docs/formal/workflow/fork-join/cases.tsv), [case settings](../../../docs/formal/workflow/fork-join/cases.json), [templates](../../../docs/formal/workflow/fork-join/tlc-templates.json).

```sh
cd docs/formal/workflow/fork-join
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`AbsForkJoin`](../../../docs/formal/workflow/fork-join/AbsForkJoin.tla) | 4 | Abstract named fork decision and all branch dispositions | Folder runner; [cases](../../../docs/formal/workflow/fork-join/cases.json#L3) |
| [`WfForkJoin`](../../../docs/formal/workflow/fork-join/WfForkJoin.tla) | 65 | Implemented named branch bodies, atomic join/cut, stop fence and abstract refinement | Folder runner; [cases](../../../docs/formal/workflow/fork-join/cases.json#L167) |
| [`WfForkTokens`](../../../docs/formal/workflow/fork-join/WfForkTokens.tla) | 22 | Alternative token/free-join design and compiled-arrow comparison; not shipped | Folder runner; [cases](../../../docs/formal/workflow/fork-join/cases.json#L5174) |

## workflow/idle-wake

1 modules; 7 active configurations. Sources: [case list](../../../docs/formal/workflow/idle-wake/cases.tsv), [case settings](../../../docs/formal/workflow/idle-wake/cases.json), [templates](../../../docs/formal/workflow/idle-wake/tlc-templates.json).

```sh
cd docs/formal/workflow/idle-wake
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WfIdleWake`](../../../docs/formal/workflow/idle-wake/WfIdleWake.tla) | 7 | Idle-wake counting bounds history and preserves commands before continue-as-new | Folder runner; [cases](../../../docs/formal/workflow/idle-wake/cases.json#L3) |

## workflow/orchestration

9 modules; 294 active configurations. Sources: [case list](../../../docs/formal/workflow/orchestration/cases.tsv), [case settings](../../../docs/formal/workflow/orchestration/cases.json), [templates](../../../docs/formal/workflow/orchestration/tlc-templates.json).

```sh
cd docs/formal/workflow/orchestration
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WfAgent`](../../../docs/formal/workflow/orchestration/WfAgent.tla) | 34 | Spawn/record races, typed completion, deadlines, child end and terminal turn failure | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L1249) |
| [`WfExecLease`](../../../docs/formal/workflow/orchestration/WfExecLease.tla) | 6 | Historical exclusive tool-session lease and teardown | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L4238) |
| [`WfExecShare`](../../../docs/formal/workflow/orchestration/WfExecShare.tla) | 32 | Current owner-counted tool-session share, generations and cleanup barriers | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L4438) |
| [`WfExecutor`](../../../docs/formal/workflow/orchestration/WfExecutor.tla) | 6 | Historical tool-executor shared-session lifetime | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L5428) |
| [`WfGraph`](../../../docs/formal/workflow/orchestration/WfGraph.tla) | 71 | Cursors, node limits, routing, branch terminals, controls and external ends | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L3) |
| [`WfPaging`](../../../docs/formal/workflow/orchestration/WfPaging.tla) | 4 | Cleanup covers all owed child invocations across pages | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L5012) |
| [`WfParent`](../../../docs/formal/workflow/orchestration/WfParent.tla) | 88 | Parent queue acceptance, end notices, ordering, duplicate windows and authority races | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L1729) |
| [`WfPaused`](../../../docs/formal/workflow/orchestration/WfPaused.tla) | 42 | Paused routing versus running deadlines and child cleanup | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L5144) |
| [`WfRecover`](../../../docs/formal/workflow/orchestration/WfRecover.tla) | 11 | Recovery after run end, missing child ends and missing parent notices | Folder runner; [cases](../../../docs/formal/workflow/orchestration/cases.json#L4643) |

## workflow/paired

8 modules; 42 active configurations. Sources: [case list](../../../docs/formal/workflow/paired/cases.tsv), [case settings](../../../docs/formal/workflow/paired/cases.json), [templates](../../../docs/formal/workflow/paired/tlc-templates.json).

```sh
cd docs/formal/workflow/paired
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`MCWorkflowRequestCode8021Clock`](../../../docs/formal/workflow/paired/MCWorkflowRequestCode8021Clock.tla) | 1 | Old request code with clock rollback; negative comparison | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L229) |
| [`MCWorkflowRequestSpec57Late`](../../../docs/formal/workflow/paired/MCWorkflowRequestSpec57Late.tla) | 1 | Witness wrapper for late clock readings and decisions | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L1280) |
| [`MCWorkflowRequestSpecView`](../../../docs/formal/workflow/paired/MCWorkflowRequestSpecView.tla) | 1 | Safety projection wrapper; not a proof that projection is exact | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L714) |
| [`WorkflowRequestCode`](../../../docs/formal/workflow/paired/WorkflowRequestCode.tla) | 4 | Request store code at 8021c75e and its intent refinement | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L29) |
| [`WorkflowRequestCode57`](../../../docs/formal/workflow/paired/WorkflowRequestCode57.tla) | 2 | Request store with durable expiry at 57fbb0d6 | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L167) |
| [`WorkflowRequestCodeAuth`](../../../docs/formal/workflow/paired/WorkflowRequestCodeAuth.tla) | 2 | Request-code refinement under explicit authority assumptions | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L3) |
| [`WorkflowRequestSpec`](../../../docs/formal/workflow/paired/WorkflowRequestSpec.tla) | 25 | Request intent: response, deadline, authority, operation identity and wake | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L254) |
| [`WorkflowRequestSpec57`](../../../docs/formal/workflow/paired/WorkflowRequestSpec57.tla) | 6 | Request intent with durable observed expiry and clock rollback | Folder runner; [cases](../../../docs/formal/workflow/paired/cases.json#L1097) |

## workflow/paired/recipient

19 modules; 113 active configurations. Sources: [case list](../../../docs/formal/workflow/paired/recipient/cases.tsv), [case settings](../../../docs/formal/workflow/paired/recipient/cases.json), [templates](../../../docs/formal/workflow/paired/recipient/tlc-templates.json).

```sh
cd docs/formal/workflow/paired/recipient
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`MCExposureCode1e24Composed`](../../../docs/formal/workflow/paired/recipient/MCExposureCode1e24Composed.tla) | 2 | Composition of repaired exposure with surrounding protocol | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1759) |
| [`MCExposureCode1e24Runs`](../../../docs/formal/workflow/paired/recipient/MCExposureCode1e24Runs.tla) | 8 | Repaired-worker model-run exposure wrapper | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L2505) |
| [`MCExposureCodeC1EndCancel`](../../../docs/formal/workflow/paired/recipient/MCExposureCodeC1EndCancel.tla) | 6 | Old-worker end/cancel-order wrapper | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1869) |
| [`MCExposureCodeC1Runs`](../../../docs/formal/workflow/paired/recipient/MCExposureCodeC1Runs.tla) | 10 | Old-worker model-run exposure wrapper | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L2215) |
| [`MCExposureCodeRefines1e24`](../../../docs/formal/workflow/paired/recipient/MCExposureCodeRefines1e24.tla) | 4 | Code-to-intent exposure refinement obligation; no valid recorded result | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L2055) |
| [`MCRecipientTurnGWitness`](../../../docs/formal/workflow/paired/recipient/MCRecipientTurnGWitness.tla) | 1 | History-only wrapper for parked-gate witnesses | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1204) |
| [`MCRecipientTurnWitness`](../../../docs/formal/workflow/paired/recipient/MCRecipientTurnWitness.tla) | 3 | History-only wrapper for turn-binding witnesses | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1388) |
| [`RecipientCancelOrder22A`](../../../docs/formal/workflow/paired/recipient/RecipientCancelOrder22A.tla) | 5 | Corrected cancel-order code under identity/environment assumptions | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L3) |
| [`RecipientCancelOrderB92`](../../../docs/formal/workflow/paired/recipient/RecipientCancelOrderB92.tla) | 3 | Earlier cancel-order code; negative comparison | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L135) |
| [`RecipientCancelOrderSpec`](../../../docs/formal/workflow/paired/recipient/RecipientCancelOrderSpec.tla) | 4 | Cancellation must latch before a tombstone is evicted or consumed | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L213) |
| [`RecipientExposureCode`](../../../docs/formal/workflow/paired/recipient/RecipientExposureCode.tla) | 10 | Worker exposure code with selectable old/fixed behavior | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1483) |
| [`RecipientExposureSpec`](../../../docs/formal/workflow/paired/recipient/RecipientExposureSpec.tla) | 15 | Pre-send exposure intent, cancel/end order and accepted-result origin | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L2773) |
| [`RecipientIntakeCode`](../../../docs/formal/workflow/paired/recipient/RecipientIntakeCode.tla) | 10 | Intake machine code and serialized-caller refinement | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L324) |
| [`RecipientIntakeSpec`](../../../docs/formal/workflow/paired/recipient/RecipientIntakeSpec.tla) | 13 | Intent for cancellation latch, placement, bind/end and store-only wake | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L578) |
| [`RecipientTurnCode`](../../../docs/formal/workflow/paired/recipient/RecipientTurnCode.tla) | 6 | Turn-binding code at 5df032f1 and its refinement mapping | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L900) |
| [`RecipientTurnCodeG`](../../../docs/formal/workflow/paired/recipient/RecipientTurnCodeG.tla) | 2 | Code model with gate revalidation | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1066) |
| [`RecipientTurnSpec`](../../../docs/formal/workflow/paired/recipient/RecipientTurnSpec.tla) | 7 | Initial intent for invocation ownership across turns and retries | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1227) |
| [`RecipientTurnSpecG`](../../../docs/formal/workflow/paired/recipient/RecipientTurnSpecG.tla) | 3 | Turn-binding intent with explicit parked-gate behavior | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1120) |
| [`RecipientTurnSpecR2`](../../../docs/formal/workflow/paired/recipient/RecipientTurnSpecR2.tla) | 1 | Revised turn-binding intent with stronger witness obligations | Folder runner; [cases](../../../docs/formal/workflow/paired/recipient/cases.json#L1454) |

## workflow/paired/request

4 modules; 36 active configurations. Sources: [case list](../../../docs/formal/workflow/paired/request/cases.tsv), [case settings](../../../docs/formal/workflow/paired/request/cases.json), [templates](../../../docs/formal/workflow/paired/request/tlc-templates.json).

```sh
cd docs/formal/workflow/paired/request
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`MCRequestBStrict`](../../../docs/formal/workflow/paired/request/MCRequestBStrict.tla) | 2 | Strict witnesses for decided-operation conflict and timeout while paused | Folder runner; [cases](../../../docs/formal/workflow/paired/request/cases.json#L1008) |
| [`MCRequestCandidate`](../../../docs/formal/workflow/paired/request/MCRequestCandidate.tla) | 16 | Variant-A request intent with observed-expiry witness | Folder runner; [cases](../../../docs/formal/workflow/paired/request/cases.json#L3) |
| [`WorkflowRequestSpec57`](../../../docs/formal/workflow/paired/request/WorkflowRequestSpec57.tla) | 0 | Request intent with durable observed expiry and clock rollback | Imported by entry modules; [cases](../../../docs/formal/workflow/paired/request/cases.json) |
| [`WorkflowRequestSpecB`](../../../docs/formal/workflow/paired/request/WorkflowRequestSpecB.tla) | 18 | Chosen variant-B intent: observed expiry bars new decisions; elapse stays timed_out | Folder runner; [cases](../../../docs/formal/workflow/paired/request/cases.json#L501) |

## workflow/parallel

1 modules; 94 active configurations. Sources: [case list](../../../docs/formal/workflow/parallel/cases.tsv), [case settings](../../../docs/formal/workflow/parallel/cases.json), [templates](../../../docs/formal/workflow/parallel/tlc-templates.json).

```sh
cd docs/formal/workflow/parallel
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WorkflowParallel`](../../../docs/formal/workflow/parallel/WorkflowParallel.tla) | 94 | First-k/all join, accepted commit order, time limit, branch cut and owed ends | Folder runner; [cases](../../../docs/formal/workflow/parallel/cases.json#L3) |

## workflow/reminder

1 modules; 18 active configurations. Sources: [case list](../../../docs/formal/workflow/reminder/cases.tsv), [case settings](../../../docs/formal/workflow/reminder/cases.json), [templates](../../../docs/formal/workflow/reminder/tlc-templates.json).

```sh
cd docs/formal/workflow/reminder
TLA_TOOLS=<tools> ./check-packet.sh
TLA_TOOLS=<tools> ./run-tlc.sh <out>
```

| Module | Active configurations | What they check | How to run / exact cases |
|---|---|---|---|
| [`WorkflowReminder`](../../../docs/formal/workflow/reminder/WorkflowReminder.tla) | 18 | In-turn reminder gate, cap, pending work and stop/send races | Folder runner; [cases](../../../docs/formal/workflow/reminder/cases.json#L3) |

## Retired configurations and historical labels

Retired cases are not in the active runner list. Their old assumptions remain in the source records for comparison; they do not describe additional behavior to deploy.

| Folder | Retired configurations | Source |
|---|---|---|
| `workflow` | 4 | [retired cases](../../../docs/formal/workflow/cases-retired.json) |
| `workflow/idle-wake` | 4 | [retired cases](../../../docs/formal/workflow/idle-wake/cases-retired.json) |
| `workflow/orchestration` | 2 | [retired cases](../../../docs/formal/workflow/orchestration/cases-retired.json) |
| `workflow/parallel` | 2 | [retired cases](../../../docs/formal/workflow/parallel/cases-retired.json) |

The retired `adm-df-trigger-0090.cfg` case uses **0090 and 0091 as historical pre-collapse trigger-version labels**. They are not current migration instructions and do not identify a planned migration 0090. At this source pin, migration **0088** creates the final Workflow schema and deletion trigger; **0089** renames the owner-session objects and owner-end trigger. See [migrations and triggers](data-model.md#every-added-or-renamed-trigger) and the [retired case record](../../../docs/formal/workflow/cases-retired.json).

Totals: **73 modules**, **1,109 active configurations**, and **12 retired configurations**. Counts are an inventory, not a test verdict.
