# WfContinuedSession i1 review R3 correspondence to 19bd0cc1

Code: `packages/sdk/src` at `19bd0cc1` (issue I1 with the fixes of review R3); line numbers there.
`CORRESPONDENCE-i1-5f24054e.md` and `CORRESPONDENCE-i1-r2-85c3ad9d.md` map the rest of the i1 model and still hold; the
R3 fixes move their `session-proxy.ts` lines by about 20. The model change is one choice in `TurnReport`: `seen` is
always `TRUE` unless the fault `"reconcile-unlocked"`, so every earlier case takes the same steps.

| Model | Code at 19bd0cc1 |
|---|---|
| `TurnReport(s)` with `AckLost` and `Reconcile`: a read-back after a write whose call failed sees the result (`seen`): the read is ordered after the write. Fault `"reconcile-unlocked"`: a plain read may see the visit pending while the COMMIT is in flight (`ce367456`) | `storedTurnVisitDecided` (`session-proxy.ts` 2759-2765) reads the visit with `readNodeStateAfterWriters` (`workflow/store.ts` 4527-4533): `SELECT state ... FOR SHARE`, which waits for the `FOR UPDATE` row lock that `completeAgentNode` takes on the node (7274) until that transaction commits or rolls back, then reads the latest committed row. `lock_timeout` (`WORKFLOW_VISIT_READ_LOCK_MS`, 10 s) bounds the wait; past it the read fails, and the failure closes the turn's tools (`workflow/agent-node-service.ts` 158-161) |

Not modelled, with the reason:

- **R3-2, a retried `session: new` turn.** The model has only continued sessions. The fix applies the turn-start fence
  the model already has (`TurnStart` skips a decided visit's turn) to a `session: new` step's own visit:
  `decidedAtAdmission` (`session-proxy.ts` 4845-4853), used by both admission paths (4870, 4931), reads the step's own
  visit (`oneShotVisit`, 2753-2758) when the session has no turn visit.
- **R3-3, a disconnect that never answers.** The model's turns end in one step; the lock and the CLI's disconnect are
  worker internals. The fix bounds both forced invalidations: the turn's own (`session-proxy.ts` 5243,
  `UNSETTLED_RUN_DESTROY_DEADLINE_MS`, 5 s) and the backstop (`session-manager.ts` 2427,
  `FORCED_STOP_DESTROY_DEADLINE_MS`, 5 s); `invalidateWarmSession` forgets the handle when the deadline passes.
