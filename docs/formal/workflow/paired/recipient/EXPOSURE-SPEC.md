# Exposure protocol r2: spec-first extension (recipient)

**Amendment a1** (review of `67ab1bbe`; the four changes are in section 7).

**Summary:** a spec-first model of the settled durable pre-send exposure
protocol. It covers one invocation: the durable marker, admission, end and
cancel, and the accepted result's origin. It is derived only from the
semantic contract. The code-derived variants are `RecipientExposureCode` and
the `MCExposure*` modules (see `EXPOSURE-CODE-C1BDA7A2.md` and
`EXPOSURE-CODE-1E240B0F.md`).

## 1. Sources (contract, not code)

| Source | Identity |
|---|---|
| Plan revision 2 | the intake exposure plan, revision 2 |
| Review agreement on r2, with three binding clarifications | the review agreement on the exposure plan |
| Design decision | the decision on the r2 implementation (accepted 2026-11-02) |

Unchanged:

- `RecipientTurnSpec` (r1) and `RecipientTurnSpecR2`;
- the accepted `RecipientTurnSpecG` (revalidated, `4ed86f50`);
- all earlier recipient models and results.

This module does not change them. It refines one thing that SpecG left
abstract: what the witness of an attempt means across redelivery, and what a
negative end may claim.

## 2. Contract to model

| Contract item | Model |
|---|---|
| Marker table `workflow_intake_exposures`, insert-only, first exposure only (plan 1) | `marker` (attemptId of the first admission); `Prop_MarkerInsertOnly` |
| One recorded attemptId per carrying activity, reused by redelivery and in-activity recovery; a new carrying activity draws a new one (plan 2) | `att[k]` per attempt; `ex[k][e]`, the executions of attempt `k`, all with id `k` |
| `sentBefore` only from the own-retry marker of a sent invocation (plan 2) | `StartAttempt`: `sb = (ost = "retry" /\ osent)` |
| Admission under the invocation lock: exact ordered active batch, recipient and claims, text digest; settled before marker; same id allowed; another id allowed only with `sentBefore` (plan 3, review 1) | `AdmitAnswer`, `AdmitTxn` |
| Lost COMMIT answer: reconfirm with the same id, send nothing until a positive answer (plan 3) | `AdmitTxn(k, e, TRUE)`, `Reissue` |
| Awaited admission raced against the real guards; recheck before the send; own `sent` only at the include (plan 4, review C2) | `Guard` (Stop, cancellation, timeout, inactivity), `Send` (`onIntakeIncluded`) |
| Typed refusals `exposed` and `settled`; the refused run sends without the items (plan 4) | `ref`, `Omit` |
| Accepted completion: the first completion of an attempt is accepted, and its own witness decides (review 2) | `Complete`, `att[k].acc`, `AcceptedWit` |
| Orchestration: `exposed` ends the invocation `interrupted`, with no park and no retry; `settled` in an active history fails visibly (plan 5) | `Apply` |
| End: applied outcome computed first; only `not_dispatched -> interrupted`; no rewrite of a final row; replay checks the original call and returns the applied outcome; the answer may be lost (plan 5, 6) | `EndCall(lost)` (a1), `endReq`, `oout`, `Inv_CoercionOnly`, `Inv_EndAnswerIsApplied`, `Prop_OutFinal`, `Prop_ProcFinal` |
| Unsent cancel: with a marker, monotone `cancel_requested` and per-item `exposed`, also as a replay after terminal processing; without one, the item settles cancelled, or `final` after the end (plan 6) | `UnsentAnswer` (a1 order: cancelled subset, then marker, then final), `CancelWrite`; `Prop_CreqMonotone` |
| C1: the cancelled subset is excluded before the active batch is validated; a replayed cancel of such an item answers settled before the marker is read | `Active` in `AdmitAnswer`; the first branch of `UnsentAnswer`; `CancelReplay` (a delayed duplicate cancel write) |
| C3: the worker's digest of the exact text, compared with the store's canonical hash | the execution's `text`; `AdmitAnswer` refuses `alt` as a protocol fault |
| Unsent carry blocked by a latched cancel (machine rule) | `StartAttempt` guard |

**Not modelled**, by decision or by abstraction:

