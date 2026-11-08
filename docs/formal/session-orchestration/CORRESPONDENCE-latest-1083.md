# Latest-1.0.83 correspondence

Code: `packages/sdk/src/`. 1.0.83 moved by `git mv` from `orchestration_1_0_83/` to `orchestration/` at `5d8eaa46`;
1.0.82 is frozen in `orchestration_1_0_82/`, the same code as the earlier `orchestration/` except
`runtime.ts:21` (the literal "1.0.82").

## Checks at 5d8eaa46 before binding

| Item | Verdict | Evidence at 5d8eaa46 |
|---|---|---|
| Each version maps to its exact module | fixed | `orchestration-registry.ts` 82 `{ version: "1.0.82", handler: durableSessionOrchestration_1_0_82 }` (imported from the frozen `orchestration_1_0_82/`), 83 `{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_83 }` (from `orchestration/`); `orchestration-version.ts` 15 `DURABLE_SESSION_LATEST_VERSION = "1.0.83"`; registered by `worker.ts` 1011-1017 |
| The frozen 1.0.82 stamps "1.0.82" | fixed | `orchestration_1_0_82/runtime.ts` 21 `CURRENT_ORCHESTRATION_VERSION = "1.0.82"`, used as `sourceOrchestrationVersion` by its continue-as-new; `orchestration/state.ts` 375-404 then converts a thrown-turn retry |
| A default worker registers runTurnV5/EpochV5 and the request tag | fixed | `session-proxy.ts` 5754-5757 (`runTurnV5Handler`; `registerWorkflowIntakeTurnActivity(runtime, "runTurn"/"runTurn2", ...)`, no test-option guard); `worker.ts` 939 tag filter `...milestone.WORKFLOW_MILESTONE_WORKER_TAGS` = `[WORKFLOW_REQUEST_CAPABILITY]` (`milestone-worker.ts` 32; `activity-routing.ts` 101 `"pilotswarm.workflow-request.v1"`); `milestone-worker.js` imported unconditionally (`worker.ts` 936) |
| No duplicate 1.0.83 registration | fixed | `registerOrchestrationVersioned` for the session orchestration only at `worker.ts` 1012 (the registry loop); `milestone-worker.ts` 35-39 registers only the intake activities; `worker.ts` 1078 registers a different name (`WORKFLOW_SESSION_ORCHESTRATION_NAME`) |
| Controller 1.9.0 registered on every worker | fixed | `worker.ts` 1086 `registerWorkflowV2(this.runtime, { ..., workflowRequests: true, ... })` (1100); `workflow/v2/runtime.ts` 3261 `requestsEnabled = deps.workflowRequests === true`, 3272-3279 register 1.9.0 and the tagged 1.1.0 orchestrations; `service.ts` 281-283 picks 1.9.0 for `host.requests`, which every turn sets (`session-proxy.ts` 5755 passes `true`) |

All five hold.

## VersionHandoff, RollingDeploy, DigestWindow, IntakeDrain (bound to 5d8eaa46)

| Model | Code |
|---|---|
| `VersionHandoff` | 1.0.82 continue-as-new input `orchestration_1_0_82/lifecycle.ts` 577-735; 1.0.83 `createInitialState` `orchestration/state.ts` 677-806 (legacy thrown retry 375-404; `thrownTurnKey: null` 747-748); KV FIFO keys `fifo.N` identical (`queue.ts` 53-70 in both); duroxide carries unread messages (`replay_engine.rs` 1069-1080, `limits.rs` 14) and KV (`kv_store.rs`); exact-version replay (`dispatchers/orchestration.rs` 1081-1104) |
| `RollingDeploy` | duroxide 0.1.32: unregistered version abandoned with 1-60 s backoff, poisoned past 10 attempts (`dispatchers/orchestration.rs` 545-558, 722-746; `runtime/mod.rs` 90-120); tag filter fetch (`providers/mod.rs` 15-47) |
| `DigestWindow` | `orchestration/queue.ts` 577-596 (`nextTimerCandidate`), 943-975 (the drain race sets `ready`), 1309-1315 (a queued prompt takes the digest), 506 (`giveBackDroppedPromptWork`), 413 (`giveBackCarriedWork`); `lifecycle.ts` `restorePendingChildDigest` (start = min) and `bufferChildUpdate` |
| `IntakeDrain` | so3's module, unchanged; `Latest83 = TRUE` now holds (`orchestration-version.ts` 15) |

Tests the correspondence relies on: the four harness tests ported to 1.0.83 in this line, and
`fifo-queue-drain.test.js` ("a restored digest taken again keeps its age", the batch-window wait).

## ForcedRefresh

