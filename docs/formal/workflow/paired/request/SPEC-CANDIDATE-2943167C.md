# Request spec candidate: design 2943167c

**Result:** the spec-first request model for the design at 2943167c already
exists. It is `WorkflowRequestSpec57`. This folder makes it a
self-contained, reviewable candidate. It adds no new derivation and no new
behaviour.

## 1. Source and identity

| Item | Value |
|---|---|
| Design file | `docs/proposals/workflow-messaging-request.md` at `2943167c1073d440faee9065982baef6f4104086` |
| Blob | `fdb38954208d33d1a28892e68cdd6b90dd4f5150`, the same blob as at `98979a12` |
| Difference from blob `d57b406b` (commit `57fbb0d6`, the text `WorkflowRequestSpec57` was derived from) | One sentence in 4.3: "The store's transactions state READ COMMITTED in their `BEGIN` … reads, after the wait, the binding the holder committed." (A-ISO) |
| Difference from blob `3e9b7927` (commit `8021c75e`) | Durable expiry (4.3, table 7.2, Q2), plus that sentence |
| Model | `WorkflowRequestSpec57.tla`, a byte-identical copy of the frozen `paired/WorkflowRequestSpec57.tla`, SHA-256 `6bdf65bcc5f05d8192d34b6fc5b8044b506034697310c83be6e7cd797c641a21`. The original stays authoritative; neither copy is edited |
| Entry module | `MCRequestCandidate.tla`: `EXTENDS WorkflowRequestSpec57`; adds one witness predicate and nothing else |

**A-ISO needs no model change.** Calls are serialized by the lock
(`Call` requires `~lock.held`). `Commit` evaluates `ExpiredSeen` on the
bindings that the previous holder committed. That is the behaviour the
sentence states. The model was derived from the design text only, not from
code, so it is still spec-first for this pin. A re-derivation would rebuild
the same transitions from the same text, so the model is not re-derived.

## 2. Design section to model

| Design (2943167c) | Model element |
|---|---|
| 3: derived status, total mapping, no default | `StatusOf`, `Inv_StatusTotal` |
| 4.1: terminal producers (response, elapse, observation, delivery failure, run end, deletion) | `Commit`, `Elapse`, `Observe`, `DeliveryFail`, `RunEnd`, `DeleteRequester` |
| 4.1, 6: session locks before the node; every producer waits for an open response | `lock`, `LockBlocks` (assumption L1) |
| 4.2: ordering oracles (response versus deletion, cancel or stop after a response) | interleavings of the producers with `lock` |
| 4.3: one reading; equality is late; a decision before the deadline may commit after it; durable expiry; READ COMMITTED | `Call` takes `lock.at = clock`; `Commit` decides on it and on `ExpiredSeen`; `ClockMode = "rollback"` lets the clock step back |
| 4.4: observation before the deadline only | `Observe` guard `clock < Deadline` |
| 4.5, D03: pause keeps the deadline | `Pause`, `Resume`; `Elapse` ignores pause; `Collect` needs `~paused` |
| 5: wake intent in the response transaction; lease token per lease; holder completion conditioned on token and `leased`; retry, moot, abandonment once; settled rows final | `Commit` inserts `wake`; `WakeLease`, `WakeDue`, `WakeEnqueue`, `WakeFinish`, `WakeAbandon` |
| 5: lost acknowledgement, reclaim, duplicate hint | `WakeEnqueue` then `WakeDue` (lease expiry) and a new `WakeLease`; `enqueued` counts hints |
| 6: request rule, read-only deleted requester | `RuleOK`, the branches of `Call` |
| 7: check order; tables 7.1 and 7.2; limit; operation identity | `Call` (steps 2, 4, 6, 7), `ReplayCode`, `Commit` |
| 9: Q1 to Q7 | the properties in section 3 |

