# Correspondence: `WfBranchContinuedSession.tla` <-> PilotSwarm at `0f80ee3c3`

This document maps every state variable, action, invariant, liveness property, and deliberate fault in
`docs/formal/workflow/continued-session/WfBranchContinuedSession.tla` to the PilotSwarm implementation at
commit `0f80ee3c3` (branch `waldemort/wf-phase2-continue-branches`, base `1a866cb1e`).

## 1. Compiler & Guard Preconditions

| Model Assumption | Code Location (`0f80ee3c3`) | Exact Correspondence |
|---|---|---|
| Each named branch `b \in Branches` owns a distinct continued agent state (`stateId` is unique across the Workflow). | `packages/sdk/src/workflow/compiler.ts` (`compileState` `bodyOf.has(bodyId)` + `checkGraph` `if (body.branch !== null) continue;`) | Named `branches:` allow explicit `session: continue`; omitted `session:` in any parallel body stays `new`; `forEach` (`body.branch === null`) still refuses `session: continue` with `WORKFLOW_FIELD_INVALID`. |
| Non-named branch scopes (`forEach`) never enter continued-session execution even on tampered IR. | `packages/sdk/src/workflow/runtime.ts` (`enterNodeActivity`: `if (node.session === "continue" && scopeId !== ROOT_SCOPE && !branch?.name)`) | Throws `WorkflowStoreError("WORKFLOW_STORE_CORRUPT", ...)` before `continuedSessionOf` runs. |
| Single continued-session ID formula per `(runId, stateId[, visit])`. | `packages/sdk/src/workflow/agent-ids.ts` (`workflowAgentSessionId`, unchanged) + `packages/sdk/src/workflow/runtime.ts` (`continuedSessionOf`) | `1` in the model corresponds to `workflowAgentSessionId(runId, stateId)`; replacement `Cardinality(priorAll) + 1` corresponds to `workflowAgentSessionId(runId, stateId, visits + 1)`. |

## 2. State-Machine Actions <-> Code Boundaries