| Model | Code at 91def26a |
|---|---|
| `Forced` | `orchestration/turn.ts` 1362-1366: a completed result with `forceContinuePrompt` continues as new with it as a bootstrap prompt (`continueInputWithPrompt`, `lifecycle.ts` 785; `buildContinueInputWithPrompt` 693-706 merges the pending prompt) through `versionedContinueAsNew` (`lifecycle.ts` 724-783: intake state, owed retry, retry marker, arrival flag, `activeTimerState`); the FIFO stays in KV |
| sources | `enable_workflows` (`managed-session.ts` 3312-3335, ef41ef20: saves the chat's flag through `capabilityServices.enableWorkflows`, then pushes a completed action with `forceContinuePrompt`); `use_package` 2610; agent unload and load 3589, 3596; failed model switch `turn.ts` 760 |
| `wit.fr-forced-while-due` | an intake turn records its attempt (`turn.ts` 1320) before the result switch |

`orchestration/turn.ts` is unchanged 2422c33e..91def26a. ef41ef20 changes no file under `orchestration/` or
`orchestration_1_0_82/`.

Automatic triggers: `session-proxy.ts` 2523-2538 (the runTurn activity, before the turn) set `workflowContextTrigger`
and `workflowContextOwnsCheck` on the run config; `session-manager.ts` 4814-4830 (`_workflowContextMode`) decides the
mode when the session is built. An intake turn (`turnIntake !== null`) sets `lasting`, so Workflows are already on in
it and `enable_workflows` answers "already on" without a forced continue-as-new. No orchestration decision code reads
them. From `011aefe3`, `enable_workflows` and native-task admission share one turn-boundary fence
(`managed-session.ts` 966-980): activation runs only with no native task running, idle or being admitted, and at most
once per turn. That strengthens the precondition of the forced continue-as-new; the model is unchanged.

## MergeRule (bound to 4ffbf909)

| Model | Code at 4ffbf909 |
|---|---|
| `CodeSeesPerson`, `Unknown` | `orchestration/queue.ts` 1550 `RUNTIME_PROMPT_HEADER`; 1561-1565 `promptAuthorClass`: a stamped sender decides (`agent`/`system` not a person's); with none, a prompt that starts with `[SYSTEM:`, `[SESSION_MESSAGE`, `[SESSION_MESSAGE_RESPONSE`, `[WORKFLOW_UPDATE`, `[CHILD_UPDATE` or `[FACTS_INTAKE` is unknown, any other a person's |
| merge stop | `collectMergeablePrompts` 1624: stops at an unknown peek or a class change, so an unknown prompt merges with nothing in either order |
| `StampAll`, `StripClientSender` | the stamping sites (2422c33e) and `client.ts` 1744-1746, unchanged |
| `Legacy`, `QuotedHeader`, `HeaderRule` | prompts drained on 1.0.83 with no sender: a 1.0.82 runtime prompt with its header, a parent's plain text (the known limit), a person's text quoting a header; the rule at 2422c33e (`none`), 91def26a (`notPerson`) and 4ffbf909 (`barrier`) |

`MergeRule.tla` differs from the packet that ran only in its header comment.

## Bound files 2422c33e..91def26a

Code changes in bound files: `orchestration/queue.ts` (fb467403 only, `isPersonPrompt`), `managed-session.ts`,
`session-manager.ts`, `session-proxy.ts`, `worker.ts`. Compared region by region, unchanged: `gracefulShutdown`, the tag
filter and the registry loop (`worker.ts`); the RT-F1 drop, the V5 turn registration and the turn host flags
(`session-proxy.ts`); `invalidateWarmSession` (`session-manager.ts`); `takeUnsettledRun` (`managed-session.ts`).
`orchestration_1_0_82/`, the registry and the version are unchanged. The `queue.ts` change shifts later lines by 8 with
no other change.

## Earlier bindings at `91def26a`

| Binding | At `91def26a` |
|---|---|
| 1.0.83 models bound to `bb162ed8:orchestration_1_0_83/` (`OwnedRetry`, `IntakeDrain`, `CarriedGiveBack`, `RehydrationNotice` T3) | now `orchestration/`: identical except `runtime.ts` (the version follows the latest constant), `turn.ts` 1054-1056 (the budget stash drops a provider-wake paragraph; not a bound region) and `queue.ts` `isPersonPrompt` and the merge stop (bound by `MergeRule`); the bound regions keep their content and shift |
| 1.0.82 models (`orchestration/` at `198ad79a` = main) | `orchestration_1_0_82/`: identical except `runtime.ts:21` |
| `SnapshotWarmDrop`, `WorkerShutdown` | regions unchanged (`session-proxy.ts` RT-F1 drop, `session-manager.ts` `invalidateWarmSession`, `managed-session.ts` `takeUnsettledRun`, `worker.ts` `gracefulShutdown`) |
| fork-join, idle waits (`workflow/v2/`) | `runtime.ts` and `store.ts` change only in comments since `bb162ed8` |
