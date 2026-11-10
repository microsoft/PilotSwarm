# WfContinuedChat correspondence to 0df9e8a4

Code: `packages/sdk/src/workflow/` at `0df9e8a4` (the pull request branch; the same code as `781441bf`), line
numbers there. The model follows one agent state whose session lifecycle is "continue": the default for an agent
state in the outer graph that does not set the YAML key `session` (`compiler.ts` 1685); a For each body and a named
branch get a new agent session per visit, and `session: continue` there is refused (1420-1433). The IR field is still
`chat`.

History of the binding: the design run was bound to `a1772a01` (27 of 27 as expected); from `a1772a01` to `9a8d0f66`
the bound regions changed only in the words of prompts and errors. The cases `cc.*` and `finding.*` describe
`9a8d0f66`. Each later group of `impl.*` cases describes the code of one fix commit, with the switches of the fixes
before it on; the switches name the commits:

| Fix | Commit | Switches |
|---|---|---|
| G1, G2, G3, G5 (and PRR-3, visits ordered by ordinal) | `15a306c2`, `f4265d64`, `d2e00a16`, `06b3abab` (`bda053ff`); first bound at `a9f60db7` | `SpawnRecheck`, `StopBeforeSpawn`, `PerChatEnd`, `StopAtRunEnd`; `RecheckSeesEnding = FALSE` |
| G1 residual: an end is marked on the session before its command | `80019c84` | `EndMark` |
| DRR-1: the create refuses a deleted row, every attempt is checked, the check runs again after the send | `69d07073` | `SplitSpawn`, `CheckAll`, `Fence = "after"`, `Backstop` |
| DRR-2: a Workflow carries the end of a mark it acts on | `5451a22e` | `MarkSplit`, `Carry` |
| DRR-1b: the check after the send carries a deletion (only to a start that reads as existing) | `7bd79a46` | `CarryDelete = "visible"` |
| DRR-1c: the deletion's delete is queued whatever the status says | `9b2ca643` | `CarryDelete = "queued-race"` (DR2-001: queued behind the start and the prompt) |
| DR2-001: a turn of a deleted session runs no model; DR2-002: creates of one id take turns; DR2-003: a marked end is carried to a session that reads NotFound | `a386f3e5`, `7ec59a50`, `de1f9f98` | `TurnGuard`, `CarryNotFound` (DR2-002: the create step is one step, as `Inv_NoRevive` assumes) |

The code at `0df9e8a4` is the last row: `impl.cc-final-live`, `fix.cc-dr2-*`. Commits after `0df9e8a4` on the branch
(the canvas bridge, the test harness, clean-ups) do not touch the regions below.