| TLA+ Action | Atomic Code Operation | Exact File & Function |
|---|---|---|
| `EnterParallel` | Controller enters `parallel` state in `ROOT_SCOPE`, incrementing `p.ordinal` and resetting per-scope `n.ordinal` to `1` for `${parallelNx}#${index}`. | `packages/sdk/src/workflow/controller/index.ts` (unchanged; `WORKFLOW_CONTROLLER_VERSION = "1.3.0"`) + `packages/sdk/src/workflow/parallel.ts` (`branchScopeId`) |
| `AdmitVisit(b)` | `enterNodeActivity` calls `continuedSessionOf(client, current.runId, nodeId)` -> `store.readAgentVisitsBefore(runId, stateId, null)`, then inserts `workflow_node_executions` + `workflow_agent_invocations`. | `packages/sdk/src/workflow/runtime.ts` (`continuedSessionOf`, `enterNodeActivity`), `packages/sdk/src/workflow/store.ts` (`readAgentVisitsBefore`, `enterNode`) |
| `StoreLt` / `StoreMax` (`OrderByNodeOrdinalOnly = FALSE`) | `LEFT JOIN workflow_node_executions p` parsed from `n.scope_id` (`strpos/split_part`) + composite rank `(COALESCE(p.ordinal, 0), n.ordinal, i.created_at, i.node_execution_id)`. | `packages/sdk/src/workflow/store.ts` (`parallelJoinSql`, `readWorkflowLineage`, `readAgentInvocationByChild`, `readTurnVisit`, `readAgentVisitsBefore`, `listAgentInvocationsOfState`) |
| `SpawnVisit(b, k)` | `spawnAgent` drains owed earlier visits (`endEarlierVisitsOf`, G2), re-checks session liveness (G1), creates/opens session, and enqueues cycle prompt. | `packages/sdk/src/workflow/runtime.ts` (`endEarlierVisitsOf`, `continuedSessionGone`, `WORKFLOW_ACTIVITIES.spawnAgent`) |
| `StartTurn(b, s)` | Turn admission reads `readTurnVisit` and skips already-decided visits (`decidedAtAdmission`). | `packages/sdk/src/workflow/store.ts` (`readTurnVisit`), `packages/sdk/src/session-proxy.ts` |
| `TurnReport(b, s)` | `completeAgentNode` CAS: succeeds only if `nodes.state = 'pending'` (`winner = 'agent'`), closing tools and leaving the turn in `"reporting"` to finish its reply (`I1`). | `packages/sdk/src/workflow/store.ts` (`completeAgentNode`), `packages/sdk/src/workflow/agent-node-service.ts` (`WORKFLOW_AGENT_REPLY_SETTLE`) |
| `TurnFinish(b, s)` | Post-report reply finishes naturally and commits turn snapshot (`modelMemoryCommitted = true`). | `packages/sdk/src/session-proxy.ts` (`I1`, unchanged) |
| `EndVisit(b, k)` | `endContinuedVisit`: sends NO Stop when `end === "done"` and run is active (`I1`); sends fenced `workflow-cycle-stop:<nx>` when `end === "cancel"` or run stopping/ended; transient `stopTurn` failure leaves `end_sent_at = NULL` (owed). | `packages/sdk/src/workflow/runtime.ts` (`endContinuedVisit`) |
| `BranchCut(b)` | `cancelBranches` -> `store.cancelBranchScopes`: cancels pending visits in cut scopes (`winner = 'fail_fast'\|'join'\|'join_timeout'`, `outcome = 'cancelled'`), never touching already-completed (`winner = 'agent'`) visits. | `packages/sdk/src/workflow/runtime.ts` (`cancelBranches`), `packages/sdk/src/workflow/store.ts` (`cancelBranchScopes`) |
| `PersonEndSession(b, s)` | External person ends/deletes the continued session (`session.end_requested` / soft delete); next admission allocates deterministic replacement `workflowAgentSessionId(runId, stateId, visits + 1)`. | `packages/sdk/src/workflow/runtime.ts` (`agentSessionEndedOnItsOwn`, `continuedSessionOf`) |
| `RequestGracefulStop` / `FinishRun` | `run.stop != null` admits no new visits while letting pending visits finish; terminal `completed`/`cancelled`/`stopped` triggers `endWorkflowContinuedSessions`. | `packages/sdk/src/workflow/runtime.ts` (`endWorkflowContinuedSessions`, `endContinuedSessionLocked`) |
| `EndBranchSession(b, s)` | `endWorkflowContinuedSessions` iterates sessions independently (`PerAgentSessionEnd`): `endContinuedSessionLocked` reads `readAgentInvocationByChild(childSessionId)` (composite rank!), returns `null` if newest visit is `pending` (Q5), else sends unfenced `workflow-session-stop:<childSessionId>` + `cmd: 'done'\|'cancel'`. | `packages/sdk/src/workflow/runtime.ts` (`endWorkflowContinuedSessions`, `endContinuedSessionLocked`), `packages/sdk/src/workflow/store.ts` (`readAgentInvocationByChild`) |

## 3. Portal UI Correspondence (`packages/app/ui/core`)

| Store Composite Rank | Portal UI Equivalent (`0f80ee3c3`) |
|---|---|
| `(COALESCE(p.ordinal, 0), n.ordinal)` | `workflowVisitRank(execution, executions)` & `compareWorkflowVisitRank` in `packages/app/ui/core/src/workflow-view.js` (`projectWorkflow` stamps `parallelOrdinal`, `nodeView` sorts by composite rank), wired across `workflow-agent-log.js` (`workflowAgentLogVisits`, `own`, `byOrdinal`, plus ` · cycle ${cycle}` header suffix on re-entered forks) and `workflow-node-summary.js` (`lastEnded`, `chatOf`). |

## 4. State Variables <-> Runtime & Store Data

| Model Variable(s) | Code Backing |
|---|---|
| `runState`, `fork`, `nextFork` | `workflow_runs.status`, `workflow_runs.stop`, enclosing `parallel` node `workflow_node_executions.ordinal` (`p.ordinal`). |
| `branchPhase`, `branchOrd` | Controller per-scope state (`controller/index.ts:652-653`, resetting `ordinal` to `1` per `${parallelNx}#${index}`). |
| `admitted`, `vState`, `vWinner`, `vSess`, `vCycle`, `vSpawned`, `vEndSent`, `vStopOwed`, `vCycleStopSent` | `workflow_node_executions` (`state`, `winner`, `ordinal`, `scope_id`) + `workflow_agent_invocations` (`child_session_id`, `spawned_at`, `end_sent_at`, `end_child_status`). |
| `sessState`, `sessEndedBy`, `sessEndCount`, `sessTurn`, `sessTurnVisit`, `sessQueue`, `sessCommitted` | Session catalog row (`sessions`), `session.end_requested` mark, Duroxide orchestration queue/status, and `I1` committed turn snapshots. |
| `wCutAfterDone`, `wStoppingMixed`, `wOwedCutAtRunEnd`, `wCrossForkReplace` | Pure observer latches for non-vacuity witness canaries (read only by `W_*` invariants, never affect transitions). |

