# Session-orchestration models ↔ code at `e76a6133` (orchestration 1.0.82 live, 1.0.83 intake version)

Lineage: `packages/sdk/src/orchestration/` (the registered latest, 1.0.82) is byte-identical at `198ad79a` (the
earlier binding), main `7f81d217` and `e76a6133`; `orchestration_1_0_82/` at `e76a6133` is its frozen copy (one line of
`runtime.ts` differs). 1.0.83 (`orchestration_1_0_83/`, `DURABLE_SESSION_INTAKE_VERSION`) is not in the registry's
default list; only a worker with the `workflowRequests` test option registers it and starts sessions at it.
So the eight existing modules stay bound to 1.0.82 with their `198ad79a` line numbers, valid at `e76a6133`.
The table gives each module's code in 1.0.83 and the 1.0.83 code near it that the module does not model.

| Module | 1.0.82 (`orchestration/` at 198ad79a = e76a6133) | 1.0.83 (`orchestration_1_0_83/` at e76a6133) | New in 1.0.83 near it, not in the module |
|---|---|---|---|
| TurnLoop | `queue.ts` `appendToFifo` 169; `popNextDispatchFifoItem` 234; `drain` 653-1156; `sweepMessagesBeforePromptDispatch` 1157-1297; `decide` 1387-1552; `turn.ts` `processPrompt` 357-769 | `queue.ts` 171-212; 236-252; 697-1238; 1239-1389; 1481-1679; `turn.ts` 369-797 | the owed retry dispatched first in `decide` 1495-1517; intake's own turn 1660-1666; the drain branch for an owed retry 749-760; intake arrivals in drain and sweep |
| TurnCommit | `turn.ts` `handleGenericRetry` 304-356; turn key and snapshot 504-570 | `turn.ts` 314-365; ~536-612 (`reusedTurnKey` 549-553 via `intakeReusesThrownTurnKey`) | `ownedRetryMayAdopt` 428-437; `thrownTurnKey` null at start (`state.ts` 759-761); the retry owned apart from the pending prompt |
| TimerGeneration | `queue.ts` `nextTimerCandidate` 433-474, `releaseTimerForQueuedWork` 529-580; `turn.ts` `processTimer` 1648; `lifecycle.ts` 713, 1146-1167 | `queue.ts` 435-476, 555-606; `turn.ts` 1686-1937; `lifecycle.ts` 754, 1186-1207 | `releaseTimerForOwnedRetry` 620-629 |
| TimerHandoff | `queue.ts` 529-580; `settleQueuedWorkAfterDecide` 618-652 (restore 641) | `queue.ts` 555-606; 662-697 (restore 686) | an agent wait kept for an owed retry; `intakeWantsTurn` in `shouldRunQueuedWorkNow` 535 |
| TimerInterrupt | `queue.ts` 975-1060; `lifecycle.ts` 1146-1167 | `queue.ts` 1057-1145; `lifecycle.ts` 1186-1207 | none |
| TimerStarvation | `queue.ts` `shouldRunQueuedWorkNow` 503-528; `decide` 1387-1552 | `queue.ts` 527-553; 1481-1679 | `intakeWantsTurn` 535; the owed retry and intake turns in `decide` |
| ChildDelivery | `lifecycle.ts` 442-470; `agents.ts` 349-352; `queue.ts` `processPendingChildDigest` 1553, `hasReadyPendingChildDigest` 475 | `lifecycle.ts` 445-473; `agents.ts` 349-352; `queue.ts` 1680-1804, 477-480 | intake's own turn takes the digest (`intake-wiring.ts` 761-780) |
| DeliveryIdentity | `state.ts` 440, 485; `queue.ts` 398-432, 933-945 | `state.ts` 623, 668; `queue.ts` 400-434, ~1015-1030 | none |
| RehydrationNotice (new) | `queue.ts` `compactTimerItem` 97-112 (T1), `giveBackCarriedWork` 377-396 (T2), restore 1085-1089, carry 1126-1135; `lifecycle.ts` `wrapWithResumeContext`; `turn.ts` hydration give-up 490 (returns) | `queue.ts` 99-114, 379-398, call sites 907, 920, 1227, restore 1166-1171, carry 1208-1216, wraps 1080, 1111, 1130; dispatch cancels without give-back 1457-1459, 1559-1562; `lifecycle.ts` 159-170, carry across continue-as-new 591, 599; `turn.ts` lossy hand-off 194-196, timer wraps 1740, 1800, hydration give-up 512 (T3, records an intake attempt) | — |
| SnapshotWarmDrop (new) | — (no drop before RT-F1) | `session-proxy.ts` 5244-5261 (RT-F1, T4), `runTurnCommit` 5604-5611; `managed-session.ts` 990-993, 1697-1741 (`takeUnsettledRun`); `session-manager.ts` 3633-3649 (`invalidateWarmSession`, handle forgotten in `finally`) | — |

Changes of this PR line that touch durable state and no model covers (from the inventory): the owed retry's
dispatch priority and its continue-as-new carry (`decide` 2a, `state.ts` 255-410), the owed retry's timer release
(`releaseTimerForOwnedRetry`), a refused continue-as-new at the history cap now failing the execution
(`runtime.ts` 253-278), the 1.0.83 continue-as-new floor, the intake's due write as a drain deadline and the no
continue-as-new while due rule, the arrival flag carried across continue-as-new, the worker shutdown deadline, and the
saved turn result's visit fence and intake witness. They are listed for a decision; this packet does not model them.
