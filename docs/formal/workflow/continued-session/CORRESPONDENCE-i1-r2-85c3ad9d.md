# WfContinuedSession i1 review R2 correspondence to 85c3ad9d

Code: `packages/sdk/src` at `85c3ad9d` (issue I1 with the fixes of review R2: `7faf780f` for R2-2, `85c3ad9d` for R2-1
and R2-3); line numbers there. `CORRESPONDENCE-i1-5f24054e.md` maps the rest of the i1 model and still holds: the R2
fixes move no line it cites outside these files. The R2 cases switch on `AsyncAbort`, `AckLost` and `AllowLoss` (the
environment review R2 describes) over the i1 fixes (`I1F` in `gen-cases.py`); the fixed cases also switch on `Reconcile`.
`i1.cc-abort-unfenced` and `i1.cc-ack-lost` describe `0dae9760` (i1 at review R2); `i1.fault-replay-decided` is a
deliberate fault (a recovery that does not read the visit), of which review R2-1 found one instance there. Every earlier
case keeps all four switches `FALSE`, and its behavior is the same as before: `ReplyFire`, `ReplyAbort` and
`SessionLost` are never enabled, `ab` stays 0, `ack` never changes, `ReplyExpire` and `TurnReport` take the same steps,
and the new history tokens are never added.

| Model | Code at 85c3ad9d |
|---|---|
| `ReplyFire(s)` (`AsyncAbort`): the reply limit's timer fires for the running turn (`ab`) | the settle timer armed by `noteVisitDecided` (`session-proxy.ts` 2140) calls `abortWarmSessionTurn` with this turn's index (`expectedTurnIndex`), checked once against the warm handle's active turn (`session-manager.ts` 2358-2368) |
| `ReplyAbort(s)`: the abort lands later; it ends the turn only while that turn runs (`t = a`); finding the next visit's turn, it leaves it (`abortFenced`). Fault `"abort-unfenced"`: it ends whichever turn runs (`stopOther`), the code at `0dae9760` | after the task cancel and in the grace wait, `stillRunning` (`session-manager.ts` 2401: the same handle in the warm map, and the same active-turn record, which `runTurn` makes anew for each run, `managed-session.ts` 1734-1735) guards every step: the wait, the forced settle, and its settle wait. The forced settle marks the run unsettled (2418, `managed-session.ts` 1883), so the stopped turn's own activity drops its handle before it releases the session lock (`session-proxy.ts` 5212-5226); the backstop invalidation (2423) drops the handle only if its newest run is still that run (`invalidateWarmSession`, 4416) |
| `TurnReport(s)` with `AckLost`: the write commits but the worker may not learn it (`ack` FALSE); with `Reconcile` it does (`ackReconciled`) | `completeWorkflowNodeFromTool` (`workflow/agent-node-service.ts`): a failure other than a `WorkflowStoreError` (a refusal, which writes nothing) reads the visit (`visitDecided`, 114, 158-161; `storedTurnVisitDecided`, `session-proxy.ts` 2742-2753, wired at 3419); decided, or a read that fails, runs `onDecided` (the tools close and the reply limit is armed), pending leaves the call retryable |
| `ReplyArmed(s)`: the reply limit runs only for a turn whose result the worker knows (`~AckLost \/ ack`) | the settle timer is armed only by `onDecided` (`noteVisitDecided`) |
| `SessionLost(s)` (`AllowLoss`): a turn whose visit is decided (`rep`: in this turn, or decided meanwhile) loses its live session or has its transcript refused; it ends without a commit (`lostNotRun`). Fault `"replay-decided"`: its prompt runs again (`ranDecided`); at `0dae9760` this happened when the report came in the live-session recovery's own run and that run's transcript was then refused | `visitDecidedNow` (`session-proxy.ts` 5239: the turn's flag, set by `onDecided` in any of its runs, or the store's read of the turn's visit) is checked before the live-session recovery (5249), before its model run (5301-5303), before the transcript recovery resets anything (5331) and before its model run (5396-5398); a decided visit ends the turn `stopped` (`notRunAgain`, 5240-5246: no commit, no retry). A store that cannot be read throws, so the turn fails and is retried, and the turn-start fence reads the visit again |

Not modelled: the tool calls a turn makes (the hook refuses them after `onDecided`; they do not change the Workflow's
state), and a lost session before the visit is decided (its replay runs the pending visit's prompt, a step that changes
nothing in the model).
