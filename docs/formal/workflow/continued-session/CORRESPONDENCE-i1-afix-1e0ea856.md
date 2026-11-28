# WfContinuedSession i1 design review D-1 and D-2 correspondence to 1e0ea856

Code: `packages/sdk/src` at `1e0ea856` (the Phase 1 merge branch with the owner's a-fixes); line numbers there. D-2 adds
the constant `NoteLoss`, the visit field `lost`, the invariants `Inv_NoFalseMemoryClaim` and `Inv_LostNotCommitted`, and
the witnesses `W_NoLossTold` and `W_NoUntoldFailed`. D-1 changes no modelled step.

| Model | Code at 1e0ea856 |
|---|---|
| `LoseMem(vis, u)` in `ReplyExpire` / `ReplyAbort` (the reply limit stops the reported turn) | The reply-limit timer sets `replyLimitHit` before its abort (`session-proxy.ts` 2175); the stopped turn is not published, and at the commit point (5774-5784) a turn whose visit was decided in it (`visitDecidedThisTurn`) records the loss, reason `reply_limit` (`forced_stop` when the run had to be settled by force, `runForcedSettled`) |
| `LoseMem(vis, u)` in `SessionLost` (a decided turn loses its live session and is not run again) | `notRunAgain` sets `notRunAgainRan` (5306); the commit point records reason `session_lost`. A retry whose visit was decided by an earlier attempt that was lost with its worker is not run at admission (`notRunAtAdmission`, 4915 and 4961) and records the same, but only for the visit whose own prompt the turn carries (`!inherited`) |
| `LoseMem(vis, t)` in `EndVisit` and `RetryStop` (a Stop ends the completed visit's turn while the run is stopping) | The turn's result is `stopped`, not published; the commit point records reason `stopped` while the run is active |
| `LoseMem`'s guard: `NoteLoss /\ run # "ended" /\ vis[u].how = "result" /\ ~vis[u].mem` | `recordAgentCycleMemoryLost` (`workflow/store.ts` 6951-6966): the visit's invocation is this continued session's, the node is `completed` with winner `agent` (its agent decided it), and the run's status is active (`ACTIVE_RUN_STATUSES`, a stopping run included); recorded once per visit (an event `workflow.agent_cycle_memory_lost` on the Workflow session). The commit point calls it only when the snapshot was not published and no racing attempt committed it (`!committed.alreadyCommitted`), so a visit that committed is never marked (`Inv_LostNotCommitted`) |
| The record precedes the next cycle's `TurnStart` | The record is written in the ended turn's own `runTurn` activity, before it returns; the session takes the next prompt only after that activity ends (a session takes one turn at a time), so the next turn's admission reads it |
| `TurnStart`'s claim: a later cycle's prompt says the earlier cycles are above unless one of them is `lost` (`ClaimFalse`, `LossTold`) | After admission, a turn of a continued session whose own prompt carries `WORKFLOW_AGENT_CYCLE_MEMORY_WORDS` reads `readAgentCyclesLostBefore` (`store.ts` 6989-6999) and rewrites the sentence with `workflowAgentCycleMemoryLostPrompt` (`workflow/agent-node-service.ts`; `session-proxy.ts` 4965-4977); the recovery runs rebuild their prompt with it too (5362, 5457). A read that fails fails the turn (it is retried) |
| `UntoldFailed` (a turn that failed for good after its report, `failedV`) is outside the claim | A `runTurn` activity that throws past its retries reaches no commit point, so nothing is recorded; documented as a known limit |
| D-1 (no modelled step): a reply that never ends by itself is a choice (`AllowStall`) | `noteVisitDecided` cancels the background tasks the turn started before the report (2162-2172, `cancelBackgroundTasks` with `startedWithin` the turn's start to the report); a shell or sub-agent that kept the turn open no longer stalls it. Other stalls (a model that keeps going) remain, bounded by the reply limit |

Not modelled, tested only: the reason chosen; the rewrite's wording (unit test
`workflow-simplified-session-continue.test.mjs`); `read_workflow`'s `agent.memoryLost`
(`workflow-agent-memory-worker.test.js`); the cancel of background tasks (same file, a real shell).
