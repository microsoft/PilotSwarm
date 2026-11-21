# so3 correspondence to e76a6133

Code: `packages/sdk/src/` at `e76a6133`. Rows are the rows of the orchestration and hydration change inventory of this line
that earlier batches did not cover. 1.0.83 is inactive: only a worker with the test option `workflowRequests` /
`workflowIntakeTurns` serves it (orchestration-version.ts 24-33). H05 runs on every worker.

| Row | Code at e76a6133 | Model | Cases |
|---|---|---|---|
| H05 | worker.ts 1307-1404 `gracefulShutdown`: each step races one deadline (drain budget + `PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS`); workspace release 1374; release sweep 1394 `sweepIdleSessions(1)` (deletes committed sessions' local copies, dehydrates unmarked legacy ones); stop 1403 | `WorkerShutdown`: `Abandon`, `SweepCommitted`, `SweepLegacyStart/Finish`, `Exit` | `ws.*`, `comparison.ws-no-deadline`, `fault.ws-*`, `wit.ws-*` |
| I05 | orchestration_1_0_83 queue.ts 482-496, 505-520, 797-812 (a due intake write is a drain deadline; one intake call per wake); runtime.ts 303 (no continue-as-new while a write is due) | `IntakeDrain`: `BecomeDue`, `WakeWrite`, `ContinueAsNew` guard | `id.safety`, `id.live`, `fault.id-can-while-due`, `fault.id-two-calls`, `wit.id-write` |
| I08 | lifecycle.ts 749-750 (carry `intakeArrivalPending`); intake-wiring.ts 326 (set), 584 (cleared), 682 (own-turn stimulus); state.ts 804 (restore) | `IntakeDrain`: `Arrive`, `ArrivalTurn`, carry in `ContinueAsNew` | `id.safety`, `id.live`, `fault.id-drop-arrival-flag` |
| N01 | runtime.ts 253-278: only the stats read is inside `try`; a refused continue-as-new at the history cap fails the execution (1.0.82 swallowed it and went on) | `IntakeDrain`: `ContinueAsNew` with `Mode` | `id.e76a6133-refused`, `comparison.id-1-0-82-swallow` |
| N02 | lifecycle.ts 724-776 `versionedContinueAsNew` calls `assertIntakeContinueAsNewTarget` (intake-state.ts 534-545); latest is 1.0.82 (orchestration-version.ts 15) | `IntakeDrain`: `Latest83` | `id.e76a6133-refused` (design limit), `id.e76a6133-refused-rest`, `fault.id-downgrade`, `wit.id-can` |
| N04 | state.ts 255-410 `ownedRetry`; queue.ts 1495-1517 (`decide` dispatches it first); turn.ts 549-553 (only it reuses the thrown key); state.ts 759-761 (`thrownTurnKey` null at start) | `OwnedRetry`: `DispatchRetry`, `DispatchOther`, `key` | `or.*`, `comparison.or-1-0-82`, `fault.or-other-first`, `wit.or-retry-dispatched` |
| N05 | lifecycle.ts 733-740 (every continue-as-new carries `ownedRetry`); turn.ts 159, 194, 364 (connection-closed, lossy hand-off, generic retry continue as new with it owned) | `OwnedRetry`: `ContinueAsNew` | `or.*`, `fault.or-drop-at-can` |
| N06 | turn.ts 194 (a lossy hand-off's retry is fresh: count 0, no key) | `OwnedRetry`: `TurnFails` with `fresh` | `or.*`, `fault.or-fresh-with-key` |
| N07 | queue.ts 620-629, 749-760 `releaseTimerForOwnedRetry` (an armed wait is released; an agent wait is kept, its poll queued after the retry) | `OwnedRetry`: `DrainForRetry`, `FinishTurn` | `or.safety-agent`, `or.live-*`, `fault.or-agent-released`, `wit.or-poll-after` |
| N10 | activity-routing.ts 10-22, 93-128 (`runTurnV5` / `runTurnEpochV5`, tag `pilotswarm.workflow-request.v1`); session-proxy.ts 5778 (registered only with `workflowIntakeTurns`); milestone-worker.ts 45-46 | `IntakeDrain`: `ArrivalTurn` `worker` | `id.safety`, `fault.id-route-any` |
| late-cancel fix | Not written yet. Proposed: a marker on the FIFO item and a give-back at the dispatch drops (1.0.83 queue.ts 1459, 1561) | `RehydrationNotice`: `LateGiveBack` | `rn.late-cancel` (old code), `impl.rn-late-give-back-83`, `-live` (bind to the fix head) |

Abstractions: one session loop; `Cap` counts loop iterations, not bytes; `Latest83 = FALSE` stands for "the
continue-as-new is refused" (at e76a6133 every 1.0.83 continue-as-new is). `LocalSurvivesExit` is a constant
because whether the worker-local session folder survives a pod exit depends on the deployment.