| Model | Code at 0df9e8a4 |
|---|---|
| `Admit` (the agent session chosen and frozen) | `runtime.ts` 3511-3530 `continuedChatOf`, `chatEndedOnItsOwn` (unlocked reads: `readAgentVisitsBefore` (`store.ts` 6129), by ordinal; `agentSessionGone` 3538-3550: `isSessionDeleted` (`store.ts` 6042), then the first end mark `readSessionEndMark` (`store.ts` 6028-6039; `EndMark`), carried first (`Carry`); then `getStatus`; a replacement id names the visit, `agent-ids.ts` 26-37), called in the enter activity 4030; frozen as `child_session_id` by `store.ts` 3901-3911 `enterNode`; admission follows collect, which ends the previous visit's child first (1965-1977) |
| `Spawn` (`SplitSpawn = FALSE`), `SpawnCheck`, `SpawnCreate`, `SpawnSend` | `runtime.ts` 5083-5222 `spawnAgent`: `beginAgentSpawn` (`store.ts` 6313-6326); the pending check; the check (`SpawnRecheck`): a later visit that reuses its predecessor's session, `continuedChatGone` 3555-3560 (5142-5153); G2 (`StopBeforeSpawn`) `endEarlierVisitsOf` 3565-3576 (5154-5157); every other visit, replacement and retried attempt (`CheckAll`, 5159-5166); `host.spawn` (5172) → `agent-host.ts` 264-289 `createChild`: `createSession` with `refuseDeleted` (`cms.ts` 1944-1958: an advisory lock on the id, then the row `FOR UPDATE`; a deleted row is refused and stays deleted, `SpawnCreate` under `Fence`), mapped to `unavailable` (`agent-host.ts` 218-221); then `send` (`SpawnSend`), which refuses an ended orchestration (`client.ts`, the G1 backstop, `Backstop`); the check after the send (`Fence = "after"`, 5184-5193), deciding the visit through its own compare-and-set (`fail`); `recordAgentSpawned` (`store.ts` 6329-6345); `agentSpawnFailed` 5225-5266. `AllowSpawnCrash`: an attempt that stops after its send and before `recordAgentSpawned`, and is retried |
| `CarryEnd`, `Carried` (`Carry`, `CarryNotFound`) | `runtime.ts` 2939-2950 `carryMarkedEnd`: `getStatus`; a terminal session gets nothing; otherwise the mark's `done`/`cancel` with id `workflow-mark-end:<mark id>`, as the Workflow, raw `enqueueEvent` (no live check); throws without a client |
| `CarryDelete`, `RaceResolve`, `OrphanTurn` (`TurnGuard`) | `runtime.ts` 2964-2974 `carryDeletedEnd` (called by `agentSessionGone` for every "deleted"): a terminal session gets nothing; otherwise `delete` with id `workflow-deleted-end:<id>`, queued behind the start and the prompt the send queued (`queued-race`); the turn's admission (`session-proxy.ts` 2510-2528, every 1.0.83 turn on a worker with the Workflow store): the lineage read (`store.ts` 5927-5974) returns the row's deletion, and a deleted session's turn runs no model and no tool, queues its own `delete` (`deleted-session-turn:<id>`) and returns `stopped` |
| `Visible` | the attempt's orchestration start becoming visible (an attempt in flight may finish after the run ended) |
| `TurnStart` | `session-proxy.ts` 4939-4965 and 5000 (a turn of a decided visit is not run); prompts in order (the session orchestration's queue) |
| `TurnEnd` | `store.ts` 6161-6194 `agentInvocationOfCompletion` (binds only by node execution id) inside `completeAgentNode` (6484; `NODE_CLOSED`, `NODE_EXPIRED` for a late result) |
| `Timeout` | `runtime.ts` 4680-4695 → `store.elapseAgentNode` (6410-6446) |
| `EndVisit`, `RetryStop` | `runtime.ts` 2987-3030 `endWorkflowAgentChild` (the Workflow's own end mark, 3011-3014) → `recordAgentEnd` (`store.ts` 6353-6361) → 3136-3163 `endContinuedVisit`: the cycle Stop `workflow-cycle-stop:<visit>`, also after the run ended (G5, `StopAtRunEnd`; `workflowTurnStopOf` 3113-3122 swallows only `TURN_CONTROL_UNAVAILABLE`), then `markAgentEndSent(ChatContinues)` (`store.ts` 6391-6400); the collect loop traces a failure (1974-1977); a visit whose end was not sent is ended again before the next spawn (G2) and by the run's end (`endWorkflowRunAgents` with the Stop, G5) |
| `ChatEnd`, `LookLocked` | `runtime.ts` 3188-3240 `lookAtContinuedChat` / `endContinuedChatLocked` under `withChatEndLock` (`store.ts` 3210): owed (`NotFound` mark) when not visible and a spawn attempt exists, else the Workflow's end mark (3223-3226) and the `done`/`cancel` command (no Stop) and `ChatEnded` (`store.ts` 6383-6389); the session's orchestration status is read, not its row, so an orchestration running on a deleted row is ended too; the stopping run's collect ends idle agent sessions (4256-4263) |
| `AfterEnd`, `Looked` | `runtime.ts` 1007-1019 `afterEnd` (`persistentlyTagged`, about 31 minutes of tries, then swallowed) → 3080-3096 `endWorkflowRunChats` (the continued sessions are looked at even when an owed child's end failed; G3) → 3248-3271 `endWorkflowContinuedChats` (each agent session on its own; the call fails after the loop, naming those not ended; G3, `PerChatEnd`) |
| owed end (`chat = "owed"`) | `runtime.ts` 3278-3282 `continuedChatEndOwed`; 3323-3340 `startContinuedChatEndRetry` (`wfc-<chat>`), 3349-3357 `workflowChatEnd`; the after-send owed look (5216-5220) |
| `Finish`, `EndCmd` | a `done`/`cancel`/`delete` command is read between turns: it does not stop a running turn (`orchestration/turn.ts`; `lifecycle.ts` handleCommand); one queued behind a queued start is read by the session's first drain, before any turn |
| `Recover` | `service.ts` `finishRecoveredRun` 608 (the turn Stop 617-619), called by `recoverWorkflowRun` (696, 762; `update_workflow` operation recover; on request only) |
| `PersonEnd`, `PersonDelete`, `PersonMark`, `PersonEnqueue`, `PersonEnqueueFails` (`MarkSplit`, `MarkFail`) | `management-client.ts` 1686-1715 `completeSession`, 1747-1770 `cancelSession`, 1776-1829 `deleteSession` (a session not yet started or terminal: the soft delete, with no command); `_sendLifecycleCommand` 4856-4875: for `done`/`cancel`, after the store's handling and `_assertOrchestrationLive` (refuses `NotFound`), `recordSessionEndRequested` (`session-end-mark.ts`) before `sendCommand`; the mark and the command are two writes (a throw or a crash between them leaves the mark only); a parent's `complete_agent`/`cancel_agent`/`manage_agent_session` mark with no live check (`session-proxy.ts` 3128, 4050, 4090; `MarkCreating`) |

Not modelled: the time a Stop takes to land (the documented limit: the next visit's prompt can wait behind the old
turn until its abort lands); a visit's prompt content (cycle number, changed variables); more than one agent state
(their agent session ids are disjoint, `agent-ids.ts` 26-34); the `wfc-` bound of 50 retry instances (not reachable
in practice: one instance per recover after a 31-minute instance); the order of visits (ordinals since `bda053ff`;
the model numbers visits); the Workflow's own end mark for an agent session that is new per visit
(`endWorkflowAgentChild`, outside this model); a turn of a frozen version (1.0.82) or on a worker without the
Workflow store, which has no deletion guard (Workflow agent sessions start at 1.0.83, the latest version).
