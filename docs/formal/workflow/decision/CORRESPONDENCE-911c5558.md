# WorkflowDecision correspondence to 911c5558 (controller 1.2.0, the Decision state)

Code at `911c55582f08b4165ed58d4a0884a6610137e46b` (PR 328 head `2e940637` and one proposal commit; `packages/` is
identical at both). Paths are under `packages/sdk/src/`; line numbers are at `911c5558`.

Labels: **Code behavior** (the model does what the code does), **Rule to evaluate** (a property the code is checked
against), **Model simplification** (the model abstracts or leaves out code).

## Actions

| Model action or definition | Code at 911c5558 | Label |
|---|---|---|
| `Enter`: the node execution is created pending | `workflow/controller/index.ts` 654 (`enter`); `workflow/store.ts` 3810 `enterNode`; a Decision state has no deadline (4012) | Code behavior |
| `Dispatch`, test run: interception, no effect | `workflow/controller/index.ts` 781-785 (`node.type === "decision" && plan.test === true` → `workflow.intercept`); the interception record is made at entry (`workflow/runtime.ts` 2239-2248) | Code behavior |
| `Dispatch`, live run: the Decision effect starts | `workflow/controller/index.ts` 786-791: `startOrchestrationVersioned("workflow-effect", WORKFLOW_DECISION_EFFECT_VERSION, …, { …, nodeType: "decision" })`; `workflow/controller/runtime.ts` 93 (`"1.1.0"`); registered at `workflow/runtime.ts` 1577-1578. The version and input are not model values: the recorded 1.2.0 histories check them (`test/unit/workflow-controller-replay.test.mjs`) | Code behavior; the version is a model simplification |
| `TestAnswer`: the parent or a fixture decides the node, winner test | `workflow/runtime.ts` 3955-4000 (`interceptState`), `workflow/store.ts` 7851 (`respondInterception`), `workflow/test-mode.ts` 258-271 (the Decision answer goes through the same policy) | Code behavior; the answer is one of `Answers` |
| `Route`: the stored result routes | `workflow/controller/index.ts` 908-962; `workflow/controller/runtime.ts` 695-699 (`selectRoute`) | Code behavior; a runtime error with its own route is abstracted to `failure` (simplification) |
| `CancelRun`: the run ends and its pending node is decided, one transaction | `workflow/store.ts` 7106-7140 (`endRunIn`, `endPending` winner `cancel` or `controller`) | Code behavior; deletion and the run's deadline are the same action (simplification) |
| `ActRead`: a completed node returns `{ kind: "completed" }`; a test run throws | `workflow/runtime.ts` 2914-2925; the effect turns the activity error into `execution_failed` (`workflow/effect_1_1_0/index.ts` 153-157) | Code behavior |
| (not modeled) `actx.isCancelled()` before entry | `workflow/runtime.ts` 2926 | Model simplification: it only returns `{ kind: "completed" }` earlier |
| `ActEnter`: the attempt is counted under the locks, only for a pending node of an active run | `workflow/runtime.ts` 2928-2929; `workflow/store.ts` 4353-4373 (`enterScript`: `effect_attempts + 1 … WHERE state = 'pending'`, active run) | Code behavior |
| `ActCap`: attempt > 2 is `unavailable`, no claim, no call | `workflow/runtime.ts` 2930-2933 | Code behavior |
| `ActAdmit`: binding, host, budget admission, provider resolution | `workflow/runtime.ts` 2935-2972 | Code behavior; every refusal is abstracted to `unavailable` (simplification) |
| `ActClaim`: the ledger claim of (operation, attempt), first only | `workflow/runtime.ts` 2994-3006; `provider-store.ts` 499-511; `migrations/decision-provider-identity-0100.ts` 233 (`ON CONFLICT (operation_id, attempt) DO NOTHING`) | Code behavior |
| `ActCall`: the provider call, an answer or a provider error | `workflow/runtime.ts` 3013-3048; the liveness check aborts a call whose node is no longer pending or whose activity is cancelled (2974-2990) | Code behavior; the abort is one of the error results (simplification) |
| `ActSettle`: settlement in `finally`, only when claimed, retried, its failure swallowed | `workflow/runtime.ts` 3049-3070; `cms-retry.ts` 135-146 (`swallow: true`); `provider-store.ts` 517-532; `migrations/decision-provider-identity-0100.ts` 281 (`settled_at IS NULL`), wrapped by `provider-inference-latency-0101.ts` 15-30 | Code behavior; `MaxSettleRetry` bounds repeats over the whole behaviour (simplification) |
| `ActRecord`: the activity result enters the effect's history | `workflow/effect_1_1_0/index.ts` 154 | Code behavior (Duroxide: a completed activity is replayed from history, never run again) |
| `Crash`: the activity is delivered again; local state is lost, rows stay | Duroxide at-least-once activity delivery before the completion is recorded | Model simplification (an assumption about Duroxide), bounded by `MaxCrash` |
| `EffRecord`: `recordEffectResult` → `completeNode`, pending-only | `workflow/effect_1_1_0/index.ts` 158; `workflow/runtime.ts` 3257-3276; `workflow/store.ts` 4394-4415 | Code behavior; the store retry policy (`effect_1_1_0/index.ts` 72-81) and the wake (159) are not modeled |
| Fault `noIntercept` | the 1.1.0 generator's generic start, had the Decision reached it | Rule to evaluate (fault) |
| Fault `noTestGuard` | `workflow/runtime.ts` 2923-2925 removed | Rule to evaluate (fault) |
| Fault `noCap` | `workflow/runtime.ts` 2930-2933 removed | Rule to evaluate (fault) |
| Fault `callBeforeClaim` | the claim (2996) moved after the call (3015) | Rule to evaluate (fault) |
| Fault `noEntryGuard` | `workflow/store.ts` 4356-4363 without the live-session, active-run and pending checks | Rule to evaluate (fault) |
| Fault `settleNotFirstOnly` | migration 0100 281 without `settled_at IS NULL` | Rule to evaluate (fault) |
| Fault `settleAlters` | a settlement error that escapes `finally` (the catch at 3066-3068 and the retry's `swallow` removed) | Rule to evaluate (fault) |
| Fault `noCas` | `workflow/store.ts` 4403 without `AND state = 'pending'` | Rule to evaluate (fault) |

## Properties

| Property | Rule |
|---|---|
| `Inv_CallCap` | At most two provider calls per node execution; a third or later delivery makes no claim and no call |
| `Inv_ClaimBeforeCall` | A claim precedes every call; one call per attempt |
| `Inv_SettleOnce` | An attempt is settled at most once, and only a claimed one |
| `Inv_SettlementInert` | Settlement never changes the Decision result |
| `Inv_NoWorkAfterDecided` | A cancellation or lifecycle end that commits before the entry stops the delivery before any claim or call |
| `Inv_FirstWinnerKept`, `Inv_ResultFromHistory`, `Inv_RouteFromStored` | The node's first decision is final; an effect's stored result is the one in its history; routing reads the stored result |
| `Inv_TestNoEffect`, `Inv_TestNoProvider`, `Inv_LiveNotIntercepted` | A test Decision starts no effect and touches no provider; a live one is never intercepted |
| `Prop_Routed` | A live Decision with no cancellation is routed (weak fairness on the controller's and the effect's steps) |

## Not modeled

- More than one node execution: each visit has its own node execution id, which is the ledger's operation id, and its
  own attempt count.
- The collection's effect watch, which fails a pending Decision whose effect ended without storing a result
  (`workflow/runtime.ts` 2434-2450, shared with scripts and modeled for scripts by `../WorkflowRun.tla`).
- An immediate result at entry (an invalid model binding in a test run is `invalid_input` at entry, 2241-2242).
- A Decision inside a parallel branch, the catch-all state, pause, and replay.
- The provider's own behaviour and the semantic policy; `Answers` stands for its outcomes.

## Verdict

Bound at `911c5558`. A change to the files above needs a re-read and a re-run; test or document changes need only a
re-pin with `packages/sdk/src` unchanged.
