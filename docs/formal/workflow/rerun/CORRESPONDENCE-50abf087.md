# WorkflowRerun packet correspondence to 50abf087 (I7 re-run from a chosen visit, batch rr9)

Packet at `50abf0876c7c070156d9055d16aeb8e68f396565` (batch `rr9`, 231 cases; review findings H1 to H3 closed). The
production code is the code that passed review at `d44e9ab47`: `git diff d44e9ab47 50abf087 -- packages/` is empty, so
every line number below holds at both. Paths are under `packages/sdk/src/` unless they start with `packages/`;
`store.ts`, `rerun.ts`, `runtime.ts`, `service.ts`, `session-definitions.ts`, `compiler.ts` and `controller/index.ts`
are in `workflow/`. Line numbers are at `50abf087`.

Labels: **Code** (the model does what the code does), **Rule** (a property the code is checked against), **Simpl.**
(the model abstracts or leaves out code), **Fault** (a deliberate mutant of the code named in the row).

The five modules: `WorkflowRerun.tla` (WR: Start, copy, pass-over and live run of one re-run, supply, G-R1, carried
inbox, deleters, Sweeper, quiescence), `RerunStartRaces.tla` (RS: RR-4, RR-10), `RerunPlanGate.tla` (RP: RR-6, RR-7 /
MA-1, RR-8), `RerunPassOver.tla` (RPO: RR-3, RR-5, RR-9, RR-11) and `RerunContinuedSession.tla` (RCS: CS-6).

## 1. Lock order

Every writer of a Workflow's runs or nodes holds the Workflow's session row first (`store.ts` 4655-4661, the stated
global order: session row, definition row, run rows in id order, node rows).

