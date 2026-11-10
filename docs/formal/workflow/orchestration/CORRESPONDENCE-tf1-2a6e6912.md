# tf1 correspondence to 2a6e6912 (a Workflow agent child's turn that fails terminally)

Code at `2a6e6912` (PR 270, after the collapse, the Workflow rename, the removal of pre-release compatibility and the session rename; the fix was written as `70542a47`..`d3230de4` and
`270fcd25`, then integrated by `952a02df`..`5b49c864` and `034071c1`). Line numbers are at `2a6e6912` (the same as at `840dd954`). The three models
share one fix, so their bindings are in one table.

| Model | Code at 2a6e6912 |
|---|---|
| `OwnedRetry`: `RetryExhausted` (a turn's terminal failure owes the report) | `orchestration/workflow-turn-failure.ts` 43-50 `oweWorkflowTurnFailure` (only a session whose id is an agent session's: `isWorkflowAgentSessionIdShape`; at most one report owed, a later failure's prompt ids join it), called at every terminal failure in `orchestration/turn.ts`: 214 (`handleConnectionClosedRetry`, no durable hand-off), 284 (`projectAuthFailure`), 320 (`projectNonRetryableTurnFailure`), 353 (`handleGenericRetry`, retries spent); never while a retry is owed |
| `OwnedRetry`: `ReportSend` | `settleWorkflowTurnFailure` 53-66: the report activity (`session-proxy.ts` 1301 `reportWorkflowAgentTurnFailure`); made: no longer owed; failed: still owed, made again at the start of each execution (`orchestration/runtime.ts` 248) and before the next turn (`turn.ts` 392 `processPrompt`) |
| `OwnedRetry`: `ContinueAsNew` carries the report | `orchestration/lifecycle.ts` 752-757 (`versionedContinueAsNew`), restored by `orchestration/state.ts` 811 (`restoreWorkflowTurnFailure` 29-37) |
| `OwnedRetry`: `LaterSuccess`; `WfAgent` `ChildRecovers`; `WfContinuedSession` `RecoveredTurn` | `dropWorkflowTurnFailure` 69-74, called by `turn.ts` 1337 (`handleTurnResult`: a turn that ran and succeeded) |
| `WfAgent` `ChildFailsTerminally`; `WfContinuedSession` `TurnFails` | a session error ends a Workflow agent child's turn as an error, also after text (`managed-session.ts` 4833-4836 `sessionErrorEndsTurn`, set by `session-proxy.ts` 5268 for a Workflow agent child); then the turn's retries (`OwnedRetry`) |
| `WfAgent` `ReportDecide` (fenced, winner controller, wakes the controller) | `workflow/agent-turn-failure.ts` 93-114 `decideWorkflowAgentTurnFailure`: the visit's invocation must name this session; the node must be a pending agent state; `store.completeNode` (`workflow/store.ts` 4047-4068: `UPDATE ... WHERE node_execution_id = $1 AND state = 'pending'`, `won`) decides it `execution_failed`, winner `controller`; then 117-146 `reportWorkflowAgentTurnFailure` wakes the run's controller (`workflow-wake`, a hint: the controller's backstop collection finds the result) |
| `WfAgent` at least once (`rep = "again"`) | the activity retries transient store errors (`registerWorkflowAgentTurnFailureActivity` 148-167; registered by `workflow/milestone-worker.ts` 42 on every worker) and the orchestration makes it again while owed; a second decision of a decided node is refused by the `state = 'pending'` condition |
| `WfContinuedSession` `ReportDecide(u)`: the turn's own visit | `workflowAgentTurnVisits` 73-87: a session that is new per visit has one visit; a continued session's visits are those named by the failed turns' prompt ids (`workflowVisitOfPromptId`) whose invocation is this session's; with no prompt id, the turn's inherited visit (`readTurnVisit`); never the session's newest visit by itself. A turn can carry a decided visit's late prompt with the next visit's: at most one of them is pending, and every named pending visit is decided |
| `execution_failed` routing | as any error (`selectRoute`: an `execution_failed` route, else the failure route, else the catch-all state); no `WfGraph` change |

Not modelled: the report's words (`cause`, clipped); the 64-id bound on an owed report's prompt ids; a worker with no
Workflow store (the activity fails and the report stays owed until a worker with one makes it).
