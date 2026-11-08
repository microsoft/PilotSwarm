# Request candidate, variant B (D-REQ-1 chosen)

**Decision:** the design decision of 2026-11-02 on durable expiry semantics
chose B. It is applied here as a separately named
intent variant.

Variant A is unchanged and stays as a record, not as the chosen intent. A
consists of `WorkflowV2RequestSpec57` (the literal text), `MCRequestCandidate`
and its `rq-*` configs. No result transfers between variants.

## 1. What B changes

`WorkflowV2RequestSpecB.tla` extends `MCRequestCandidate` (which extends
Spec57). It replaces exactly two actions, in its own `NextB`:

| Action | A (Spec57) | B |
|---|---|---|
| `Observe` | the node is pending, the reading is before the deadline, and the responder is unavailable | `ObserveB == Observe /\ ~ExpiredSeen`: a committed `expired` binding is the durable expiry observation, and no observation decides after it, even after a clock rollback |
| `Elapse` | the reading is at or after the deadline | `ElapseB`: the reading is at or after the deadline **or** `ExpiredSeen`. `decidedAt` is the actual reading, so it may be below the deadline after a rollback. No value is manufactured |

`SpecB`, `FairnessB` and `LiveSpecB` are Spec57's definitions with these
two actions substituted.

**Unchanged in B, per the decision:**

- **F4:** delivery failure, run end, cancel and deletion still compete through the first pending compare-and-swap.
- Responses, replay, authorization and the wake are as in A. No response record or wake is made for an expired binding.
- **R57-1** stays a limit: an unobserved deadline passage that the clock then takes back.

## 2. Invariants and timestamp semantics

| Property | Meaning |
|---|---|
| `Inv_NoObserveAfterExpiry` (B) | No controller observation decides `unavailable` or `forbidden` once an `expired` binding exists. It is the negation of A's witness `Wit_ObservedAfterExpiry` |
| `Inv_DeadlineB` (B) | A response needs a reading before the deadline. A `timed_out` is justified by a reading at or after the deadline, **or** by the durable expiry point. A controller observation needs a reading before the deadline and no expiry point. Every `decidedAt` is the actual reading |
| Spec57 `Inv_Deadline` (raw clock) | Expected to **fail** under B with rollback (`rqb-as-raw-deadline`). This is the check that B keeps the actual reading and does not invent one |
| `Wit_TimedOutAfterRollback` (B, positive witness) | `timed_out` decided by the expiry point at a reading below the deadline |

**Equivalence under A-CLK (argued, not checked).** With
`ClockMode = "monotone"`, `ExpiredSeen` implies `clock >= Deadline`
(`Inv_ExpiryImpliesLate`). So `ObserveB` equals `Observe` and `ElapseB`
equals `Elapse`. The monotone configs of A and B then describe the same
behaviours. The `rqb-*` copies still run B directly, so B is the checked
intent.

## 3. F2 to F6 dispositions (decision text) against the model

| Finding | Decision | Model |
|---|---|---|
| F2 | A new operation from the frozen responder of a deleted requester gets the read-only `REQUEST_CLOSED` with the actual derived status. It gets no receipt and no binding. A known operation replays after authorization | `Call`'s deleted branch (already so in Spec57); `rqb-wit-closed-after-delete`, `rqb-df-bind-on-deleted` |
| F3 | `abandoned` means the acknowledgement was not confirmed within the budget, not that no hint was enqueued | `WakeAbandon` after `WakeEnqueue`; `rqb-wit-abandoned-after-enqueue` |
| F4 | Deadline precedence applies only between observation and elapse | `ObserveB` and `ElapseB` only; `rqb-wit-delivery-failed-after-deadline` stays reachable |
| F5 | Elapse may settle while the run is paused; collection waits for resume | `Elapse(B)` ignores pause; `Collect` needs `~paused`; `rqb-wit-timed-out-while-paused` |
| F6 | The exact lock graph remains a source-proof obligation | assumption L1 (`LockBlocks`); `rqb-df-no-lock` |

## 4. Bounds and fairness (from Spec57, unchanged)

- `Deadline = 1`, `MaxTime = 2` (the last value stands for all later time).
- Operations `o1`, `o2`; result identities `X` and the decline.
- Binding limit 1 to 2 (50 in the design); attempt cap 1 to 2 (100 in the design); 0 to 2 dispatchers.
- Fairness `FairnessB`: WF on `Tick`, `Commit`, `ElapseB`, `Resume` and the wake steps; SF on `Collect`. Assumptions A-SCHED, A-RESUME and A-BACKSTOP.
- Liveness is claimed only with a monotone clock.

## 5. Configurations (`rqb-*`)

Entry module `WorkflowV2RequestSpecB` unless marked A. A hold passes only if
its search is complete.

| Group | Configs | Expected |
|---|---|---|
| Expiry | `rqb-hd-expiry-small` (rollback, 1 operation) | PASS: `Inv_NoObserveAfterExpiry`, `Inv_DeadlineB` and others |
| Expiry witnesses | `rqb-wit-timed-out-after-rollback`; `rqb-as-raw-deadline` (Spec57 `Inv_Deadline` violated by the same trace) | violated: Tick; Call at reading 1; Commit binds `expired`; ClockBack; ElapseB decides `timed_out` at reading 0 |
| A comparison | **A** `rq-wit-observed-after-expiry` (entry `MCRequestCandidate`) | A's witness reached, 7 states: the original rollback case that B prevents |
| Holds | `rqb-hd-wake` (monotone), `rqb-hd-liveness-small` (monotone, `LiveSpecB`), `rqb-hd-decide-rollback` | PASS |
| Faults (6) | `rqb-df-no-lock`, `-replay-first`, `-bind-on-deleted`, `-wake-separate`, `-no-token`, `-abandon-twice` | named property violated, by the shape in each config header |
| Witnesses (6) | `rqb-wit-stale-holder`, `-abandoned-after-enqueue`, `-op-conflict`, `-closed-after-delete`, `-delivery-failed-after-deadline`, `-timed-out-while-paused` | reached |
| Strict witnesses (2, `MCRequestBStrict`) | `rqb-wit-strict-op-conflict`, `rqb-wit-strict-elapsed-while-paused` | reached (they close the weaker shapes of `rqb-wit-op-conflict` and `rqb-wit-timed-out-while-paused`) |

**Config accounting:** variant A has 16 `rq-*` configs (a record). Variant B
has 20 `rqb-*` configs: the B copies of A's matrix, plus `rqb-hd-expiry-small`,
`rqb-wit-timed-out-after-rollback`, `rqb-as-raw-deadline` and the 2 strict
witnesses. Recorded results are in `README.md`.