- a read on each negative result;
- a lineage table;
- a delivery-count API;
- transport and the `invocationId` wire spelling (C3's spelling is a code obligation);
- the turn's own model events;
- liveness;
- more than one invocation;
- the batch order, member claims and recipient identity, which are assumed canonical (the batch is a set); `alt` text stands only for a digest mismatch.

## 3. Relation to SpecG

| SpecG (`Attempt(w, r)`) | This module |
|---|---|
| `w = "yes"` (own `sent: true`) | the accepted execution reached `Send` (`wit = "sent"`) |
| `w = "no"` | the accepted execution was guarded or refused before any include (`unsent`, `settled`) |
| `w = "unknown"` (throw, or no witness) | not needed here: a lost completion is a redelivery of the same attemptId, and possible exposure is the durable marker |
| `sent` is cumulative; completed only on `"yes"` | `osent`; `Inv_CompletedFromOwnOrigin` |
| `not_dispatched` only if no attempt sent | strengthened to physical truth: `Inv_NotDispatchedTruthful` (`phys = {}`), even when every accepted witness said not sent |

**Proof obligation for a later mapping:** a run of this module, projected to
one accepted witness per attempt, is a run of SpecG. A `refused:"exposed"`
result maps to SpecG's `"unknown"` (possibly sent, never completed). This
mapping is not checked here.

## 4. Properties

- **Invariants:** `TypeOK`, `Inv_NotDispatchedTruthful`, `Inv_ExposedImpliesMarker`, `Inv_CancelledStaysSettled` (C1), `Inv_CompletedFromOwnOrigin`, `Inv_NoSendAfterGuard` (C2), `Inv_OnlyOwnRetryAfterExposure`, `Inv_SentCanonical` (C3), `Inv_NoProtocolFault` (with `AllowAlt = FALSE`), `Inv_CoercionOnly`.
- **Action properties:** `Prop_MarkerInsertOnly`, `Prop_OutFinal`, `Prop_ProcFinal`, `Prop_CreqMonotone`.
- **Witnesses:** `Wit_GuardLateMarker` (causal since a1), `Wit_DuplicateSends`, `Wit_RefusedExposed`, `Wit_CancelAExposeBReplayA`, `Wit_LateCancelDuringEnd` (a1).
- **Also (a1):** `Inv_EndAnswerIsApplied`.

`Done` lets the model stutter whenever no end is pending. This keeps finite
bounds (no more attempts, deliveries or cancels) from reporting deadlock, so
deadlock checking only covers a pending end.

## 5. Proposed bounded run, after the request candidate batch (nothing executed)

Settings: 2 workers, 2 GiB, deadlock checking on, each case run once. A
timeout is INCONCLUSIVE.

| # | Step | Bounds (items / attempts / executions / alt) | Expected | Cap |
|---|---|---|---|---|
| 1 | SANY `RecipientExposureSpec` | — | valid | 30 s |
| 2 | `rxs-hd-redelivery` | {a} / 2 / 2 / no | PASS, complete | 300 s |
| 3 | `rxs-hd-cancel` | {a,b} / 2 / 1 / no | PASS, complete | 300 s |
| 4 | `rxs-df-no-coerce` | {a} / 1 / 2 | `Inv_NotDispatchedTruthful`, about 10 states (sequence below) | 120 s |
| 5 | `rxs-df-no-recheck` (C2) | {a} / 1 / 1 | `Inv_NoSendAfterGuard`, 6 states | 120 s |
| 6 | `rxs-df-sb-any` | {a} / 2 / 1 | `Inv_OnlyOwnRetryAfterExposure`, about 11 states | 120 s |
| 7 | `rxs-df-no-exclude` (C1) | {a,b} / 1 / 1 | `Inv_NoProtocolFault`, 6 states | 120 s |
| 8 | `rxs-df-replay-marker` (C1) | {a,b} / 1 / 1 | `Inv_CancelledStaysSettled`, 7 states | 120 s |
| 9 | `rxs-df-caller-hashes` (C3) | {a} / 1 / 1 / yes | `Inv_SentCanonical`, 5 states | 120 s |
| 10 | `rxs-df-origin-any` | {a} / 1 / 2 | `Inv_CompletedFromOwnOrigin`, about 9 states | 120 s |
| 11 | `rxs-df-send-unadmitted` | {a} / 1 / 1 | `Inv_ExposedImpliesMarker`, 4 states | 120 s |
| 12 | `rxs-wit-coerced` | {a} / 1 / 1 | witness reached, 8 states, causal (sequence below) | 120 s |
| 13 | `rxs-wit-duplicate-sends` | {a} / 1 / 2 | witness reached, 8 states | 120 s |
| 14 | `rxs-wit-refused-exposed` | {a} / 2 / 1 | witness reached, about 10 states | 120 s |
| 15 | `rxs-wit-cancel-a-expose-b` (C1 exact case) | {a,b} / 1 / 1 | witness reached, 8 states | 120 s |
| 16 | `rxs-wit-late-cancel-during-end` (a1) | {a} / 1 / 1 | witness reached, 11 states (sequence below) | 120 s |

Predicted sequences:

- **Step 4:** e1 sends; the duplicate e2 is guarded and is accepted unsent; the run is stopped; the end stays `not_dispatched`, uncoerced.
- **Step 12:** a guard fires while the admission call is in flight; that same transaction commits afterwards and inserts the marker; the result is accepted unsent; the end `not_dispatched` is coerced to `interrupted`; nothing was sent.
- **Step 16:** as step 12 up to Apply; then a cancel latches; the end commits `interrupted` and its answer is lost; the cancel is written and answers `exposed` (`cancel_requested` on the final row); the end replays `interrupted`.

**Config accounting:** 15 `rxs-*` configs (2 holds, 8 faults, 5 witnesses). Amendment a1 adds
`rxs-wit-late-cancel-during-end`; it changes `rxs-hd-redelivery`,
`rxs-hd-cancel` (`Inv_EndAnswerIsApplied` added) and `rxs-wit-coerced` (its
header).

## 6. Code obligations this model cannot discharge

These are for the implementation and a native proof:

- C2: wiring the real Stop and cancellation signal across the await;
- C3: the `invocationId` wire spelling, and SHA-256 over the exact composed text;
- one recorded attemptId in the scheduled input that survives native redelivery;
- the 0095 insert-only trigger;
- READ COMMITTED and the lock order;
- both duplicate-acceptance orders on real duroxide.

The code-derived variants and their mappings are named above.

## 7. Amendment a1 (parent review of 67ab1bbe)

| # | Review point | Change |
|---|---|---|
| 1 | `Wit_GuardLateMarker` checked only the final state, so admission before the guard also reached it | New ghosts, read by no action. `guardPend`: the executions whose guard fired while their admission call was in flight. `lateMarker`: that in-flight transaction committed afterwards and inserted the marker. The witness now needs this causal order. The predicted shape stays a diagnostic, not a proof |
| 2 | `UnsentAnswer` returned `final` before reading the marker, but plan 6 says an exposed cancel replays `exposed` after terminal processing | Order: the cancelled-unsent subset first (C1); then the marker (`exposed`, monotone `cancel_requested`, also on a final row, with no change to its processing); then `final`. The A-cancelled / B-exposed replay case is unchanged |
| 3 | `EndTxn` updated the store and the orchestration in one step, so a late cancel while the end was in flight and a lost applied-outcome answer were excluded | `EndCall(lost)`: the store transaction records the requested outcome (`endReq`, the call's identity) and the applied outcome. With a lost answer the orchestration stays `ending`; a latched cancel may be written in between (`cancelDuringEnd`); the replay checks the identity and returns the applied outcome (`oout`). New `Inv_EndAnswerIsApplied`, witness `Wit_LateCancelDuringEnd`. Bounded: one end call identity; the answer can be lost any number of times |
| 4 | `att.batch` is a set with no order, claims or recipient | Stated explicitly (module header, section 2): order, claims and recipient identity are assumed canonical and not validated by this model. `alt` stands only for a digest mismatch |

## 8. Correction r1 (a model-evaluation error)

The first execution of amendment a1 parsed (SANY valid), and its first TLC
case, `rxs-wit-coerced`, stopped with exit 75:

> Attempted to apply function ... to argument 0, which is not in the domain of the function

The error was at `StartExec`, line 166: `e = 1 \/ ex[k][e - 1].ph # "idle"`.
That run is INVALID evidence.

**Cause.** TLC explores each disjunct of an action-level `\/` as its own
branch and evaluates it without short-circuit. So `ex[k][0]` was evaluated
when `e = 1`.

**Fix.** `IF e = 1 THEN TRUE ELSE ex[k][e - 1].ph # "idle"`. It has the same
meaning. No other definition changed; the properties and configs are
byte-unchanged.

**Audit of the other partial accesses:**

- `ex[k][att[k].acc]` (in `AcceptedWit` and `Apply`) is reached only after the conjunct `att[nAtt].st = "acc"`. `Complete` sets `acc >= 1` in the same step as `st = "acc"`.
- `att[nAtt]` follows `nAtt > 0`.
- `att[k]` and `ex[k][e]` are total on `Atts × Execs`.
- The remaining action-level disjunction, in `Send`, is total.
- Every other `\/` is inside an expression (a primed boolean or an `IF` condition), not an action split.