| Model step | Code at 50abf087 | Label |
|---|---|---|
| WR `ClaimRerun`; RS `Claim` (owner row first, on every claim path) | `service.ts` 1054-1083 `createWorkflow` → `cms.ts` 1894 → 1871-1873 `lockLiveParent` (owner `FOR NO KEY UPDATE` when an `afterClaim` step may lock it, else `FOR SHARE`), then `cms_create_workflow_session` 1896 (same-key claims serialize on the session row's insert) | Code; RS takes the owner row exclusively in both cases (Simpl.: a shared claim lock waits for fewer actors) |
| WR `CopyLockStep1` (`ownerLock`, `defLock` = `copy_share`); RS `Lock1`, `Lock2` | `store.ts` 2828 → `workflow/session-definition-store.ts` 964-977 `requireSessionStartLocked`: owner `FOR SHARE` (967; ended → `SESSION_NOT_LIVE` 970), definition `FOR SHARE` (973; deleted → `DEFINITION_DELETED` 977) | Code |
| WR `CopyLockSrc`, `CopyLockStep2` (`srcLock` = `copy_share`, `newLock` = `copy_excl`); RS `Lock3`, `Lock4` (`PairFirst`, `PairSecond`) | `store.ts` 2867 → `lockSessionPair` 2092-2107: #2 `FOR SHARE`, #3 `FOR NO KEY UPDATE`, in `sessionPairLockOrder` (9807: ascending `session_id`; a parent before its child) | Code |
| WR `SweeperLockTarget`; RS `SourceDelete` | `store.ts` 4506-4507 `sweeperSoftDelete`: target `FOR NO KEY UPDATE`; descendants `ORDER BY session_id FOR NO KEY UPDATE NOWAIT` 4559-4563 (`Busy`) | Code |
| WR `DelWfLock` | `cms.ts` 2356 `softDeleteSession` → `cms_soft_delete_session` (blocking `UPDATE` of #2's row) | Code; the separate autocommit `updateSession(state: "failed")` before it is not modeled (Simpl.) |
| WR `OwnerEndLockOwner` → `OwnerEndLockDef` → `OwnerEndCommit`; RS `OwnerDeleteLockOwner`, `OwnerDeleteLockDef`, `OwnerDeleteLockChild`, `OwnerDeleteCommit` | `packages/sdk/src/migrations/workflow-outcome-retention-0096.ts` 150-165 `workflow_on_owner_session_ended`: the owner row (the triggering `UPDATE`), definitions 156-158, child Workflow rows `ORDER BY session_id FOR NO KEY UPDATE` 159-162, soft delete 163-165 | Code |
| RS `OwnerCompleteLockOwner`, `OwnerCompleteLockChild`, `OwnerCompleteCommit` | 0096 166-192 (the owner completed, cancelled or failed): child Workflow rows `ORDER BY session_id FOR NO KEY UPDATE` (167-170), their active runs `FOR UPDATE OF run` (171-176), pending nodes cancelled (177-186), runs cancelled (187-192); nothing deleted | Code |
| RS `DefDeleteLock1`, `DefDeleteLock2`, `DefDeleteCommit` | `workflow/session-definition-store.ts` 795-804 `deleteDefinition`: owner `FOR NO KEY UPDATE` (800), then the definition `FOR UPDATE` (804) | Code |
| WR fault `LockNewBeforeOwner` (`rr-df-lock-new-before-owner`, deadlock); RS faults `PairBeforeOwner` (`rs-df-second-pair-before-owner`, `-owner-complete`) and `DefDeleteDefFirst` (`rs-df-def-delete-def-first`), each a TLC deadlock | the pair locked before `requireSessionStartLocked` (`store.ts` 2867 before 2828); the definition delete locking the definition before the owner (804 before 800) | Fault |

`CHECK_DEADLOCK TRUE` on every case: a lock wait is a disabled action, so a cycle is a TLC deadlock. No `rr9` design
case deadlocks.

## 2. Start: plan, claim and admission (WR, RS)

| Model action or definition | Code at 50abf087 | Label |
|---|---|---|
| RP `Plan`; RS `GateRefuse` (plan refusal: no claim, no shell) | `session-definitions.ts` 1117 `startSessionWorkflowDefinition` → 1175 `prepareRerunStart` (847-1072): source checks 864-876 (`RERUN_SOURCE_GONE`, `RERUN_NOT_A_WORKFLOW`, `RERUN_SOURCE_ACTIVE` 876), `listRerunKeys` 907, `pickRerunTarget` 908, `partitionRerunVisits` 914, supply 916, compatibility 928-939, approval gate 944-969, `mapRerunExecutions` 972, `rerunCutKvRevision` 973, `buildRerunResume` 1022, pin 1054-1072 | Code |
| WR `ClaimRerun` (writes `rerunPin`, creates the claim shell); RS `Claim` | `session-definitions.ts` 1190-1199 (pin + `createWorkflow`); `service.ts` 1054-1065 (`creation_config.workflow` with `operationId`, `requestSha256`, `rerunPin`); 1083-1127 a found row: deleted → `WORKFLOW_DELETED` (1091), another request → `WORKFLOW_EXISTS` (1116, 1122), own admitted → replay | Code |
| WR `SaveNewRevision`, `ClaimCrash`, `ResumeAfterClaimCrash`; RS `Crash`, `PlanRefuse` | `session-definitions.ts` 1170-1171 `storedStartPin` (592-605) → `replaySessionStart` (609-845): a resumed claim keeps its pinned revision and visit (679-724, `prepareRerunStart` again at 717 with the pinned execution and mode); another `rerun_from` is refused (639-642, `sameRerunPinRequest`) | Code |
| WR `MutateRetrySupply` (`retrySupplyVer`) | `service.ts` 885-902: the request digest includes the supplied outcome and the SHA-256 of the output and note, so a changed payload is another request (`WORKFLOW_EXISTS`, 1116) | Code |
| RS `ReceiptCheck` | `store.ts` 2860-2863 (`priorReceipt`, 2469) before any lock | Code |
| WR `CopyCommit`; RS `Commit` | `store.ts` 2785-2954 `createDefinition`, one transaction (2822): pair locks 2867, shell deleted → `WORKFLOW_DELETED` 2868-2872, #2 gone → `RERUN_SOURCE_GONE` 2874-2891, #2 active → `RERUN_SOURCE_ACTIVE` 2892-2898, `verifyRerunLimitsAndApprovalsIn` 2899 (3196-3268), definition insert `ON CONFLICT` 2902-2916, `insertRun` 2938 (2596-2685: run row with `rerun_*` columns 2619-2627, KV snapshot `revision <= R` 2634-2652, revision rows `<= R` 2665-2678, `copyRerunNodesIn` 2680, `copyRerunInboxIn` 2681, `recordRerunEventsIn` 2682), receipt 2951-2952 | Code |
| WR `CopyFinishPartial` (fault `AtomicCopy = FALSE`, `rr-df-copy-not-atomic`) | the copy split from the run row: everything above is one `this.transaction` (2822) | Fault |
| WR `RefuseClaim` (a refusal rolls back and owes cleanup) | `store.ts` throws inside the transaction (rollback); `service.ts` 1149-1162 calls the cleanup | Code |
| `copyRerunNodesIn` (fresh ids, kept ordinals, origin flattening, no deadline) | `store.ts` 3269-3329: new ids from `mapRerunExecutions` (`rerun.ts` 744), `s.ordinal` kept (3289), `deadline_at` NULL (3291), `COALESCE(s.reused_from_*, s.*)` (3293-3295), the supplied row 3306-3328 | Code |

## 3. Supply mode

| Model | Code at 50abf087 | Label |
|---|---|---|
| `Mode = "supply"`, `ChosenSupplyNode`, `ExpectedSupplied`, the supplied row in `CopyCommit` (`suppliedSet`, winner `supplied`) | `rerun.ts` 826 `mapRerunSuppliedExecution`; `store.ts` 3306-3328 (supplied visit with `supplied_*` provenance); `session-definitions.ts` 979-1021 | Code |
| `SupplyNever` / `IgnoreSupplyNever` (`rr-df-ignores-supply-never`) | `compiler.ts` 726-730 and 1464-1468 (`supply: never` on a script and an agent step), carried into the IR at 2936-2942 and 3081-3102; `rerun.ts` 944-950 refuses it on S or T (`RERUN_SUPPLY_NOT_ALLOWED`, `supply_never`) | Code / Fault |
| allowed step types (`AllowSupplyOnForbiddenStep`, `rr-df-supply-on-approval`) | `rerun.ts` 923-927 (source visit a script or agent step), 953-957 (the target step too) | Code / Fault |
| declared outcome and note (`AllowUndeclaredSupplyOutcome`, `IgnoreMissingSupplyNote`: `rr-df-supply-undeclared-outcome`, `rr-df-supply-no-note`) | `rerun.ts` 898-1082 `validateRerunSupply`: a non-blank note of at most `WORKFLOW_RERUN_SUPPLY_NOTE_MAX_CHARS` (35) characters, else `RERUN_ARGUMENT_REFUSED` (1014-1018); an outcome the target step declares, else `RERUN_SUPPLIED_RESULT_INVALID` (1021-1026) | Code / Fault |
| `StartsSupplied` (`rr-df-starts-supplied`): a supplied visit started as work | the supplied row is inserted `completed` (`store.ts` 3306-3328); the controller passes a completed row over (`store.ts` 4886-4907) and starts work only for a pending one (`controller/index.ts` 700-790) | Fault |
| `RepickSuppliedOnRetry` (`rr-df-retry-changes-supplied`) | see `MutateRetrySupply` above: the pinned digest wins | Fault |
| `downstreamReadSupplied` (`Wit_NoSupplyDownstreamRead`) | the next step's input is the supplied output (the copied row's `output`) | Code |

## 4. G-R1 cut-back (WR, RP)

| Model | Code at 50abf087 | Label |
|---|---|---|
| WR `Gr1Applies`, `Gr1BadTopIndices`, `Gr1EarliestIdx`, `EnclosingTopOf`; RP `Gr1Applies`, `CandMode`, `CandReused`, `CodeBad`, `BadTops`, `Gr1Target` | `rerun.ts` 454 `pickRerunTarget`: the automatic pick's scan 608-638 (no requested mode or `run_again`, 611) over the candidate's reused visits (`partitionRerunVisits`, 613), bad = `spawnChildCancelledBySourceEnd` or no `spawnChildHasNotice` (619), a lane spawn lifted to its parallel (620-626), the earliest index (627-631), the cut moved there with `run_again` (634-637) | Code |
| RP the two flags (`op`, `notice`) as the plan reads them (`snapOp`, `snapNotice`) | `store.ts` 2962 `listRerunKeys`: `spawn_child_cancelled_by_source_end` (3013-3020: a `parent-end:` operation on the child, run id flattened by `COALESCE(b.reused_from_run_id, b.run_id)`), `spawn_child_has_notice` (3021-3026: a `WorkflowEnded@1` row from the child in the immediate source's inbox); mapped 3060-3061 | Code |
| RP `ChildEnds` | a running child ends after #2 ended (its `parent-end:` cancel lands, `runtime.ts` 1331-1342, or it finishes) | Code |
| RP `LateNoticeRefused` (review H3) | the notice of a child that ended after #2: `runtime.ts` 3087-3094 skips an inactive spawning run (`parent is gone`); a delivery already in flight reaches `store.ts` `acceptInput`, which locks #2's run (5713) and refuses an ended one (5715-5717, `RUN_ENDED`) before any insert, and the runtime records the skip (3150-3153). No fresh row is inserted into an ended source run. `prepareRerunStart` refuses an active source (`session-definitions.ts` 876), so the plan always reads an ended one | Code |
| WR `SkipGr1CutBack` (`rr-df-gr1-skip`, `rr-df-gr1-lane-skip`); RP `Gr1PicksLatest`, `Gr1TopOnly`, `Gr1CutsBefore`, `Gr1NeverMoves`, `Gr1UsesChildStatus` | `rerun.ts` 608-637 removed, or changed to the latest index, top-level visits only, one visit early, never applied, or the child's own status instead of the two flags | Fault |
| G-R2 (WR `OldChildWindDown`, fault `SkipParentEndCancel`) | `runtime.ts` 1288-1345 `endWorkflowRunChildWorkflows`: each active child of an ended run gets a `parent-end:<runId>` cancel (1331-1342) | Code / Fault |
| `ReqModeContinue` (G-R1 off), warnings for reused cancelled or noticeless spawns | `rerun.ts` 611 (a requested `continue` skips the scan); `buildRerunWarnings` 1458 (`reused_child_cancelled`, `reused_child_gone`: 1603-1626) | Code |

## 5. Partition, KV cut and approval gate (RP)

| Model | Code at 50abf087 | Label |
|---|---|---|
| `CodeReusedTop`, `CodeDroppedTop`, `CodeReusedLanes`, `CodeDroppedLanes` | `rerun.ts` 676 `partitionRerunVisits`: `reusedSplit` 695, `droppedSplit` 696, lanes follow their parallel (646 `orderLaneVisitsTopologically`, 697-731) | Code |
| `CodeKv`, `CodeKvSnap`, `CodeKvRows` | `rerun.ts` 732 `rerunCutKvRevision`; `store.ts` 2634-2652 (snapshot: newest revision `<= R`), 2665-2678 (revision rows `<= R`) | Code |
| `PlanGateRefuses`, `DirectOwner`, `PlanApprovals`, `AllApprovals` | `session-definitions.ts` 944-969: `directOwner` (946: a user, no `originatingSessionId`, not `viaMcp`), the owner, a provenance row for every reused approval (959), each decided by them; refusal `RERUN_APPROVAL_REUSED` (950-966); `approvalOwnerCheck` pinned (1054) | Code |
| `RecheckRefuses`; `Admit` refusal (`refused_admit`, cleanup owed) | `store.ts` 3247-3265 `verifyRerunLimitsAndApprovalsIn`: each reused approval's provenance, read now, against `approvalOwnerCheck` | Code |
| `ProvenanceChanges` | an approval's recorded provenance read again at the admission | Code |
| Faults `SplitOffByOne`, `LanesByIndex`, `DroppedOffByOne`, `DroppedLanesByIndex`, `KvUsesChosenPin`, `KvSnapshotBelowCut`, `KvRowsBelowCut`, `GateIgnoresMcp`, `GateIgnoresProxy`, `GateIgnoresDecider`, `GateIgnoresOwner`, `GateTopLevelOnly`, `GateSkipPlan`, `GateSkipRecheck`, `GateRecheckAsPlan` | `rerun.ts` 695-696 off by one; lanes by index; `rerun.ts` 732 returning the chosen visit's pin; `store.ts` 2637 / 2669 with `< R`; `session-definitions.ts` 946 without one of its terms, 950-969 without the decider or owner check, top-level approvals only, or the gate skipped; `store.ts` 3247-3265 skipped, or its refusal treated as a plan refusal | Fault |

## 6. Carried inbox: R5 unread-only carry, `origin_accepted_at` (RR-1) and the run-end clock (MSG-1)

| Model | Code at 50abf087 | Label |
|---|---|---|
| `EligibleCarry`, `EligibleCarrySet` (the design rule: unread, `accept <= cut < expire`, or a reused child's notice) | design §5.4 (owner ruling, 27 Nov 22:35 PST) | Rule |
| `TargetInbox`, `CodeUnread`, `CodeTimeArm`, `CodeWaitingAtCut` | `store.ts` 3359-3381 `copyRerunInboxIn`: `consumed_by IS NULL` (3373), `(contract <> WorkflowEnded@1 AND COALESCE(origin_accepted_at, accepted_at) <= cut AND expires_at > cut) OR (contract = WorkflowEnded@1 AND sender = ANY(reusedSpawnChildIds))` (3374-3377); `summarizeRerunCarriedInbox` 3069-3115 uses the same predicate (3081-3085) | Code |
| `CodeCutAt` | `store.ts` 3334-3348 `resolveRerunInboxCut`: the chosen (or first dropped) visit's `entered_at` (3338), else #2's `finished_at` (3340), as exact microsecond text | Code |
| `StoredAcceptedAt`, `StoredOriginAt`, `StoredExpiresAt` (`CopyTime`, RR-1) | `store.ts` 3362-3370: a carried row's `accepted_at = now()`, `expires_at = now() + GREATEST(expires_at - accepted_at, 1 s)`, `origin_accepted_at = COALESCE(origin_accepted_at, accepted_at)`; the column is `packages/sdk/src/migrations/workflow-rerun-0104.ts` 152-153 | Code |
| `CarriedShapes` (generation 2: no carried row was read by a copied visit) | the copy carries unread rows only (3373) | Code |
| Faults `CarryLateMessage`, `CarryReadMessage`, `CarryDropsEqualCut`, `CarryKeepsExpiredAtCut`, `CarryNoticeByTime`, `CarryComparesCopyTime` | 3374-3377 without the time test; `consumed_by IS NULL` widened to a visit that is not kept (the pre-ruling rule); `< cut`; `expires_at >= cut`; the time arm's `contract <> WorkflowEnded@1` dropped; `accepted_at` instead of `COALESCE(origin_accepted_at, accepted_at)` | Fault |
| MSG-1: `SrcClockTick`, `EndBegin`, `AccLock`, `AccCommit`, `EndCommit`, `MsgPresent` | `store.ts` 8678-8720 `endRunIn`: `finished_at` and the pending nodes' `completed_at` are `lockedClockText` (8691; 4673-4676: `clock_timestamp()` read after the caller's locks); `acceptInput` reads its clock after its locks (5718) | Code |
| `EndClock = "begin"` (`rr-df-run-end-clock-at-begin`) | `finished_at = now()` (the transaction's start: the code before MSG-1) | Fault |
| `ExpireCarriedInbox` | carried rows expire by their restarted `expires_at` (3369) | Code |

## 7. Controller pass-over and live run (WR, RPO)

| Model action or definition | Code at 50abf087 | Label |
|---|---|---|
| WR `BeginExec`; RPO `Begin` | `runtime.ts` 2172 `begin` → `store.ts` 4701-4796 `beginRun` (admitted → running; the run's own deadline from begin, 4708); `runtime.ts` 2214-2240 `plan`: `maxNodeExecutions - rerunUnwalked` (2236) | Code |
| WR `PlanBudget = FALSE` (`rr-df-plan-ignores-unwalked`) | 2236 without `- rerunUnwalked` | Fault |
| WR `PollCommand` | `controller/index.ts` 635-650 (`steps >= plan.maxNodeExecutions`), commands applied first (988-990) | Code |
| WR `ControllerCan` | the controller's continue-as-new (`controller/index.ts` 332-334, 606) | Code; its histories are outside the packet (Simpl.) |
| WR `AdmitExec` / `AdmitRecord`; RPO `AdmitExec`, `AdmitRecord` | `runtime.ts` 2246 `enterNodeActivity` (2633 `enter`) → `store.ts` 4797-5290 `enterNode`, in order: an existing row answered as it is (4886-4907; a copied row with other coordinates before `rerun_resumed_at` → `failRerunDivergedIn` 4896-4903, after it `NONDETERMINISTIC_ADMISSION` 4905); a run past its deadline answers `expired` (4910-4911); a stop answers `stopping` (4915); a paused or ended run admits nothing (4916); the cut guard (4932-4947, `checkRerunCutGuardMismatch` 8609-8652); a receive's take (5139-5160); the insert (5190-5207); `rerun_resumed_at` stamped in the same transaction (5210-5215); the message consumed (5271-5275) | Code |
| WR `AdmitCoord`, `ByteCheckRequired`, `ByteCheckOk`, `CutCoordMatches`, `CutGuardMatches` | `rerun.ts` 1697-1771 `buildRerunResume` (state, ordinal, mapped predecessor, route, `expectedInputSha256` / `expectedCarrySha256` only for the same IR, 1704-1713); `store.ts` 8609-8652 | Code |
| WR faults `Guard = FALSE` / `FitCheck = FALSE` (`rr-df-no-fit-no-guard`), `CheckInputHash = FALSE` (`rr-df-ignores-input-hash`), `continue` without the guard (`rr-df-continue-no-guard`), `CheckCopyCoord = FALSE` (`rr-df-copy-hit-ignores-pred`), `DivergeInserts` (`rr-df-diverge-inserts`) | `store.ts` 4932-4947 and `rerun.ts` 1083 `checkRerunCompatibility` skipped; the hash terms of 8609-8652 skipped; 4896-4903 skipped; the guard after the insert (5190) | Fault |
| WR `OrdinalsRestart` (`rr-df-ordinals-restart`), `DropsCatchAll` (`rr-df-drops-catch-all`) | ordinals: copied rows keep theirs (`store.ts` 3289) and the controller counts them as it walks (`controller/index.ts` 283 `ordinals`); catch-all: `catchAllEntered` set when the cursor reaches the catch-all, copied or not (682-701, 940-951) | Code / Fault |
| WR `isExhausted` (`MaxVisits`) | `runtime.ts` 2316-2320 (`ordinal > maxVisits` → `STATE_EXHAUSTED`, winner controller) | Code |
| WR `AdmitRetry` (and `RetryAfterCut`); RPO `AdmitRetry` | Duroxide re-runs an activity whose result was not recorded; `enterNode` answers an existing row as it is (4886-4907) | Code |
| WR `TakeIgnoresTaken` (`rr-df-retry-retakes-carried`); RPO `TakeNotIdempotent` (`rpo-df-take-not-idempotent`) | 4886-4907 taking again instead of answering the row | Fault |
| RPO `StampSeparateTx` (`rpo-df-stamp-separate-tx`), `StampTx` | 5210-5215 moved to a transaction of its own | Fault |
| WR `StartEffect`; RPO `StartWork`, `WorkEndedEarly` | `controller/index.ts` 700-790: work starts only for a pending row; a pending receive arms its deadline and starts nothing (717-718); `send` and `request` start their own orchestration (725-735) | Code |
| WR `StartsDecided` (`rr-df-starts-decided`) | work started for a copied completed row | Fault |
| WR `CollectExec`, `CollectRecord`, `WaitStep`; RPO `Collect`, `WaitSeesEnd` | `runtime.ts` 2662 `collect`; `controller/index.ts` 918 `selectRoute`, 940-951 catch-all; 988-990 the wait (command queue raced against the nearest deadline's timer) | Code |
| WR `FinishExec`, `FinishFailExec`; RPO `Collect` (completed, `unhandled`) | `runtime.ts` 2765 `finish` → `store.ts` 8553 `finishRun` → `endRunIn` 8678-8720 (pending nodes ended with the run, 8710-8715) | Code |
| WR `CancelTx`, `SendCancel`; RPO `Cancel` | `store.ts` 3846 `recordRunCancelRequest`; `runtime.ts` 2936 `cancel` → `endRunIn` (winner `cancel`) | Code |
| WR `PauseRun`, `ResumeRun`; RPO `Pause`, `Resume`, `WaitResume` | `store.ts` 3713 `setRunPaused`; `enterNode` admits nothing while paused (4916) | Code |
| WR `RequestStop`; RPO `Stop`, `StopAtPoll`, `StopGraceEnds` | `store.ts` 3772 `requestRunStop`, `enterNode` 4915 (`stopping`), 8765 `finishStoppedRun`; `runtime.ts` 4503 `stop` | Code |
| RPO `StopKeepsPending` (`rpo-df-stop-keeps-pending`) | the stop's end without 8710-8715 | Fault |
| WR `EffFinish` (non-receive work) | `runtime.ts` 3669 `recordEffectResult` (pending-only) | Code |
| RPO `DispatchLost`, `Recover`, `DispatchRead`, `DispatchStart` | `service.ts` 1165 → 597 `dispatchWorkflowRun` (a read of the run, then a separate orchestration start; an ended run is not started); a receipt replay of the same Start dispatches the stored run again (`service.ts` 984-995) | Code |
| RPO `ExpireTx`, `RunDeadlineFires` | `runtime.ts` 4444-4500 `expire` → `store.ts` 8855-8900 `expireRun` (an active run, running or paused, past `deadline_at` ends failed / expired; an inactive one is reported, 8865) | Code |
| RPO `VisitTimerFires` (parallel) | a parallel step's time limit on the controller's timers (`controller/index.ts` 741-760); a lane admitted after it is `cut` (`store.ts` 4925: `deadline_at <= now`); `runtime.ts` 4189 `cancelBranches` | Code |
| RPO `CopyKeepsRunDeadline` (`rpo-df-copy-keeps-run-deadline`), `DeadlineEarlyFor` (`rpo-df-wait-deadline-early`, `-parallel-deadline-early`, `-run-deadline-early`) | #2's run deadline copied into #3 (the code sets it at begin, 4708); `deadline_at < now + 1` instead of `<= now` (5589, 4925, 8868) | Fault |
| RPO `EndAgents`, `CancelChildren`, `EndActsDone`, `ChildEndsAlone`; faults `SkipAgentEndWhen`, `SkipChildCancelWhen`, `NoCleanupOnOwnerEnd` | `runtime.ts` 4042 `endAgent`, 4099 `endAgents`; 1288-1345 (`parent-end:<runId>` per active child, 1331-1342) for every end kind | Code / Fault |
| RPO `OwnerDeleted` | 0096 155-165 soft-deletes the owner's child Workflow sessions in the owner's deletion transaction; `workflow_on_session_deleted` (0096 119-145) then cancels each one's active run and its pending nodes (winner `delete`, 128-137) | Code |

## 8. The receive wait (review H1, H2)

| Model | Code at 50abf087 | Label |
|---|---|---|
| WR `R2Waits`; the admission of `R2` pending when nothing carried is takeable | `store.ts` 5139-5160 (the take: `consumed_by IS NULL ... AND expires_at > decided`, 5146-5149), 5190-5207 (inserted pending with `deadline_at`); `controller/index.ts` 717-718 (no effect, its deadline armed) | Code |
| WR `AcceptNewMessage`; RPO `Accept` (`ClaimFence`) | `store.ts` 5651-5790 `acceptInput`, one transaction: session locks (`lockInputSessions`), the run locked (5713) and an ended run refused (`RUN_ENDED`, 5715-5717; a paused run accepts, 5632), one clock reading after the locks (5718), the insert (5740-5746), the earliest pending receive whose `deadline_at > at` (5747-5756) claimed in the same transaction (winner `message`, 5757-5766) and the message consumed (5768-5769) | Code |
| WR `newMsg = "waiting"`; RPO `tieAccept` | a message accepted at or after the deadline is stored unclaimed (5747-5756 select no receive); a wait that elapses does not discard it | Code |
| WR `RxTick`; RPO `Tick` | the store's clock (`clock_timestamp()`) | Simpl.: WR's `rxClk` is a bounded clock that runs only while `R2` is pending (`WaitDeadline = 1`) |
| WR `ElapseWait`; RPO `VisitTimerFires` (receive) | `controller/index.ts` 289-298 `elapseDue` (577) for due receives and waits → `runtime.ts` 3210-3262 → `store.ts` 5578-5596 `elapseWait`: `deadline_at <= now` (one reading after the session lock, 5584-5589), `outcome = elapsed`, `result_kind = business`, stored winner `controller` (WR names it `timer`) | Code |
| RPO `VisitDone` | agent, spawn and parallel completions only; no later take by a pending receive (review H2) | Code |
| RPO `LateTake` (`TakeIgnoresEnd`, `rpo-df-take-ignores-end`) | a take after the run's end: `acceptInput` without 5715-5717 and the claim without `state = 'pending'` (5764) | Fault |
| WR `ReceiveSkipsWait` (`rr-df-receive-skips-wait`, `rr-df-receive-skips-wait-elapsed`) | `rr8`'s shortcut: a pending receive completed as an effect (`msg`, or `elapsed` at once) with neither an accepted message nor a due deadline | Fault |
| WR `WaitRearms` (`rr-df-wait-rearms`) | a due timer that re-arms from now instead of calling `elapseWait` | Fault |
| RPO `ClaimAtDeadline` (`rpo-df-claim-at-deadline`) | 5752 with `deadline_at >= $5` | Fault |
| WR `Fairness` (`WF` of `RxTick`, `ElapseWait`, `CtrlProgress`; none on `AcceptNewMessage`) | Duroxide timers fire (`controller/index.ts` 988-990); nobody need send a message | Simpl. (fairness assumption) |

## 9. RR-4 refusal cleanup and the Sweeper's bare-shell collection

| Model | Code at 50abf087 | Label |
|---|---|---|
| WR `RefusalCleanup`, `RefusalCleanupLost`, `RefusalSettled`; RS `Cleanup`, `Crash` | `service.ts` 1149-1162: after any `WorkflowStoreError` of a re-run Start (made or resumed claim, 1154-1156) → `store.ts` 4604-4620 `softDeleteRefusedClaimShell`, a transaction of its own: the shell `FOR NO KEY UPDATE` (4607-4609), only a live Workflow session (4611) whose claim records this `operationId` and `requestSha256` (4612), with no definition and no run (4614-4616); its failure is swallowed (1159-1161) | Code |
| WR `SkipImmediateRefusalCleanup` (`rr-df-refused-shell-not-deleted`); RS `CleanupCodeFilter` (`rs-df-cleanup-code-filter`), `CleanupUnconditional` (`rs-df-cleanup-unconditional`), `CleanupIgnoresIdentity` (`rs-df-cleanup-ignores-identity`), `ClaimIgnoresIdentity` (`rs-df-claim-ignores-identity`) | no cleanup; the code before RR-4 (only a created claim, only `RUN_ENDED` / `RERUN_*`; `catalog.softDeleteSession` with no re-check); 4612 removed; `service.ts` 1116 removed | Fault |
| WR `AdvanceClaimGrace`; RS `GracePasses` | `sweeper-tools.ts` 242 (`updatedAt` older than the grace) | Code |
| WR `SweeperReadBareShell`; RS `SweeperRead` | `sweeper-tools.ts` 78, 116 (`NotFound` orchestration → `bareClaimShell`), 138 `readRowVersion` (an unlocked read of `xmin`) | Code |
| WR `SweeperCollectClaimShell`; RS `SweeperCollect` | `sweeper-tools.ts` 152-158 → `store.ts` 4499-4592 `sweeperSoftDelete`: the shell `FOR NO KEY UPDATE` (4506-4507), the same version (4511), no definition and no run re-checked under the lock (4527-4535) | Code |
| WR `SweeperSkipsNewLockOrRecheck` (`rr-df-sweeper-deletes-active-claim`); RS `SweeperNoRecheck` (`rs-df-sweeper-no-recheck`) | 4507 or 4527-4535 removed | Fault |
| `Inv_AdmittedNotSwept`; `Prop_SweepRequiresLockAndNoRun` (each Sweeper collection holds the shell's lock and sees no run) | the admission holds #3 `FOR NO KEY UPDATE` (`store.ts` 2107) until its commit, which bumps the version the Sweeper compares (4511) and adds the definition and run it re-checks (4527-4535) | Rule |
| WR `AllowPostSweepStart`, `freshStartAfterSweep` | a retry of a swept key finds a deleted row (`service.ts` 1091, `WORKFLOW_DELETED`) | Code |

## 10. End, cleanup and quiescence

| Model | Code at 50abf087 | Label |
|---|---|---|
| WR `Quiescent`, `Done`; `Inv_QuiescentNoLive`; `Live_Quiesces`, `Wit_NoLeakQuiescence` | no lock held, the Sweeper and deleters idle, the Start settled (refused and cleaned up, or admitted with the controller done), no effect running, carried messages expired, #3's child settled and #2's old child cancelled (`runtime.ts` 1288-1345), no agent session live (`runtime.ts` 4042, 4099) | Rule |
| RPO `Inv_EndedNoLiveAgent`, `Inv_EndedNoActiveChild`, `Inv_TerminalNoPending`, `Live_EndedQuiesces` | the same end activities for every end kind; `endRunIn` ends pending nodes (`store.ts` 8710-8715); 0096 ends them with the run (177-188) | Rule |
| WR `NewChildSettle` | #3's spawned child (`runtime.ts` 3569 `spawnChild`) ends; cancelled with #3's end (1331-1342) | Code |

## 11. CS-6: the continued-session recap (RCS)

| Model | Code at 50abf087 | Label |
|---|---|---|
| `Admit`, `Spawn`, `TurnRuns`, `TurnDropped`, `Report`, `TimesOut`, `Lose`, `SessionEnds` | `runtime.ts` 3850-3910 `spawnAgent` → 1767-1858 `agentSessionCycle`: the pre-cut summary in the first live cycle (1786-1806) and in a new session's restart prompt (1832-1838); a later cycle points to the first cycle of its session whose turn ran (1817-1829, `store.ts` 7769 `readAgentSessionVisitsBefore`, counting only cycles whose agent reported), or carries the summary itself when none ran or that cycle lost its conversation (1825-1829, 1832-1838; `store.ts` 7956 `readAgentCyclesLostBefore`) | Code |
| `Inv_NoFalseRecapClaim`, `Inv_RecapAvailable`, `Inv_SessionIsolation` | a cycle claims the summary only when an earlier cycle of the same session ran and kept it; the recap is always reachable; a re-run never continues #2's session | Rule |
| Faults `RanMeansSpawned`, `IgnoreLostRecap`, `RestartWithoutRecap`, `ContinueSourceSession` | 7769 counting spawned cycles; 1828 without the lost check; 1832-1838 without the restart summary; the source session reused | Fault |
| One bit for a lost conversation and its recording | the loss event is a best-effort write; a loss whose recording fails (audit CS-5) | Simpl. |

## 12. Properties

| Property | Rule (code that enforces it) |
|---|---|
| WR `TypeOK`, `CoreSafety` (`Inv_EventsOnce`, `Inv_AdmissionOrder`, `Inv_CatchAllAfterUnhandled`, `Inv_CancelWinner`, `Inv_CompletedHasTerminal`, `Inv_NeverRouteCancelled`) | the 1.3.0 controller loop's own invariants (§7) |
| WR `Inv_ReusedNeverRuns`, `Inv_SuppliedNeverRuns` | a copied or supplied visit is completed and passed over (§2, §3) |
| WR `Inv_SuppliedSingleton`, `Inv_SupplyAllowedStepOnly`, `Inv_SuppliedOutcomeDeclared` | §3 |
| WR `Inv_AutoPickNoCancelledReuse`; RP `Inv_ReusedSpawnFinished`, `Inv_Gr1CutAtMinBad` | §4 |
| WR `Inv_RefusalCleanupLeavesNoBareShell`, `Inv_AdmittedNotSwept`, `Prop_SweepRequiresLockAndNoRun`; RS `Inv_AdmittedNeverDeleted`, `Inv_RefusalLeavesNoBareShell`, `Inv_ShellAdmittedByItsRequest`, `Inv_CleanupDeletesOwnClaimOnly`, `Live_NoBareShellLeft` | §9 |
| WR `Inv_QuiescentNoLive`, `Live_Quiesces` | §10 |
| WR `Inv_ReusedImmutable`, `Inv_SourceUntouched` | the copy reads #2 and writes only #3's rows (`store.ts` 3269-3329, 3359-3381) |
| WR `Inv_CopyAtomic`, `Inv_NoCopyFromDeleted`, `Inv_OriginRan` | §2 (one transaction; #2 `FOR SHARE`; `COALESCE` origin) |
| WR `Inv_PinnedChoice`, `Inv_NoConsentReuse` | §2 (`rerunPin`), §5 (approval gate and re-check) |
| WR `Inv_FirstNewAtCut`, `Inv_PassOverOnChain`, `Inv_NoWorkOnDiverge`, `Inv_ValidNeverDiverges`, `Live_ReachesCut`, `Live_ReachesCutOnly`, `Live_DivergesCleanly`, `Live_Terminates` | §7 (cut guard, copied-row coordinates, `failRerunDivergedIn` 8653 with no insert) |
| WR `Inv_OrdinalsContinue`, `Inv_CatchAllOnce`, `Inv_VisitLimit`, `Inv_StepLimit`, `Inv_TotalFromFirstNew` | §7 (ordinals, catch-all, `maxVisits`, plan budget); the receive total anchor (`store.ts` 5100-5134, 5296 `readReceiveTotalDeadline`; copied rows have no deadline, 3291) |
| WR `Inv_CarriedWereWaiting`, `Inv_InboxCarryExact`, `Inv_NoWaitingLostAcrossGenerations`, `Inv_AcceptedBeforeEnd`, `Inv_TakeOnce` | §6, §7 |
| WR `Inv_ReceiveWaitsForInputOrDeadline`, `Live_NoInputTimesOut`; RPO `Inv_NoClaimAtOrAfterWaitDeadline` | §8 |
| WR `Inv_TerminalNoPending`, `Prop_NoAdmissionAfterTerminal` | `endRunIn` 8710-8715; `enterNode` 4916 |
| RP `Inv_ReusedIsPrefix`, `Inv_ExactPartition`, `Inv_KvAtCut`, `Inv_KvAdmitted`, `Inv_ReuseNeedsOwnerInPerson`, `Inv_PlanRefusesWhatItSees`, `Inv_RefusalShellAccounted` | §5 |
| RPO `Inv_TakeOnce`, `Inv_NoExpiredTake`, `Inv_ResumedIffNew`, `Inv_ExpiresNotEarly`, `Inv_TimersNotEarly`, `Inv_EndedNoTake` | §7, §8 (`expires_at > now` 5148; stamp in the insert's transaction 5210-5215; deadlines from begin 4708, `<= now` 5589, 4925, 8868; take before end: 5714-5717) |
| RPO `Inv_TerminalNoPending`, `Inv_EndedNoLiveAgent`, `Inv_EndedNoActiveChild`, `Live_EndedQuiesces` | §10 |
| RCS `Inv_NoFalseRecapClaim`, `Inv_RecapAvailable`, `Inv_SessionIsolation` | §11 |

## 13. Witnesses (each expected violated: the boundary is reached)

| Witnesses | Code path reached |
|---|---|
| WR `Wit_NeverResumes`, `Wit_NoDiverge`, `Wit_NoExhausted`, `Wit_NoRetryInPassOver`, `Wit_NoContinueAsNewInPassOver`, `Wit_NoReusedCatchAll`, `Wit_NoFailAfterReusedCatchAll`, `Wit_NoSecondGeneration` | §7 (cut stamp, divergence, `maxVisits`, retry, continue-as-new, a copied catch-all, two-generation origin) |
| WR `Wit_NoSourceGone`, `Wit_NoDeleteAfterCopy`, `Wit_NoApprovalRefusal`, `Wit_NoPinnedResume`, `Wit_NoLateRetryAfterSweep`, `Wit_NoLostRefusalCleanupSwept`, `Wit_NoLeakQuiescence` | §2, §5, §9, §10 |
| WR `Wit_NoSupplyDownstreamRead`, `Wit_NoSupplyFirstVisit`, `Wit_NoSupplyToTerminal`, `Wit_NoSupplyRefusedStepType` | §3 |
| WR `Wit_NoCarriedTake`, `Wit_NoCarryAtCut`, `Wit_NoExpiredAtCutLeft`, `Wit_NoStrayNoticeLeft`, `Wit_NoCarryAcrossGenerations`, `Wit_NoRacedAcceptCarried`, `Wit_NoReadNoticeLeft` | §6 (exact cut, expiry, stray notice, RR-1, MSG-1, a read notice) |
| WR `Wit_NoNewMessageAfterRead` (H1: `R2` pending, the controller reads it pending, a message accepted before its deadline claims it, completed); `Wit_NoReceiveTimedOut` (H1: no input, the clock reaches the deadline, `elapsed`, failed `unhandled_error`) | §8 |
| RS `Wit_NoRefusedAfterOtherAdmitted`, `Wit_NoOtherCodeCleaned`, `Wit_NoResumedClaimCleaned`, `Wit_NoLostCleanupSwept`, `Wit_NoRecheckRefusalCleaned`, `Wit_NoReceiptReplay`, `Wit_NoOtherRequestRefused`, `Wit_NoTwoRerunsShareSource`, `Wit_NoAdmitSourceFirst`, `Wit_NoAdmitShellFirst`, `Wit_NoDeletersCommitted`, `Wit_NoOwnerCompleteAfterAdmission`, `Wit_NoSweepAndOwnerDelete` | §1, §2, §9 |
| RP `Wit_NoContinueAtParallel`, `Wit_NoSupplyKv`, `Wit_NoRunAgainKvBefore`, `Wit_NoKvCutBetweenRevisions`, `Wit_NoDroppedLanes`, `Wit_NoLaneApprovalReused`, `Wit_NoMcpRefusal`, `Wit_NoMissingProvenanceRefused`, `Wit_NoRecheckRefusal` | §5 |
| RP `Wit_NoGoodReusedBadCut`, `Wit_NoTwoBadSpawns`, `Wit_NoLaneLift`, `Wit_NoStaleFlag`, `Wit_NoNoticeAfterCompletion`, `Wit_NoKeptReceiveCutBack`, `Wit_NoRefusedLateNotice` (H3: a late notice delivery to the ended #2 is refused and the admission keeps the cut-back) | §4 |
| RPO `Wit_NoExpiredBeforeReceive`, `Wit_NoTakeAtLastInstant`, `Wit_NoRetryAfterCut`, `Wit_NoExpireInPassOver`, `Wit_NoWaitTimerAtDeadline`, `Wit_NoParallelTimerAtDeadline`, `Wit_NoPausedExpiry`, `Wit_NoEndBetweenExpiredAndExpire`, `Wit_NoRecoveredDispatch`, `Wit_NoEndBeforeDispatch`, `Wit_NoCleanupAfterStop`, `Wit_NoCleanupAfterOwnerEnd` | §7, §10 |
| RPO `Wit_NoTakeOfLateMessage` (H2: a receive pending before the acceptance, claimed before its deadline, completed); `Wit_NoAcceptAtWaitDeadline` (H2: accepted at `at = deadline_at`, unclaimed, the wait elapses) | §8 |
| RCS `Wit_NoTimedOutThenCarried`, `Wit_NoPointerHonoured`, `Wit_NoReCarryAtTurn`, `Wit_NoReplacementPointer` | §11 |

Every deliberate fault is named with its code mutant in §1 to §11 (WR 40, RS 9, RP 21, RPO 13, RCS 4 fault cases). The
`FAULT_EXEMPT` properties and their reasons are in `README.md` ("Coverage").

## 14. Modeled assumptions and boundaries

- **Bounded checks, not proofs.** Each case fixes small constants (`StepLimit`, `MaxVisits`, two generations, a two- or
  three-message inbox, `MaxClk`, at most one crash or retry where stated). A TLC pass covers that bound only.
- **Restated controller.** WR restates the 1.3.0 controller loop of `../WorkflowRun.tla` (it does not `INSTANCE` it);
  the restatement is §7's rows, not the frozen controller files.
- **The new receive (H1).** WR models one new receive, `R2`, with a one-tick wait and a bounded clock that runs only
  while it is pending; a new message is sent only while `R2` is pending (one sent before its entry would be taken by
  `enterNode`, as a carried one is). RPO models the general timing: two receives, every expiry, run, wait and parallel
  limit, and acceptances at every instant.
- **Notice delivery (H3).** RP models a late notice delivery to the ended source as refused; a notice accepted while #2
  was active is part of #2's history TLC chooses (`notice = "row"`). An in-flight delivery whose acceptance committed
  before #2's end is that case.
- **Labels the code does not store.** WR's `timer` winner is the code's `controller` winner of `elapseWait`; WR's
  carried take at entry (winner `controller`) is the code's winner `message` (`store.ts` 5163).
- **Outside the packet.** Duroxide replay of recorded histories, the controller's continue-as-new histories, the
  autocommit `updateSession(state: "failed")` before `cms_soft_delete_session`, the outer Start's stored-pin replay path
  before the CMS claim (deferred review note), migration 0104's constraints and indexes (`workflow-rerun-0104.ts`
  44-89, 92-151, 160-180: shape only), and a loss of an agent conversation whose recording fails (CS-5).
- **Fairness.** Liveness cases assume weak fairness of the Start's progress, the deleters' commits, the controller,
  lifecycle actions, effects, the clock and the wait timer; no fairness for commands, crashes or new messages.

## Verdict

Bound at `50abf087` (`rr9`: 231 of 231 cases as expected; TLC 2.19, JDK 21, `CHECK_DEADLOCK TRUE` on all, 1,794 s). A change to the code rows above needs a re-read and a
re-run; a test or document change needs only a re-pin with `packages/sdk/src` unchanged. This file, its `README.md`
link and its `SHA256SUMS` line are added by a later docs-only commit; the binding holds there while
`git diff 50abf087 <that commit> -- packages/ '*.tla'` is empty.
