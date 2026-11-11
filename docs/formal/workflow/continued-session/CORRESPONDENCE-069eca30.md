# WfContinuedSession correspondence to 069eca30

Code: `packages/sdk/src/workflow/` at `069eca30` (PR 270 after the collapse to one version of each orchestration,
the Workflow rename, the removal of pre-release compatibility and the session rename, in which the session that owns
Workflow Definitions stopped being called a chat, and the Sweeper and child-creation fences DR-01 and DR-02, and the parent-first pair lock `09c4e404`; the same bound code as `0df9e8a4`/`781441bf` but for those), line
numbers there. At `3766b346`, where the Copilot CLI close and the fenced first start are reverted to main's behaviour
(`d002b3ad`, `ca1a86f8`), every line number below is the same except the two `cms.ts` ranges in the `Spawn` row, which
the fenced start's removal moved up 36 lines: there `lockLiveParent` is 1849-1856 and the `refuseDeleted` block is
1962-1983, with the same code. The model follows one agent state whose session lifecycle is "continue": the default for an agent
state in the outer graph that does not set the YAML key `session` (`compiler.ts` 1556); a For each body and a named
branch get a new agent session per visit, and `session: continue` there is refused (1304-1317). The IR field is `session` too.

History of the binding: the design run was bound to `a1772a01` (27 of 27 as expected); from `a1772a01` to `9a8d0f66`
the bound regions changed only in the words of prompts and errors. The cases `cc.*` and `finding.*` describe
`9a8d0f66`. Each later group of `impl.*` cases describes the code of one fix commit, with the switches of the fixes
before it on; the switches name the commits:

| Fix | Commit | Switches |
|---|---|---|
| G1, G2, G3, G5 (and PRR-3, visits ordered by ordinal) | `15a306c2`, `f4265d64`, `d2e00a16`, `06b3abab` (`bda053ff`); first bound at `a9f60db7` | `SpawnRecheck`, `StopBeforeSpawn`, `PerAgentSessionEnd`, `StopAtRunEnd`; `RecheckSeesEnding = FALSE` |
| G1 residual: an end is marked on the session before its command | `80019c84` | `EndMark` |
| DRR-1: the create refuses a deleted row, every attempt is checked, the check runs again after the send | `69d07073` | `SplitSpawn`, `CheckAll`, `Fence = "after"`, `Backstop` |
| DRR-2: a Workflow carries the end of a mark it acts on | `5451a22e` | `MarkSplit`, `Carry` |
| DRR-1b: the check after the send carries a deletion (only to a start that reads as existing) | `7bd79a46` | `CarryDelete = "visible"` |
| DRR-1c: the deletion's delete is queued whatever the status says | `9b2ca643` | `CarryDelete = "queued-race"` (DR2-001: queued behind the start and the prompt) |
| DR2-001: a turn of a deleted session runs no model; DR2-002: creates of one id take turns; DR2-003: a marked end is carried to a session that reads NotFound | `a386f3e5`, `7ec59a50`, `de1f9f98` | `TurnGuard`, `CarryNotFound` (DR2-002: the create step is one step, as `Inv_NoRevive` assumes) |

