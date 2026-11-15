# Code model of the request store at 8021c75e

`WorkflowRequestCode.tla` models the request store as the code implements
it. It is not based on the intent model's actions. A refinement mapping at the
end of the module relates it to the frozen intent model
`WorkflowRequestSpec.tla`; the code model changes no file of the intent model.

The recorded results of these configurations are in `README.md`.

## Source

The model reads only these files at 8021c75e.

| File | Blob | SHA-256 |
|---|---|---|
| `packages/sdk/src/workflow/store.ts` | `493c80b7` | `f98a116b6070c9345ab92ef88645b0eab5b65045d595ca9aac6b12ae43117e5a` |
| `packages/sdk/src/workflow/authority.ts` | `8bdb22e3` | `068242b433046a8bea9c7471db95853866263377de4db1a24a4c687321d68562` |
| `packages/sdk/src/workflow/runtime.ts` | `314f55ec` | `14e6f716b5f0d9f45baaab5d80709654f217838c60ff9dd30a3cf3b81748813b` |
| `packages/sdk/src/migrations/workflow-v2-0087.ts` | `4cc92916` | `e311e81fc9f880762c335b74df5d447a79afcb47fec004ee370338fa08924960` |
| `packages/sdk/src/migrations/workflow-v2-0093.ts` | `08fa0f03` | `573e81c74acad0eccdf73fbe5975f0a9de51d86e3b6ba4725772d02be220a731` |

## What exists at 8021c75e

The request is a disabled foundation:

- The plan activity refuses a request state (`runtime.ts` 1376), so no
  runtime path enters one.
- `beginDelivery`, `recordDelivery` and `failDelivery` refuse a request
  message (`store.ts` 2985, 3053, 3101).
- There is no request-aware elapse, no observation, no wake dispatcher and
  no collection for a request.

The model therefore starts with one request already entered pending
(`enterNode`, `store.ts` 2240-2345) and covers the store API that can act on
it.

| Code | Action | Notes |
|---|---|---|
| `respondToRequest` 2785-2795 | `RLock` | Reads the request row, runs `lockSessionPair` (requester `FOR NO KEY UPDATE`, actor `FOR SHARE`), then `decideRequestAuthority`. A refusal is `REQUEST_NOT_FOUND`. |
| `respondToRequest` 2797-2878 | `RBody` | Branches: known operation (count updated only for a live requester), deleted requester (`REQUEST_CLOSED`), limit, then the node lock and one `clock_timestamp()` reading. Validation failures write nothing and are not modeled. |
| `respondToRequest` 2879-2935 | `RCommit` | `requestStateIn` (a contradiction is `WORKFLOW_STORE_CORRUPT` and nothing is written), then decide or bind. |
| `finishRun` 3133-3189 | `CFinishRun` | `lockLiveSession`; does nothing for a deleted requester or an inactive run. Cancels pending nodes. |
| trigger in 0087 | `CDelete` | The soft delete waits for the requester's row lock; pending nodes of an active run become `cancelled` (winner `delete`) and the run becomes `cancelled`. |
| responder row update | `CDeleteResponder` | Waits for the `FOR SHARE` lock. |
| authority inputs | `CLoseAuthority` | Assumption A-OWN, below. |
| `elapseWait` 2442-2475 | `CElapse` | Only with `Caller = "store_api"`. No runtime caller exists for a request node at this commit. |

## Mapping to the intent model

| Concrete step | Intent step |
|---|---|
| `CTick` | `Tick` |
| `RLock`, refused | `Call` (`REQUEST_NOT_FOUND`) |
| `RLock`, allowed | stutter (the actor holds the session locks; the reading is not yet taken) |
| `RBody` | `Call` (replay, `REQUEST_CLOSED`, `OPERATION_LIMIT`, or the reading) |
| `RCommit` | `Commit` |
| `CFinishRun` | `RunEnd` |
| `CDelete` | `DeleteRequester` |
| `CDeleteResponder` | `DeleteResponder` |
| `CLoseAuthority` | `LoseAuthority` |
| `CElapse` | none: its node result (business `elapsed`) is not an intent result |