Not modelled: compiler and IR 7, schema validation, the JSON domain and
hashing (a result is an opaque identity), credential mechanics (a revoked
credential counts as `respLive = FALSE`), versions and routing (Q8),
REST/SDK/MCP, the cancellation notice, and wake backoff timing (abstracted as
`WakeDue`). Future implementation is not modelled as current; there is no
code model of a request runtime yet.

## 3. Bounds, fairness and properties

- **Bounds:** `Deadline = 1`, `MaxTime = 2` (the last value stands for all later time). The design's limit of 50 bindings and cap of 100 attempts are reduced per config to 1 or 2. Operations are `o1` and `o2`; result identities are `X` and the decline; dispatchers are 0 to 2.
- **Fairness (`LiveSpec`):**
  - WF on `Tick`, `Commit`, `Elapse`, `Resume`, `WakeLease`, `WakeDue`, each `WakeEnqueue`, each `WakeFinishAny` and `WakeAbandon`;
  - SF on `Collect`;
  - assumptions A-SCHED, A-RESUME and A-BACKSTOP.
  - Liveness is claimed only with `ClockMode = "monotone"`: alternating `Tick` and `ClockBack` can keep `Elapse` from staying enabled.
- **Safety:** `Inv_StatusTotal`, `Inv_Deadline`, `Inv_WinnerBinding`, `Inv_NoDecisionAfterExpiry`, `Inv_NoLeak`, `Inv_WakeWithRecord`, `Inv_OneAbandonEvent`, `Inv_ExpiryImpliesLate` (monotone only).
- **Action properties:** `Prop_NodeFinal`, `Prop_RecordImmutable`, `Prop_BindingImmutable`, `Prop_DeletedRequesterReadOnly`, `Prop_DecideNeedsLiveParties`, `Prop_EarlyDecisionWins` (monotone), `Prop_EarlyDecisionWinsEligible`, `Prop_SettledWakeFinal`, `Prop_PeerUntouched`.
- **Liveness:** `Live_Decides`, `Live_WakeSettles`, `Live_Collected`.

## 4. Variant A configurations (`rq-*`)

All `rq-*` configs use entry module `MCRequestCandidate`. Variant A is the
literal text; variant B (`SPEC-CANDIDATE-B.md`) is the chosen intent. Only
`rq-wit-observed-after-expiry` was run (it reaches the D-REQ-1 situation).
The other `rq-*` configs are not run as variant A: their `rqb-*` copies were
run on variant B, and the checks of the earlier intent model
(`../WorkflowRequestSpec.tla`) are recorded in `../README.md`. Results of
one variant do not transfer to another.

A hold passes only if its search is complete. A fault or witness counts only
if it violates the named property by the stated causal shape.

## 5. Open design findings

- **F2 to F6** from the first model checks (`../README.md`: `REQUEST_CLOSED` after a response then deletion; abandonment after a lost acknowledgement; runtime outcomes after the deadline; elapse while paused; lock order of delivery failure). The text at 2943167c does not resolve them. Only F1 was resolved, by durable expiry.
- **R57-1**, the residual of the observed-expiry rule (an unobserved deadline passage taken back by the clock).
- **D-REQ-1 (decided: option B).**
  - **Situation:** under a clock that steps back, an operation can be bound `expired` (the request's durable expiry point, 4.3). Then the clock reads below `deadline_at`, and the controller's observation (4.4) decides `unavailable` or `forbidden`. Meanwhile the elapse waits for a reading at or after the deadline.
  - **Question:** does the durable expiry point also bind the controller's producers?
    - **Option A (the current literal text):** no. Only new operations are refused; observation may still fail the request, and `timed_out` waits for the clock.
    - **Option B:** yes. After the expiry point the observation does not decide, and the elapse decides `timed_out` at its next run whatever its reading.
  - **Recommendation:** B. A responder already told `REQUEST_EXPIRED` then sees the same terminal reason, and Q2's elapse-only `timed_out` keeps one meaning across a clock step.
  - **Evidence:** witness 15 shows the situation is reachable under A (it was run). The design chose B (`SPEC-CANDIDATE-B.md`); this model encodes A, the literal text.
