# WfForkJoin ↔ named branches at `cf2a31416d339eec6fae72f4ff66fe56999cd082` (fix head; stack on `bb9a6022`)

Read with commit-pinned `git show`. Lines are at `cf2a3141`. It replaces the binding at `758fd4d1`. The engine code at
`77c3d99f` and `3f3e96fb` is the same as at `758fd4d1` for everything below except NB-R2 and NB-R5, which the
implementation-shaped fault cases reproduce. "Unchanged" means the For each machinery that option A reuses.

| Model action / definition | Code at cf2a3141 | Label / note |
|---|---|---|
| `AdmitRoot` (F), `Fill`, initials | runtime.ts 1453 `startBranches` → 629 `parallelBranchInitial`; plan fields `branches`, `initials`, `branchStates` checked by 643 `namedForkValid` (NB-R4) | Code behavior. Default concurrency = branch count; more than 16 branches without `concurrency` is refused (compiler NB-R3) |
| `AdmitRoot` (F), `EntryErr` | runtime.ts 3758-3780: branch inputs evaluated and frozen as the manifest; inputSchema on the arrived value; `invalid_input` | Code behavior |
| `AdmitBranch`, ids `KeyOf` | runtime.ts 1741-1790: ordinal key `${scopeId}/${nodeId}`, `enter`; scope `<parallel exec>#<index>` (parallel.ts 12) | Code behavior. State ids unique in the workflow (compiler.ts 1606, 1646) |
| `AdmitBranch` (terminal) → `AskJoin` | runtime.ts `endBranch` 1584 → 1560 `askJoin` | Code behavior |
| `AdmitRefusedPast` | store.ts 3587-3599 (`cut`); runtime.ts 1768 → 1618 `cutBranch` | Code behavior (FJ-S13) |
| `AdmitLimit`, `LimitReached` | runtime.ts 1741 (`state.steps` across scopes; ended/expired/stopping/paused read first) | Code behavior (FJ-S8) |
| `RouteBranch`, `BTarget` | runtime.ts 2012 `selectRoute`; body states compile without the catch-all (compiler.ts 1581); routes only to the branch's own ids (1285) | Code behavior (FJ-S4, FJ-S6) |
| `BS`, `CSucc`, `CFail`, `Verdict`, `WinnersOf` | parallel.ts 183 `parallelBranchStates`, 243 `parallelSuccesses`, 268 `parallelVerdict`; store.ts 7064 `parallelBranchesIn` | Code behavior, unchanged |
| `DecisionTx` with `StopFence = "fork"` (NB-R2) | store.ts 7012: `settleParallelIn` returns `held` for a named fork once `run.stop` is set (under the run lock): no verdict, no cut, no report. `decideParallelJoin` (6963) answers "wait"; `elapseParallelNode` (6909, 6932) answers "not due" until the stop's deadline | Code behavior. **Model simplification:** the model's answer `stopped` makes the controller learn the stop at once; the code's controller learns it at its next refused admission or collection, and its timer is re-armed to the stop deadline, so it cannot ask in a tight loop. Same safety; the model's liveness is checked with `Prop_StopEnds`/`Prop_StopSettles` |
| `DecisionTx` with `StopFence = "none"` | the code at 3f3e96fb / 77c3d99f: store.ts 6926-6929, 6990-7026 and runtime.ts 1879-1896, 1954-1973, 4451-4455 at 3f3e96fb settle after an accepted stop | Comparison: `fault.impl-r2-stop-settles` must violate `Inv_NoSettleAfterStop` |
| `AllJoinPath = "store"` (NB-R5) | runtime.ts 1480 `storeJoins` is true for every named fork; the join activity (5268) calls `decideParallelJoin` for a named fork whatever its join: verdict, cut and CAS decision in one transaction (store.ts 7000) | Code behavior |
| `AllJoinPath = "two-step"` | at 3f3e96fb runtime.ts 1448-1457, 1558-1571, 5282-5303: join all + failFast + no time limit cuts (`cancelBranchScopes`) and decides later (`completeNode`) | Comparison: `fault.impl-r5-two-step` must violate `Inv_CutOnlyWithDecision` |
| `CutTx`, `CutReq` | store.ts 6849 `cancelBranchScopes` (names read before and outside its transaction, 6854: NB-R1); runtime.ts 1537 `cutBranches`, 5165 activity | Code behavior. NB-R1 (event labels) is not modelled: it changes no state the model tracks |
| `RouteFork` (NB-R6) | runtime.ts 2012-2050; compiler.ts 1248: a fork with timeoutSeconds must route `timed_out` | Code behavior; the model's ASSUME |
| `StopEnd`, `CancelNow`, `CtlSeesEnd`, `AfterEnd` | runtime.ts 3303 `stoppingRefusal`, finishStoppedRun (cancels the pending fork, no report), 1113 `applyCommand`, 2943 `endWorkflowRunAgents` | Code behavior (FJ-S10) |
| `Pause`, `TimerFire` | runtime.ts 1637 `pausedPass`, 1604 `askTimedJoins` | Code behavior, unchanged |
| FJ-S11 | compiler.ts 1363 `WORKFLOW_BRANCH_UNBOUNDED` | warning |

Divergences found at cf2a3141: none. NB-R2 and NB-R5 at 3f3e96fb are reproduced by the two fault cases; the fix head
matches the rule settings (`StopFence = "fork"`, `AllJoinPath = "store"`), which are the model's defaults.