Intent actions with no concrete counterpart at 8021c75e are `Elapse`,
`Observe`, `Deliver`, `DeliveryFail`, `Purge`, `RespOrchEnd`, `Pause`,
`Resume`, `Collect` and every wake step. Their variables map to constants. The
claim is safety refinement only (`Refines == A!Spec`). No liveness claim is made
at 8021c75e: with no elapse, a pending request with no response stays pending
until the run ends or the requester is deleted.

The cancellation time is a modeling choice. `finishRun`, the trigger and
`completeNode` write `completed_at = now()` (transaction start), not
`clock_timestamp()`. The model uses the current clock. No intent property
constrains the time of a cancellation.

## Configurations

| Configuration | Caller | Checks | Expected |
|---|---|---|---|
| `rc-hd-refines` | `runtime_8021` | `TypeOK_C`, `Inv_C_StatusMapped`, `Inv_C_NoCorruptAnswer`, `Refines` | PASS |
| `rc-hd-refines-limit` | `runtime_8021` | the same, limit 1 | PASS |
| `rc-cand-elapse-store-api` | `store_api` | `Inv_C_StatusMapped` | violation: `CTick`, `CElapse` |
| `rc-cand-elapse-refines` | `store_api` | `Refines` | violation at the `CElapse` step |

Each configuration runs as a separate TLC job on `WorkflowRequestCode.tla`.
The module instantiates `WorkflowRequestSpec.tla` from the same folder.

## Observations from the code (candidates, unchecked)

| Id | Class | Observation |
|---|---|---|
| C1 | Candidate latent store-guard gap; unreachable at 8021c75e | `elapseWait` completes any pending `wait` or `messaging` node whose `deadline_at` has passed (`node_type IN ('wait', 'messaging')`). A request node is a messaging node with `deadline_at` set at entry, so the store would store business `elapsed` (winner `controller`). `requestStatusOf` rejects that as corrupt. `completeNode` (2407) also accepts any result from its caller. Today only the controller's plan refusal keeps these writers away from request nodes. Concrete repro to propose: in a store test, enter a request node with a 1 s deadline, wait past it, call `store.elapseWait`, then `readRequest`; with the current code we expect `WORKFLOW_STORE_CORRUPT`. Forward obligation for the gated commit 3: exclude request nodes from `elapseWait`, and decide `timed_out` (runtime error) at one `clock_timestamp()` reading, not `now()`. |
| C2 | Agrees with intent (L1, F6) | Every store writer that can complete a request node at 8021c75e takes the requester's session row first: `respondToRequest` (`lockSessionPair`), `finishRun`, `completeNode` and `elapseWait` (`lockLiveSession`), and the deletion trigger (the row update itself). The delivery writers take it and then refuse the request mode. This answers F6 for the current code only, not for the future request delivery. |
| C3 | Agrees with intent (F2) | For a new operation with a deleted requester, the code returns `REQUEST_CLOSED` with the derived status and no receipt (2844-2847). This is the choice the intent model made for F2. |
| C4 | Assumption A-OWN | `lockSessionPair` locks the session rows but reads `session_owners`, `users` and the definition's parent without locks. The ghost-user merge updates `session_owners` (`cms-migrations.ts` 2892, 13911; `feature-flags-0077.ts` 235). The model assumes authority inputs do not change while a response transaction holds the session locks. |
| C5 | Agrees with intent (storage guard) | The guard trigger in 0093 refuses updates and deletes that would change a request row, a response, a binding's identity fields or a settled wake. This is the storage-level form of `Prop_RecordImmutable`, `Prop_BindingImmutable` and `Prop_SettledWakeFinal`. |

None of these is a confirmed code defect. C1 needs the concrete repro and the
model run before anyone can classify it.