## 5. Abstractions, Explicit Assumptions, and Limits

- **Cross-branch session/Stop isolation (explicit assumption, verified in code):** Model state arrays are indexed per branch `b \in Branches`. In code, non-collision across branches is guaranteed by: (1) compiler `WORKFLOW_STATE_ID` uniqueness across the entire Workflow (`compiler.ts:2164, :2227`), (2) `workflowAgentSessionId(runId, stateId[, visit])` hashing `stateId`, and (3) keyed Stop IDs (`workflow-cycle-stop:<nodeExecutionId>` and `workflow-session-stop:<childSessionId>`).
- **Modeled abstractions vs runtime:**
  - (a) Cycle/session Stops take effect atomically in `EndVisit`/`EndBranchSession`; asynchronous Stop delivery and reply-limit timeouts are already exhaustively modeled in `WfContinuedSession.tla` (`I1` R2–R5, 134 cases).
  - (b) Stale sends of an already-decided visit (`afterSpawn` `:sent` Stop) are modeled in `WfContinuedSession.tla` and omitted from `WfBranchContinuedSession.tla` (`SpawnVisit` requires `vState = "pending"`).
  - (c) A `TurnReport` that loses the `completeAgentNode` CAS transitions `sessTurn` to `"idle"` directly (in code the turn finishes or is stopped by the cut's cycle Stop; the visit itself is never mutated).
  - (d) `EndBranchSession` clears `vStopOwed` for visits of `s`; in code, `endWorkflowRunAgents` settles owed visit rows while `endContinuedSessionLocked` sends `workflow-session-stop:<childSessionId>` before `cmd: done|cancel`.
  - (e) `BranchCut` fires from `in_agent` or `after_agent` (cutting from `idle` admits no visit and creates no session).
  - (f) `PersonEndSession` fires while the session is idle; person-end-during-turn (`G1` residual / `EndMark`) is covered in `WfContinuedSession.tla`.
  - (g) `readTurnVisit`, `readWorkflowLineage`, and `listAgentInvocationsOfState` share the identical `parallelJoinSql` + `(COALESCE(p.ordinal, 0), n.ordinal, i.created_at, i.node_execution_id)` composite key as `readAgentVisitsBefore` and `readAgentInvocationByChild`, and are verified directly by PostgreSQL and HorizonDB store tests (`workflow-branch-session-continue-store.test.js`).

## 6. TLC Receipts (TLC 2.19, Temurin JDK 21.0.13.1, 2 workers)

All 15 `i8.*` cases ran exhaustively with 0 timeouts and 15/15 matching expectations:
- Safety & liveness PASS (0 errors, 0 deadlocks): `i8.fix-two-branch-safety` (2,700,838 distinct states, 88 s), `i8.fix-two-branch-live` (87,455 states, 13 s), `i8.fix-fail-branch-isolation` (10,398 states, 2 s), `i8.fix-outer-loop-safety` (644,319 states, 20 s), `i8.fix-outer-loop-live` (644,319 states, 101 s), `i8.fix-two-branch-outer-safety` (4,211,022 states, 128 s; 2 branches × 2 forks with cuts, cross-fork replacement, and mixed-branch graceful stop).
- Deliberate `OrderByNodeOrdinalOnly = TRUE` faults VIOLATED as expected: `i8.fault-node-ordinal-only` (`Inv_MonotonicCycleOrder`, 104 states), `i8.fault-node-ordinal-q5` (`Inv_StoppingKeepsActiveVisit`, 589 states).
- Non-vacuity witnesses REACHED (7/7): `W_BranchLoopCommitRecall` (40 states), `W_CutPendingStopsVisit` (12 states), `W_CutAfterDoneKeepsReply` (45 states), `W_OuterForkReentry` (145 states), `W_CrossForkReplacement` (56 states), `W_StoppingMixedBranches` (96 states), `W_OwedCutThenRunEnd` (70 states).
- Pre-existing 134 `WfContinuedSession` cases remain untouched (`cases.tsv` total: 149 cases, `./check-packet.sh` OK).