The code of the last row is `impl.cc-final-live`, `fix.cc-dr2-*`. From `0df9e8a4` to `069eca30` the regions below changed
only by the collapse, the two renames, the removal of IR version gates and the fence named in its row (checked
function by function). The fenced first start (AR-01, with DR-03's 30-second bound) was at `069eca30` and is reverted
at `3766b346`; the model never took it (the `fix.cc-dr2-*` and `impl.cc-final-live` cases ran at `781441bf`, before it):
a first message starts the orchestration, then updates the row, then enqueues, as on main, so a deletion just before
the start leaves an orphan start, which `CarryDelete` and `TurnGuard` model. Completing a session is no longer refused while one of its Workflows is active (`ac3fef7b`): the
model's `PersonEnd` never had that condition. `09c4e404` (review ER-03) changes only the order in which a Workflow and
its own child session are locked (the parent first, in both directions; `sessionPairLockOrder`, `store.ts` 7924-7931):
the same rows with the same lock modes, so each modelled step is still one transaction; lock order and deadlock are not
modelled (`../README.md`, "Lock order and freedom from deadlock are not checked"). The tf1 fix (a
turn that fails terminally) is bound in `../orchestration/CORRESPONDENCE-tf1-069eca30.md`.

| Model | Code at 069eca30 |
|---|---|
| `Admit` (the agent session chosen and frozen) | `runtime.ts` 3046-3065 `continuedSessionOf`, `agentSessionEndedOnItsOwn` (unlocked reads: `readAgentVisitsBefore` (`store.ts` 6198), by ordinal; `agentSessionGone` 3073-3085: `isSessionDeleted` (`store.ts` 6111), then the first end mark `readSessionEndMark` (`store.ts` 6097-6108; `EndMark`), carried first (`Carry`); then `getStatus`; a replacement id names the visit, `agent-ids.ts` 26-37), called in the enter activity 3554; frozen as `child_session_id` by `store.ts` 3971-3981 `enterNode`; admission follows collect, which ends the previous visit's child first (1587-1599) |
| `Spawn` (`SplitSpawn = FALSE`), `SpawnCheck`, `SpawnCreate`, `SpawnSend` | `runtime.ts` 4579-4718 `spawnAgent`: `beginAgentSpawn` (`store.ts` 6382-6395); the pending check; the check (`SpawnRecheck`): a later visit that reuses its predecessor's session, `continuedSessionGone` 3090-3095 (4638-4649); G2 (`StopBeforeSpawn`) `endEarlierVisitsOf` 3100-3111 (4650-4653); every other visit, replacement and retried attempt (`CheckAll`, 4655-4662); `host.spawn` (4668) → `agent-host.ts` 264-289 `createChild`: `createSession` with `refuseDeleted` (`cms.ts` 1998-2019: an advisory lock on the id, then the row `FOR UPDATE`; a deleted row is refused and stays deleted, `SpawnCreate` under `Fence`; first the parent row is locked and a deleted parent refuses the child, `PARENT_DELETED`, review DR-02, `lockLiveParent` 1885-1893: the parent of an agent session is its Workflow session, whose deletion has already ended the run and decided the visit, so this adds no step to the model), mapped to `unavailable` (`agent-host.ts` 218-221); then `send` (`SpawnSend`), which refuses an ended orchestration (`client.ts`, the G1 backstop, `Backstop`; the first start is not fenced: a start after a deletion is the orphan start of `CarryDelete` and `TurnGuard`); the check after the send (`Fence = "after"`, 4680-4689), deciding the visit through its own compare-and-set (`fail`); `recordAgentSpawned` (`store.ts` 6398-6414); `agentSpawnFailed` 4721-4762. `AllowSpawnCrash`: an attempt that stops after its send and before `recordAgentSpawned`, and is retried |
| `CarryEnd`, `Carried` (`Carry`, `CarryNotFound`) | `runtime.ts` 2507-2518 `carryMarkedEnd`: `getStatus`; a terminal session gets nothing; otherwise the mark's `done`/`cancel` with id `workflow-mark-end:<mark id>`, as the Workflow, raw `enqueueEvent` (no live check); throws without a client |
| `CarryDelete`, `RaceResolve`, `OrphanTurn` (`TurnGuard`) | `runtime.ts` 2532-2542 `carryDeletedEnd` (called by `agentSessionGone` for every "deleted"): a terminal session gets nothing; otherwise `delete` with id `workflow-deleted-end:<id>`, queued behind the start and the prompt the send queued (`queued-race`); the turn's admission (`session-proxy.ts` 2517-2535, every 1.0.83 turn on a worker with the Workflow store): the lineage read (`store.ts` 5997-6044) returns the row's deletion, and a deleted session's turn runs no model and no tool, queues its own `delete` (`deleted-session-turn:<id>`) and returns `stopped` |
| `Visible` | the attempt's orchestration start becoming visible (an attempt in flight may finish after the run ended) |
| `TurnStart` | `session-proxy.ts` 4939-4965 and 5000 (a turn of a decided visit is not run); prompts in order (the session orchestration's queue) |
| `TurnEnd` | `store.ts` 6230-6263 `agentInvocationOfCompletion` (binds only by node execution id) inside `completeAgentNode` (6553; `NODE_CLOSED`, `NODE_EXPIRED` for a late result) |
| `Timeout` | `runtime.ts` 4184-4199 → `store.elapseAgentNode` (6479-6515) |
| `EndVisit`, `RetryStop` | `runtime.ts` 2555-2598 `endWorkflowAgentChild` (the Workflow's own end mark, 2579-2582) → `recordAgentEnd` (`store.ts` 6422-6430) → 2704-2731 `endContinuedVisit`: the cycle Stop `workflow-cycle-stop:<visit>`, also after the run ended (G5, `StopAtRunEnd`; `workflowTurnStopOf` 2681-2690 swallows only `TURN_CONTROL_UNAVAILABLE`), then `markAgentEndSent(AgentSessionContinues)` (`store.ts` 6460-6469); the collect loop traces a failure (1596-1599); a visit whose end was not sent is ended again before the next spawn (G2) and by the run's end (`endWorkflowRunAgents` with the Stop, G5) |
| `AgentSessionEnd`, `LookLocked` | `runtime.ts` 2756-2808 `lookAtContinuedSession` / `endContinuedSessionLocked` under `withAgentSessionEndLock` (`store.ts` 3210): owed (`NotFound` mark) when not visible and a spawn attempt exists, else the Workflow's end mark (2791-2794) and the `done`/`cancel` command (no Stop) and `AgentSessionEnded` (`store.ts` 6452-6458); the session's orchestration status is read, not its row, so an orchestration running on a deleted row is ended too; the stopping run's collect ends idle agent sessions (3769-3776) |
| `AfterEnd`, `Looked` | `runtime.ts` 888-894 `endRunChildren` (`persistentlyTagged`, about 31 minutes of tries, then swallowed) → 2648-2664 `endWorkflowRunAgentSessions` (the continued sessions are looked at even when an owed child's end failed; G3) → 2816-2839 `endWorkflowContinuedSessions` (each agent session on its own; the call fails after the loop, naming those not ended; G3, `PerAgentSessionEnd`) |
| owed end (`session = "owed"`) | `runtime.ts` 2846-2850 `continuedSessionEndOwed`; 2891-2908 `startContinuedSessionEndRetry` (`wfc-<session>`), 2917-2925 `workflowAgentSessionEnd`; the after-send owed look (4712-4716) |
| `Finish`, `EndCmd` | a `done`/`cancel`/`delete` command is read between turns: it does not stop a running turn (`orchestration/turn.ts`; `lifecycle.ts` handleCommand); one queued behind a queued start is read by the session's first drain, before any turn |
| `Recover` | `service.ts` `finishRecoveredRun` 534 (the turn Stop 543-545), called by `recoverWorkflowRun` (621, 687; `update_workflow` operation recover; on request only) |
| `PersonEnd`, `PersonDelete`, `PersonMark`, `PersonEnqueue`, `PersonEnqueueFails` (`MarkSplit`, `MarkFail`) | `management-client.ts` 1685-1710 `completeSession`, 1742-1765 `cancelSession`, 1771-1824 `deleteSession` (a session not yet started or terminal: the soft delete, with no command); `_sendLifecycleCommand` 4850-4869: for `done`/`cancel`, after the store's handling and `_assertOrchestrationLive` (refuses `NotFound`), `recordSessionEndRequested` (`session-end-mark.ts`) before `sendCommand`; the mark and the command are two writes (a throw or a crash between them leaves the mark only); a parent's `complete_agent`/`cancel_agent`/`manage_agent_session` mark with no live check (`session-proxy.ts` 3132, 4049, 4089; `MarkCreating`) |

Not modelled: the time a Stop takes to land (the documented limit: the next visit's prompt can wait behind the old
turn until its abort lands); a visit's prompt content (cycle number, changed variables); more than one agent state
(their agent session ids are disjoint, `agent-ids.ts` 26-34); the `wfc-` bound of 50 retry instances (not reachable
in practice: one instance per recover after a 31-minute instance); the order of visits (ordinals since `bda053ff`;
the model numbers visits); the Workflow's own end mark for an agent session that is new per visit
(`endWorkflowAgentChild`, outside this model); a turn of a frozen version (1.0.82) or on a worker without the
Workflow store, which has no deletion guard (Workflow agent sessions start at 1.0.83, the latest version); the
Sweeper, which no model here contains (see the known limit in `../../session-orchestration/README.md`).
