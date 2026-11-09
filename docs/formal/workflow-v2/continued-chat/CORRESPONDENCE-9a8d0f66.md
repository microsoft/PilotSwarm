# WfContinuedChat correspondence to 9a8d0f66

Code: `packages/sdk/src/workflow/v2/` at `9a8d0f66` (line numbers there). The model follows one agent state whose
session lifecycle is "continue": the default for an agent state in the outer graph that does not set the YAML key
`session` (`compiler.ts` 1682); a For each body and a named branch get a new agent session per visit, and `session:
continue` there is refused (1417-1430). The IR field is still `chat`.

The model was first bound to `a1772a01` (design run, 27 of 27 as expected). From `a1772a01` to `9a8d0f66` the bound
regions in `runtime.ts` and `store.ts` change only in the words of prompts and errors, on the same lines; `agent-ids.ts`,
`agent-host.ts`, `client.ts`, `session-proxy.ts`, `management-client.ts`, `turn-control-0082.ts` and the session
orchestration are unchanged. The design-run results therefore stand at `9a8d0f66`.

| Model | Code |
|---|---|
| `Admit` (the agent session chosen and frozen) | `runtime.ts` 3404-3418 `continuedChatOf` (unlocked reads: `readAgentVisitsBefore`, `isSessionDeleted`, `getStatus`; a replacement id names the visit, `agent-ids.ts` 26-37), called in the enter activity 3872; frozen as `child_session_id` by `store.ts` 3867-3877 `enterNode`; admission follows collect, which ends the previous visit's child first (1962-1974) |
| `Spawn` | `runtime.ts` 4928-5032 `spawnAgent`: `beginAgentSpawn` (`store.ts` 6244-6257), the pending check (4986), `host.spawn` → `agent-host.ts` 262-273 `createChild` (`createSession` reuses an existing id; then `send`), `recordAgentSpawned` (`store.ts` 6260-6276); a terminal session refuses the send (`client.ts` 1054-1069) and the spawn ends in `agentSpawnFailed` (5035-5051); a deleted one is undeleted by the catalog (`turn-control-0082.ts` 767-782) while duroxide drops the start and prompt for a terminal instance |
| `Visible` | the attempt's orchestration start becoming visible (an attempt in flight may finish after the run ended) |
| `TurnStart` | `session-proxy.ts` 4910-4936 (a turn of a decided visit is not run); prompts in order (the session orchestration's queue) |
| `TurnEnd` | `store.ts` 6092-6125 `agentInvocationOfCompletion` (binds only by node execution id) inside `completeAgentNode` 6457-6536 (`NODE_CLOSED`, `NODE_EXPIRED` for a late result) |
| `Timeout` | `runtime.ts` 4516-4531 → `store.elapseAgentNode` |
| `EndVisit` | `runtime.ts` 2930-2937 `endWorkflowV2AgentChild` → `recordAgentEnd` (`store.ts` 6284-6292) → 3040-3067 `endContinuedVisit`: the cycle Stop `workflow-cycle-stop:<visit>` while the run is active (3046-3050; `stopChatTurn` 3356-3366 swallows only `TURN_CONTROL_UNAVAILABLE`), then `markAgentEndSent(ChatContinues)` (`store.ts` 6322-6331); the collect loop traces a failure (1969-1973) |
| `ChatEnd`, `LookLocked` | `runtime.ts` 3085-3141 `lookAtContinuedChat` / `endContinuedChatLocked` under `withChatEndLock` (`store.ts` 3189-3228): owed (`NotFound` mark) when not visible and a spawn attempt exists, else the `done`/`cancel` command and `ChatEnded` (`store.ts` 6314-6320); the stopping run's collect ends idle agent sessions (4098-4105) |
| `AfterEnd`, `Looked` | `runtime.ts` 1007-1017 `afterEnd` (`persistentlyTagged`, about 31 minutes of tries, then swallowed) → 3012-3015 → 3148-3162 `endWorkflowV2ContinuedChats` (a thrown session end stops the loop) |
| owed end (`chat = "owed"`) | `runtime.ts` 3169-3173 `continuedChatEndOwed`; 3214-3231 `startContinuedChatEndRetry` (`wfc-<chat>`), 3240-3248 `workflowV2ChatEnd` |
| `Finish` | a `done`/`cancel` command is read between turns: it does not stop a running turn (`orchestration/turn.ts` 558-605; `lifecycle.ts` handleCommand) |
| `Recover` | `service.ts` 619-633 (`update_workflow` operation recover; on request only) |
| `PersonEnd`, `PersonDelete` | `management-client.ts` 1685-1770 (`done`/`cancel`), 1775-1825 (delete: cancel, soft delete) |

Not modelled: the time a Stop takes to land (the documented limit: the next visit's prompt can wait behind the old
turn until its abort lands); a visit's prompt content (cycle number, changed variables); more than one agent state
(their agent session ids are disjoint, `agent-ids.ts` 26-34); the `wfc-` bound of 50 retry instances (not reachable
in practice: one instance per recover after a 31-minute instance).
