# WfContinuedSession i1 correspondence to 4753e1cd

Code: `packages/sdk/src` at `4753e1cd` (issue I1: a continued agent step remembers its earlier visits), on main
`b79be29d`; line numbers there. The i1 cases switch on `SplitTurn` and `NoStopOnDone` over the G1-G5 fixes and the end
mark (`IMPL2` in `gen-cases.py`), with the spawn as one step, as the tf1 cases do. Every other case keeps both switches
`FALSE`, and its behavior is the same as before i1: with `SplitTurn = FALSE` the new actions are never enabled, the new
fields never change, and `EndVisit` takes the same steps.

| Model | Code at 4753e1cd |
|---|---|
| `TurnReport(s)`: the agent's result in the middle of its turn decides only its own pending visit; the turn goes on (`rep`) | `complete_workflow_node` (`managed-session.ts` 3701-3712) through `completeWorkflowNodeFromTool` (`workflow/agent-node-service.ts` 95-125): the store's compare-and-set decides the turn's own visit (`turnVisit`, the fence of RT-3); `onDecided` (line 116) calls `session.decideWorkflowVisit()` (`session-proxy.ts` 3385; `managed-session.ts` 1057), which closes the Workflow tools and makes the pre-tool hook refuse every call (`withWorkflowVisitDeny`, `session-manager.ts` 762-771, installed at 3438 for a Workflow agent step's session). The turn is not ended there |
| `TurnFinish(s)`: the turn ends by itself after its reply, and its snapshot is committed (`mem`) | the turn's natural end; `runTurnCommit` (`session-lifecycle.ts` 375) commits every result but a stopped one (393) or a lost runtime. Weak fairness: a turn ends at the latest at its own time limit (`DEFAULT_TURN_TIMEOUT_MS`, `managed-session.ts` 791) |
| `EndVisit(v)`: `stopping == sends /\ (~NoStopOnDone \/ how # "result" \/ run # "active")` | `endContinuedVisit` (`workflow/runtime.ts` 1418-1446): `turnEnds = end === "cancel" \|\| !active \|\| Boolean(run?.stop)` (1423) guards the Stop (1425). `how = "result"` is `end = "done"` (the node's winner is the agent, `recordAgentEnd`); `run # "active"` is a run that is stopping (`run.stop`) or ended (`!active`) |
| `EndVisit`: the Stop clears only a turn of `v` (`hits`); a Stop for `v` while another visit's turn runs is kept off it (`stopFenced`); `Fault = "stop-unfenced"` drops the fence | the turn-to-visit fence, unchanged: the Stop's request id names its visit (`workflow-cycle-stop:<nx>`); `admitTurnControls` (`session-proxy.ts` 4773-4791) records a Stop that names another visit as too late, and the turn end fences with the turn's visit (`turnVisitFence`) |
| `StopLoss(u)`: a stopped turn commits nothing (`doneTurnStopped`, `doneStoppedActive`) | `runTurnCommit` skips the commit of a stopped turn (`session-lifecycle.ts` 393-405) and the session records `session.snapshot_unpublished` with `modelMemoryCommitted: false` (`session-proxy.ts` 5611-5640) |
| `Spawn(v)`: a prompt sent while a completed visit's turn runs is queued (`qb`) | the spawn's send enqueues the prompt on the session's `messages` queue; the session orchestration takes it only between turns ("messages that arrived during one turn run together in the next", `orchestration/queue.ts` 984) |
| `TurnStart(s)`: the next turn takes the oldest queued prompt, skips a decided visit's, and binds to its own visit (`last`, `ranAfterDone`) | `readTurnVisit` (`workflow/store.ts` 6778-6806: the open visit its prompt ids name) and the decided-visit guard at turn start (`session-proxy.ts` 4792, 4813-4837) |
| `RetryStop(u)`: a failed Stop sent again (G2, G5) | `endEarlierVisitsOf` (`workflow/runtime.ts` 1822-1833) and the run's end (`endWorkflowRunAgents`): unchanged; a visit completed by its agent while the run is active is never `gaveUp`, as it sends no Stop |

Not modelled: a tool call in the same model message as the report (the CLI runs a message's pre-tool hooks before any
handler, so it is not refused); the tools a turn refuses after the report (they do not change the Workflow's state);
a turn that fails after its report (`TurnFails` ends it without a commit, as before).
