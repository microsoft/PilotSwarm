# Durable expiry at 57fbb0d6: correspondence and obligations

These models cover the core correction `57fbb0d6` ("Keep a request expired
once an operation was bound expired"). They are separate modules: the intent
module and the code models for 8021c75e (see `README.md` and `CODE-MODEL.md`)
stay unchanged, and no result of those models applies to the modules here.

## Source pins

| Item | Pin |
|---|---|
| Commit | `57fbb0d68f415826bf456efbe8cbbc6183d7e4ce`, tree `6353dfa34de62de61157adc0fc05bcdd33bb855e` |
| Design `docs/proposals/workflow-messaging-request.md` | blob `d57b406b`, SHA-256 `09e95692f25efbfe59df86b757835e82aea189321a111d61529f0f3b4b09d6d7` |
| `packages/sdk/src/workflow/store.ts` | blob `5ce3288c`, SHA-256 `e2ab597ecef09d625a8927fc9ad8c028f0f99686b85b4bc50ebcc25ef3eac962` |
| Regression `packages/sdk/test/local/workflow-request.test.js` | blob `86da3205`, SHA-256 `16afb0a873c49533da188de183fa3e53d321f986336bf281ef8ebc5e3d74e768` |

Between 8021c75e and 57fbb0d6, these functions are byte-identical:
`finishRun`, `elapseWait`, `completeNode`, `lockSessionPair`,
`lockLiveSession`, `enterNode`, `requestStateIn`, `requestStatusOf` and
`requestStateFrom`. `authority.ts`, `runtime.ts`, 0087 and 0093 are unchanged.
In `cms-migrations.ts`, only the registration of 0094 is new. In
`respondToRequest`, only the in-time check changed (`store.ts` 3108-3117).
The intake slice (`f5758ec5`, migration 0094) touches no row these models use
and is not modeled here (see `recipient/`).

## The correction

| | 8021c75e | 57fbb0d6 |
|---|---|---|
| Code, step 7 (pending request) | decide when `reading < deadline_at` | decide when `reading < deadline_at AND NOT EXISTS (binding with outcome 'expired')`, under the same session and node locks |
| Design 4.3, 7.2, Q2 | a reading before the deadline decides | the first `expired` binding is the request's expiry point; every later new operation is `REQUEST_EXPIRED` whatever its reading |
| Known-operation replay | unchanged | unchanged |
| Schema | - | no change |

Why the code's check is one committed state: the only writer of an `expired`
binding is `bind("expired")` in `respondToRequest` step 7. That write happens
after `lockSessionPair` (requester row `FOR NO KEY UPDATE`) and the node's
`FOR UPDATE`. The new `NOT EXISTS` runs in the same transaction after the
same locks. So every `expired` binding that some other response committed is
visible to it, and none can appear before this transaction commits.

## Models

| File | What it is |
|---|---|
| `WorkflowRequestSpec57.tla` | A copy of the intent module with only the 57fbb0d6 design change. `Commit` decides only with `rd < Deadline /\ ~ExpiredSeen`. A `ClockMode` constant: `"monotone"` (A-CLK) or `"rollback"` (the clock may step back without a fault). Fault `"no_durable_expiry"` restores the 8021c75e rule. Added definitions: `ExpiredSeen`, `Prop_EarlyDecisionWinsEligible`, `Inv_ExpiryImpliesLate`, and the action witness `Prop_NoLateCommitDecision`. Nothing else changed (`diff` against the frozen module shows only these). |
| `MCWorkflowRequestSpec57Late.tla` | Witness wrapper. It adds two history variables (`wasLate`, `readLate`) and `Prop_NoDecisionFromLateReading`. It changes no definition of the module. |
| `WorkflowRequestCode57.tla` | A copy of the code model with the 57fbb0d6 in-time check (`at < Deadline /\ ~ExpiredBound`), `CClockBack` under `ClockMode = "rollback"`, and `Inv_C_NoDecisionAfterExpiry`. The mapping is to `WorkflowRequestSpec57` (`CClockBack` maps to `ClockBack`). |
| `MCWorkflowRequestCode8021Clock.tla` | The code model at 8021c75e, unchanged, plus clock rollback and `Inv_C_NoDecisionAfterExpiry`. It is the code-level form of the original counterexample. The obligations for 8021c75e and for 57fbb0d6 stay in separate modules. |

## The eligibility refinement (not a weakening)

The 57fbb0d6 design adds a condition to the rule that decides. The early-decision
property changes with it, and both forms stay checkable:

- `Prop_EarlyDecisionWins` (original, unchanged): a reading before the
  deadline on a pending request wins.
- `Prop_EarlyDecisionWinsEligible` (57fbb0d6): the same, when no operation
  was bound `expired` before the reading. Bindings change only in `Commit`,
  and commits are serialized by the lock. So `ExpiredSeen` just before the
  commit equals its value at the reading.

Under A-CLK the two antecedents are equal. `Inv_ExpiryImpliesLate`
(`ExpiredSeen => clock >= Deadline`) holds with a monotonic clock, because an
expired binding needs a reading at or after the deadline. A reading before the
deadline therefore never meets `ExpiredSeen`. With rollback they differ: an
early reading taken after an observed expiry is now refused, and the original
property is expected to fail. `rs57-as-rollback-original-eligibility` and
`rs57-hd-monotone-equiv-small` state both sides. No invariant is weakened.
`Inv_NoDecisionAfterExpiry` is the property the original counterexample
violated, and it keeps its exact form.

## The genuine early-reading, late-commit case

`Prop_NoLateCommitDecision` is a witness that is expected to fail. A response
whose one reading is before the deadline, with no expired binding, still
decides when its commit comes after the deadline (T061). The witness is checked
with `ClockMode = "monotone"` (`rs57-wit-late-commit`) and with `"rollback"`
(`rs57-wit-late-commit-rollback`). The regression's control case is the same
eligible reading on a request with no expired binding (`requestClock` −1 s
decides). It matches `Prop_EarlyDecisionWinsEligible` with an early commit.

## Residual (a design hypothesis, unchecked)

R57-1: durable expiry starts only when an operation observes the expiry, that
is, when one is bound `expired`. Suppose the clock passes the deadline with no
call, then steps back, and only then a call reads before the deadline. That
call decides. `rs57-wit-unobserved-late` is meant to show that this is
reachable in the model. The store at 57fbb0d6 has no other expiry marker:
- the elapse is not request-aware;
- no other path records an expiry point.
So the decision window follows the operations' wall-clock readings until an
expiry is bound. The design can accept this and say so, or record an expiry
point at the first observation by any path, for example a future request-aware
elapse that finds the deadline passed. This is a design question
and not a defect claim against 57fbb0d6.

## Correspondence to the new regression

| Regression step | Model |
|---|---|
| o1's injected reading equals the deadline: `REQUEST_EXPIRED`, bound `expired` | `Commit` expired branch (`rd >= Deadline`) |
| o2 and o3 at deadline − 1 s: `REQUEST_EXPIRED`, bound `expired`; nothing decided, no wake, no event | `Commit` expired branch through `ExpiredSeen`; `Inv_NoDecisionAfterExpiry`, `Inv_C_NoDecisionAfterExpiry` |
| Known operations replay without a reading; another result is `OPERATION_CONFLICT` | `Call`/`RBody` replay branch (unchanged) |
| Control: a fresh request at −1 s decides; a later call gets the winner's receipt | `Prop_EarlyDecisionWinsEligible`; `same` binding |

The regression injects only the deciding reading, by rewriting the
`WITH reading AS (SELECT clock_timestamp() ...)` statement in a test client. In
the model this corresponds to `ClockBack` before `RBody`, not to a stepped-back
clock everywhere. The model's rollback is more general, because it can also
step back during an open transaction, as in the counterexample of `rs-as-clock-backward`.

## Correspondence limits for the code models

The ten code-model limits in `README.md` (section "Limits of the code models") still apply,
with two changes:

- limit 4 is replaced: clock rollback is now modeled (`ClockMode`) in
  `WorkflowRequestCode57` and in the 8021c75e wrapper;
- the code models keep the `CLoseAuthority` guard (A-OWN as an
  assumption). The authority audit (`CODE-AUTH-AUDIT.md`) carries over to 57fbb0d6 because every
  authority input and its writers are unchanged. Every PASS expected below is
  conditional on A-OWN and on an already-entered request.

## Open limitation of the VIEW wrapper

The VIEW wrapper `MCWorkflowRequestSpecView` is not shown to be exact.
`Prop_DeletedRequesterReadOnly` checks `bind' = bind`, and that includes
`count`, which the view erases. `TypeOK` also checks erased fields, so a
`TypeOK` result on representative states does not cover the original type
invariant. Any future view must keep `count`, or come with a
property-preservation proof. The `Workers = {}` projections and the wake
over-approximation are arguments, not proven substitutions. The projection
configurations (`rs-px-*`, `rs-pv-decision`) carry these limitations.

## Configurations

| Configuration | Module | Clock | Expected |
|---|---|---|---|
| `rs57-df-no-durable-expiry` | `WorkflowRequestSpec57` | rollback, fault `no_durable_expiry` | `Inv_NoDecisionAfterExpiry` violated (the original r1 counterexample, reproduced) |
| `rs57-as-rollback-original-eligibility` | `WorkflowRequestSpec57` | rollback | the original `Prop_EarlyDecisionWins` violated (eligibility refinement); for example Tick, Call o1 at 1, Commit `expired`, ClockBack, Call o2 at 0, Commit `expired` |
| `rs57-wit-late-commit` | `WorkflowRequestSpec57` | monotone | `Prop_NoLateCommitDecision` violated (reachable): Call at 0, Tick, Commit decides |
| `rs57-wit-late-commit-rollback` | `WorkflowRequestSpec57` | rollback | the same witness violated |
| `rs57-wit-unobserved-late` | `MCWorkflowRequestSpec57Late` | rollback | `Prop_NoDecisionFromLateReading` violated (R57-1): Tick, ClockBack, Call at 0, Commit decides |
| `rs57-hd-rollback-small` | `WorkflowRequestSpec57` | rollback | PASS at a smaller bound only: `Inv_NoDecisionAfterExpiry`, `Inv_Deadline`, `Inv_StatusTotal`, `Inv_WinnerBinding`, `Prop_EarlyDecisionWinsEligible`, `Prop_NodeFinal` |
| `rs57-hd-monotone-equiv-small` | `WorkflowRequestSpec57` | monotone | PASS at a smaller bound only: `Inv_ExpiryImpliesLate`, `Prop_EarlyDecisionWins` and `Prop_EarlyDecisionWinsEligible` |
| `rc8021-as-rollback` | `MCWorkflowRequestCode8021Clock` | rollback | `Inv_C_NoDecisionAfterExpiry` violated (code at 8021c75e) |
| `rc57-as-rollback` | `WorkflowRequestCode57` | rollback | PASS: `Inv_C_NoDecisionAfterExpiry`, the status mapping, no corrupt answer, and the `Refines` obligation to `WorkflowRequestSpec57`. Conditional on the limits above. |
| `rc57-hd-monotone` | `WorkflowRequestCode57` | monotone | PASS, as above without rollback |

Recorded results are in `README.md`. The cases with a violation stop at a
shallow counterexample. `rc57-as-rollback` explores the whole code kernel at
its bounds.
