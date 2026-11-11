# Exposure code model: worker at c1bda7a2 (correspondence, assumptions, mismatches)

**Source:** `c1bda7a29af950fa84bb24f708cb81a12db11734` (tree `7cbd3a7c`),
store commit `e047e769`, base `a9956bc2`. The model is derived from
immutable Git source only.

**Model:** `RecipientExposureCode.tla`. It is derived from the source,
independently of the intent model `RecipientExposureSpec` (`85e0b815`,
unchanged). SpecG, the earlier models and all earlier results are
unchanged.

**Native crash proof:** c1bda7a2 has none. The redelivery behaviour is
therefore an assumption here (A-NATIVE), not a result.

## 1. Source → code model → intent model

| Source (c1bda7a2) | Code model | Intent (85e0b815) |
|---|---|---|
| `0095`: `workflow_intake_exposures`, PK invocation; a guard trigger raises on any UPDATE or DELETE | `marker` (attempt id), insert-only | `marker` |
| `exposeWorkflowIntake`: advisory invocation lock, member rows FOR UPDATE. Checks in order: recipient, claims and membership; cancelled-unsent members set aside; a named cancelled member or a non-bound active member → `settled`; then the exact ordered active batch and the stored text hash, else a broken invariant; then the exposure row: insert, same `attemptId`, or `sentBefore` → allowed, else `exposed` | `StoreAdmit`, `AdmitTxn` | `AdmitAnswer`, `AdmitTxn` |
| `admitWorkflowIntake`: SHA-256 of each exact item text; transient errors retried in place with the same request (a lost COMMIT is reconfirmed); deterministic errors are non-retryable; nothing sent without a positive answer | `AdmitTxn(lost)`, `Reissue`, the text value (`alt`), `Guard` (retries exhausted) | `AdmitTxn(lost)`, `Reissue` |
| `awaitIntakeAdmission`: race of the admission, the interrupt (Stop, abort, forced settle) and the guards (timeout, inactivity); recheck before send (Stop held or applied, interrupted, steer gate closed); `included()`; `send`. A late answer leads to no send | `Guard` from `await` or `answered`; `Deliver` (answer received, recheck, include or omit, send as one step) | `Guard` from `await` or `allowed`; `Send`; `Omit` |
| `withIntakeWitness`: `sent` if `included()` ran; `refused` with its reason; otherwise `sent: false` | `Complete` (`wit`) | `Complete` (`wit`) |
| `beforeAttempt`: one `newGuid` attempt id per carrying attempt; `sentBefore` = own retry (marker taken); assertion `sentBefore == sent` | `StartAttempt` (`k`, `sb`, `assertFail`) | `StartAttempt` (`sb`) |
| `applyIntakeAttempt`: refused `exposed` → sent, end `interrupted` (or `failed_indeterminate` after a failure); refused `settled` → invariant error; otherwise `attemptStep` | `Apply` | `Apply` |
| `latchCopies`: no latch on an unsent invocation that is ending | `Latch` | `Latch` (no such exclusion) |
| `invocationWrite`: cancel write before the end | `EndCall` requires `~inv.cw` | (implicit) |
| `cancelUnsentWorkflowIntake`: cancelled first → settled; exposure → `cancel_requested`, `exposed`; final row without exposure → broken invariant; bound → cancelled | `UnsentAnswer`, `CancelWrite`, `CancelReplay` | `UnsentAnswer` (a1 order), `CancelWrite`, `CancelReplay` |
| `applyIntakeInvocationCancelled(exposed)`: the exposed items stay, the others leave; the invocation is sent and ends `interrupted` | `CancelWrite` (`E ≠ {}`) | `CancelWrite` (`exposed`) |
| `endWorkflowIntake`: applied outcome computed first (`not_dispatched` → `interrupted` beside an exposure); the answer names `outcome` only when coerced; a replay compares with the applied outcome; an empty batch beside an exposure is corrupt | `EndCall(lost)` | `EndCall(lost)` |
| `applyIntakeEnded`: only `not_dispatched` → `interrupted` accepted; the invocation is cleared, or kept with `sent ||= coerced` when a cancel write was latched meanwhile | `EndCall` (`NoInv`, `oout`); the latched-meanwhile case goes through the lost-answer path (A-END) | `EndCall` (`oout`) |

## 2. Assumptions (stated, not checked)

| Id | Assumption |
|---|---|
| **A-MICRO** | Receiving the admission answer, the race resolution, the recheck, `included()` and the start of `send` run in one microtask chain, so no Stop, abort or timer can interleave. The code model therefore has no separate "allowed, not yet sent" state |
| **A-ACCEPT** | duroxide accepts the first completion of an activity; duplicates are discarded. Adoption of saved results, the W2-WIT4 `exposed` overlay and commit-CAS losers are not modelled |
| **A-END** | The end activity's commit and its answer are one step unless the answer is lost. A latch during an in-flight end is represented by the lost-answer path. Code: only for sent invocations (`end_after_cancel`) |
| **A-NATIVE** | Native redelivery reuses the scheduled input, so every execution of an attempt carries the same `attemptId`. **Not proven**: the native crash proof is pending |
| **A-LOCK** | Each store method is one atomic transaction under the invocation's advisory lock (READ COMMITTED; lock graph unchanged) |
| **A-GUARD** | Stop, abort (including activity cancellation reaching `abort()`), forced settle, the turn timeout, the inactivity watchdog and exhausted retries all end the run before its send |
| **A-RECOVERY** | An in-activity recovery re-run re-admits under the same `attemptId`. It is represented by duplicate executions |
| **A-ONE / A-BATCH** | One invocation. The batch is a set: the code's exact order, claim and recipient checks are not modelled (a mismatch is a broken invariant in code). `alt` text stands only for a digest mismatch |

## 3. Code versus intent: recorded before any check

| Id | Difference | Impact |
|---|---|---|
| M1 | The code has no waiting "allowed" state (A-MICRO). The intent lets a guard fire between "allowed" and the send | The code is stricter. `Inv_C_NoSendAfterRunEnded` targets late answers instead |
| M2 | The code latches nothing on an **unsent ending** invocation. The intent allows an unsent cancel during an end | The intent's unsent `Wit_LateCancelDuringEnd` path is **not code-reachable**. The code witness is `Wit_C_SentLateCancel` (a sent invocation) |
| M3 | `cancel_unsent` on a final row without exposure: the code raises a **broken invariant**; the intent answers `final` | Unreachable in code because of M2's latch rule. Control: `rxc-df-latch-unsent-ending` |
| M4 | A deterministic admission fault: the code gives a non-retryable turn error, and the invocation stays unsent (parked non-retryable). The intent sets the orchestration to `failed` | Both send nothing. The code model records `proto` and continues on the unsent path |
| M5 | A refused `exposed` after a failed event: the code ends `failed_indeterminate`; the intent `interrupted` | Outcome abstraction only |
| M6 | The cancel write is per invocation (all latched items); the intent writes per item | Granularity only |
| M7 | The code asserts `sentBefore == sent` | An extra code invariant (`Inv_C_SentBeforeIffSent`) |
| M8 | WIT4 overlay, adoption and CAS (A-ACCEPT) | Not modelled in either |

**Refinement to the intent is not checked in this batch.** The planned
mapping:

- `answered` + `allowed` → intent `allowed`; `answered` + `exposed`/`settled` → intent `refused`.
- `Deliver` → intent `Send` or `Omit`.
- `inv`/`ost` → intent `osent`/`ost`/`oend`/`ocanc`.

The expected gaps are M2 to M4 (code ⊂ intent behaviours, except M4's
orchestration effect) and M6 (granularity). A checked refinement is a
separate step if requested.

## 4. Cases of `RecipientExposureCode`

Only the stated causal shape counts. A timeout is PARTIAL, not PASS.

| # | Step | Bounds (items / attempts / executions) | Expected |
|---|---|---|---|
| 1 | SANY `RecipientExposureCode` | — | valid |
| 2 | `rxc-hd-redelivery` | {a} / 2 / 2 | PASS, complete (13 invariants, 4 action properties) |
| 3 | `rxc-hd-cancel` | {a,b} / 2 / 1 | PASS, complete |
| 4 | `rxc-df-no-coerce` | {a} / 1 / 2 | `Inv_C_NotDispatchedTruthful`, about 10 states |
| 5 | `rxc-df-no-recheck` | {a} / 1 / 1 | `Inv_C_NoSendAfterRunEnded`, 6 states |
| 6 | `rxc-df-latch-unsent-ending` | {a} / 1 / 1 | `Inv_C_NoStoreBroken`, 9 states (M3 dependency) |
| 7 | `rxc-wit-late-commit-coerced` | {a} / 1 / 1 | reached, 8 states |
| 8 | `rxc-wit-duplicate-sends` | {a} / 1 / 2 | reached, 8 states |
| 9 | `rxc-wit-refused-exposed` | {a} / 2 / 1 | reached, about 12 states |
| 10 | `rxc-wit-cancel-exposed` | {a} / 1 / 1 | reached, about 10 states |
| 11 | `rxc-wit-sent-late-cancel` | {a} / 1 / 1 | reached, about 10 states |

Config accounting: 10 `rxc-*` configs. The 15 `rxs-*` configs belong to the
intent model.

## 5. Not established

- The native 1.0.83/V5/PostgreSQL crash redelivery, both duplicate-acceptance orders, and A-NATIVE.
- The real Stop/cancel wiring beyond the source reading (A-GUARD), and A-MICRO under real I/O.
- The exact batch order, claim and recipient validation (A-BATCH).
- Liveness.
- SpecG refinement.
- Implementation qualification.

## 6. Addendum: pair findings W1–W3 at c1bda7a2 (model as written, not fixed)

Input: the code review of the exposure worker at c1bda7a2 (findings W1-W3). Sections 1–5 are kept
unchanged as the original derivation. `RecipientExposureCode.tla` is unchanged.

**Correction to the original mapping.** Two assumptions in section 2 do not
describe c1bda7a2 faithfully. The base model was too generous, so it could not
show W1–W3:

| Original | What c1bda7a2 actually does | Consequence for the base model |
|---|---|---|
| A-RECOVERY: a recovery run is a separate execution with its own witness | `intakeSent` and `intakeRefused` are activity-scoped. `intakeSent` is never reset and wins over a later refusal (`session-proxy.ts` 1654-1703, 4644-4765) | The base model's per-run witness hides W1 |
| A-GUARD: activity cancellation reaches `abort()` and ends the run before its send | The 2 s poll observes cancellation once, aborts the current session (or none) and stops. A recovery run gets a fresh `RunInterrupt`; admission and send do not consult `isCancelled()` (`managed-session.ts` 1523-1524, 4070-4084; `session-proxy.ts` 4113-4123, 4824) | A-GUARD is false for recovery runs and for an unpolled cancellation (W2) |
| One send per run (A-MICRO) | Required-tool and tool-call-as-text corrections send again. `runCorrection` checks `stopRequest` only and reopens the gate (`managed-session.ts` 4130-4188) | Corrective sends were not modelled (W3) |

New mismatches against the intent:

| Id | Finding | Recorded as |
|---|---|---|
| M9 (W1) | The accepted witness can say `sent` while the final run omitted after a `settled` refusal, so an ordinary completion is applied as an intake completion | `Inv_R_SettledRefusalNotHidden`, `Inv_R_CompletedFromFinalInclude`. They are reachable only under hypothesis **H-W1**: something settles a carried item while its attempt is carrying. The base model's drain-between-activities rule excludes H-W1, and no engine exclusion is established either way. Without H-W1, the same hiding is reachable for a **losing** duplicate (`Wit_R_LoserSettledHidden`); A-ACCEPT drops that completion |
| M10 (W2) | A send (include or omit) after activity cancellation: unpolled, observed with no active run, or in the recovery gap | `Inv_R_NoSendWhileCancelled`, `Inv_R_NoSendAfterObservedCancel`, `Inv_R_NoRecoverySendAfterGapPoll`. Reachable at c1bda7a2 |
| M11 (W3) | A corrective send after a bare abort that follows the initial send | `Inv_R_NoCorrectionAfterAbort`. Reachable at c1bda7a2 |

**Extension `MCExposureCodeC1Runs.tla`** (EXTENDS the unchanged base) adds the
following per execution:

- the activity-scoped `cum` (`intakeSent`) and `ref` (first `intakeRefused`);
- recovery runs (`SessionLoss`, `RecoverExec`, same attemptId, fresh interrupt, previous flags kept);
- native cancellation (`ActCancel`);
- the one-shot poll (`Poll`: ends an awaiting run, bare-aborts a run that has sent, retains nothing when there is no active run);
- one corrective send per run (`Correct`).

It restates `Complete` with the c1 witness priority (`cum`, then the first
refusal, then own). It wraps `Deliver` and `Apply` with ghosts only. `Apply`
gets one restriction: a run that ended before its send produces no model
result, so it is never applied as `completed`. H-W1 is `ExternalSettle`,
gated by `AllowConcurrentSettle`. Nothing in the extension is the proposed
correction.

W1–W3 are **source-backed findings at c1bda7a2**, not injected faults. Their
configs use `Fault = "none"`.

| # | Config | Bounds (att/exec/recovery; cancel; H-W1) | Expected |
|---|---|---|---|
| 12 | SANY `MCExposureCodeC1Runs` | — | valid |
| 13 | `rxr-c1-w2-unpolled-cancel-send` | 1/1/1; on; off | `Inv_R_NoSendWhileCancelled`, about 6 states |
| 14 | `rxr-c1-w2-observed-cancel-send` | 1/1/1; on; off | `Inv_R_NoSendAfterObservedCancel`, about 7 states (poll with no run, then a run sends) |
| 15 | `rxr-c1-w2-gap-recovery-send` | 1/1/1; on; off | `Inv_R_NoRecoverySendAfterGapPoll`, about 10 states (run 1 loses its session, poll in the gap, recovery sends) |
| 16 | `rxr-c1-w3-correction-after-abort` | 1/1/1; on; off | `Inv_R_NoCorrectionAfterAbort`, about 8 states |
| 17 | `rxr-c1-w1-settled-hidden` | 1/1/1; off; **on** | `Inv_R_SettledRefusalNotHidden`, about 11 states (conditional on H-W1) |
| 18 | `rxr-c1-w1-completion-without-final-include` | 1/1/1; off; **on** | `Inv_R_CompletedFromFinalInclude`, about 12 states (conditional on H-W1) |
| 19 | `rxr-c1-diag-w1-loser-settled-hidden` | 1/2/1; off; off | `Wit_R_LoserSettledHidden`, about 15 states (diagnostic) |
| 20 | `rxr-c1-wit-legit-correction` | 1/1/1; off; off | reached, about 6 states (positive control) |
| 21 | `rxr-c1-wit-recovered-include` | 1/1/1; off; off | reached, about 8 states (positive control) |
| 22 | `rxr-c1-hd-no-concurrent-settle` | 1/2/1; on; off | PASS, complete: 13 base invariants + TypeOK + the 2 W1 invariants + 4 action properties. Conditional on not-H-W1 and these bounds; **not a W1 exclusion** |

Only the stated causal shape counts, for example a gap-poll trace must show the poll between
the session loss and the recovery admission.

**Delta for a correction pin.** Re-derive the activity flags from the new
source; never mark them fixed here. Expected obligations: per-run own send
versus an activity-level possible-exposure flag; persistent cancellation
eligibility checked before each run and synchronously at each include, omit
and corrective send; and corrective sends guarded by the persistent abort
state. At that pin, configs 13–18 should become holds under the same bounds,
and 20–21 must stay reachable. H-W1 needs a source or engine disposition
either way.

## 7. Addendum: correspondence review of the first code model

The review of the first code model (e4343cce) found it to be **a partial
source abstraction of c1bda7a2, not a faithful model of it.** The claims below
replace the wording of sections 2–4 where they conflict.

### 7.1 Status of the base assumptions at c1bda7a2

| Id | Status at c1bda7a2 | Where it is now modelled |
|---|---|---|
| A-RECOVERY | **False.** A recovery run is not an independent execution. `intakeSent` and the first `intakeRefused` belong to the activity and survive every run, and `intakeSent` wins | `MCExposureCodeC1Runs` (3e933044): activity state `act[k][e]` is kept separate from the run state `ex[k][e]`, which `SessionLoss` resets. W1 is kept as a reviewed-code counterexample, conditional on H-W1, plus the losing-duplicate diagnostic |
| A-GUARD | **False** for recovery runs, for a cancellation not yet polled, and after the initial send. Native cancellation is not latched across runs | `MCExposureCodeC1Runs`: persistent `act.cancel`, its one-shot observation `Poll`, and the c1 corrective-send branch `Correct`. `runCorrection` checks only `stopRequest`; one correction per run is the bound. W2 and W3 are reachable. A Stop arriving after the send is not modelled (no false W3 credit) |
| A-END | **Not faithful.** The base joins the end's store commit and its answer, except by loss. Its replay check `req = endReq` is stricter than the store, which accepts any call whose coerced outcome equals the stored one: the original `not_dispatched` call and an `interrupted` call | `MCExposureCodeC1EndCancel` (below) |
| A-MICRO | **Narrowed.** The code has awaits and microtasks between the admission promise, the race and the caller. The base model also has `answered` → `Guard` before `Deliver`. Only the **final synchronous segment** (recheck of Stop/interrupt/gate → `included()` → start of `send`, `managed-session.ts` 4070-4092) is atomic | Unchanged |
| M1 | **Too strong as written.** The code is stricter than the intent only in that final segment: no guard can fire between the passing recheck and the send. Earlier in the answer chain a guard can fire, and the base model has that path (`answered` → `Guard`) | — |
| M6 | **The base claims are bounded to the atomic cancel-write abstraction.** In code each item is its own store transaction, settled in list order, and a duplicate execution's admission can run between items | `MCExposureCodeC1EndCancel`: `CancelItem` handles items one at a time, in any order, beside `AdmitTxn`. `Inv_E_NoMixedCancel` asks that an unsent write be all exposed or none exposed |

**Count correction for section 4.** Each base hold lists 14 INVARIANTS
entries: TypeOK and 13 substantive invariants, plus 4 action properties.

### 7.2 New mismatch

| Id | Difference | Impact |
|---|---|---|
| M12 | Base `EndCall` replay accepts only `req = endReq`. The store accepts a replay when `coerce(req)` equals the stored outcome, so after a coerced end both `not_dispatched` and `interrupted` are accepted. `applyIntakeEnded` then sets `settle := applied`, and an `end_after_cancel` remake asks for the applied outcome | Under the base rule this would be a false `storeBroken`. The extension uses the store rule and predicts the applied replay is **unreachable at c1** without a fault: it needs a latch on an unsent ending invocation, which `latchCopies` excludes. It is reachable under `latch_unsent_ending` |

### 7.3 `MCExposureCodeC1EndCancel.tla`

This module EXTENDS the unchanged base and replaces `EndCall` and
`CancelWrite`. Each step follows `store.ts` endWorkflowIntake,
cancelUnsentWorkflowIntake and requestCancelWorkflowIntake,
`intake-activities.ts` settle, and `intake-machine.ts` invocationWrite,
latchCopies, applyIntakeEnded and applyIntakeInvocationCancelled.

- `EndStore`: the end's store transaction: a commit, or a replay checked with the store rule. A commit records the named cancel flags. A replay is broken if it names an unrecorded cancel.
- `EndAnswer(lost)`: the answer, separate from the commit. `answeredEnd` checks the outcome. If a cancel was latched while the end was in flight, the result is `end_after_cancel` with `sent ||= coerced` and `settle := applied`, and the end is made again after the cancel write. Otherwise the invocation is cleared.
- `EndDup`: a delayed duplicate execution of any end call already made.
- `CancelCall`: snapshots every latched item. The kind is `requested` if the invocation is sent, `unsent` otherwise.
- `CancelItem`: one transaction per item, in any order. It may run while an end answer is in flight ("or was made since").
- `CancelAnswer(lost)`: `answeredCancel` checks the kind. Only the named items are acknowledged.

Orderings it still excludes, stated as limits rather than claimed:

- the bind write (the invocation starts bound);
- the delay between making an end call and its transaction (sound, because the transaction reads no orchestration state);
- retry timers and backoff (a failure after retries counts as a lost answer);
- duplicate executions of `request_cancel` (idempotent);
- the end's membership, claim and partial-batch checks (A-BATCH);
- more than one invocation (A-ONE);
- the `ended` flag of the answer.

| # | Config | Bounds (items/att/exec; fault) | Expected |
|---|---|---|---|
| 23 | SANY `MCExposureCodeC1EndCancel` | — | valid |
| 24 | `rxe-hd-two-items` | {a,b}/1/1; none | PASS, complete: 14 base invariants (13 + TypeOK), `Inv_E_NoMachineError`, `Inv_E_NoMixedCancel`, `Diag_E_AppliedReplay` (predicted unreachable), 4 action properties |
| 25 | `rxe-hd-two-items-dup` | {a,b}/1/2; none | PASS, complete, as 24 with a duplicate admission between per-item cancels (300 s; a timeout is INCONCLUSIVE) |
| 26 | `rxe-wit-end-after-cancel` | {a}/1/1 | reached, about 15 states |
| 27 | `rxe-wit-cancel-during-end` | {a}/1/1 | reached, about 13 states |
| 28 | `rxe-wit-coerced-replay` | {a}/1/1 | reached, about 10 states (original `not_dispatched` replay answered coerced) |
| 29 | `rxe-diag-applied-replay-latch-fault` | {a}/1/1; `latch_unsent_ending` | `Diag_E_AppliedReplay` reached, about 15 states |

Caps: 300 s for 24 and 25, 60 s for the others.

### 7.4 Refinement is required work

The section 3 text "a checked refinement is a separate step if requested" is
withdrawn. A checked spec/code correspondence is a standing requirement.
The required sequence:

1. Run the c1 extensions.
2. Build a refinement module that maps the c1 code state (base + C1Runs + C1EndCancel) to `RecipientExposureSpec` variables, with the mapping in section 3.
3. Check the intent's safety invariants on the mapped state, and the intent's `Next` as an action property under that mapping. Each expected gap (M2–M4, M6, M9–M12) must be either an explicit, named exclusion or a counterexample. It must never be silently allowed.
4. Repeat steps 1–3 on the corrected code (1e240b0f). That pin needs its own code-model delta; the c1 findings stay as c1 counterexamples.

Native crash/redelivery proof is absent from c1bda7a2 (A-NATIVE).

## 8. H-W1 disposition (2026-11-02)

**H-W1 is false for an accepted execution.** The implementation's author
answered (a) No, with citations, and the key lines were checked at c1bda7a2. The same files are
unchanged at 1e240b0f.

Only two store writes move a row out of `bound`: the end (`store.ts` 4024) and
cancel_unsent (`store.ts` 4089). Neither can run while an attempt is carrying,
for these reasons:

- The orchestration schedules them only from the wake. The wake's sole caller
  is drain's race (`queue.ts` 780).
- The carrying attempt is a plain blocking `yield turnTask` (`turn.ts` 593),
  so the wake cannot run until the attempt is applied.
- `beforeAttempt` throws if an attempt starts before the previous one is
  applied (`intake-wiring.ts` 530-532).
- `carryIntakeInvocation` never carries an unsent batch that has a latched
  cancel (`intake-machine.ts` 850).
- Duroxide commits orchestration actions only on an acknowledged turn.

Consequences, with every earlier config and prediction kept:

| Item | Classification now |
|---|---|
| `AllowConcurrentSettle` | `FALSE` is the source-faithful setting. `TRUE` is a hypothetical robustness setting only |
| `rxr-c1-w1-settled-hidden`, `rxr-c1-w1-completion-without-final-include` (H-W1 on) | Hypothetical. They describe a path the source excludes, so they are **not** reachable defects of an accepted execution at c1bda7a2 |
| `rxr-c1-diag-w1-loser-settled-hidden` (H-W1 off, MaxExec 2) | The source-faithful W1 shape at c1bda7a2: a losing duplicate (a separate execution that is not accepted, under A-ACCEPT) recovers after the winner ended the invocation, is refused `settled`, and still reports `sent`. That result is never accepted, but its witness is wrong |
| `rxr-c1-hd-no-concurrent-settle` | The source-faithful check that no accepted completion hides a settled refusal or completes without its final run's include (predicted PASS) |
| W1 at c1bda7a2 | A real defect in the witness contract: it is wrong for losing duplicates, and the fake test asserts it. It is **not** an accepted-completion defect. W2 and W3 are unaffected and stay reachable |

## 9. Correction to section 7.3 (made before the first execution)

Section 7.3 said a cancel write may run while an end answer is in flight.
That is wrong for this code: every orchestration store write is a
**blocking yield** of the wake (`intake-wiring.ts` `intakeWrite` 187-200,
`wakeOnce` 400-418; unchanged at 1e240b0f). While a write is in flight, the
orchestration takes no other step.

`MCExposureCodeC1EndCancel` now guards these steps with `OrchFree` (no end or
cancel write in flight): `StartAttempt`, `Latch`, `CancelCall` and
`EndStore`. Worker executions and duplicate store executions still interleave.

Consequences:

- A latch "while the end was in flight" needs a lost (failed) end answer first.
  `end_after_cancel` is a defensive branch: `rxe-wit-end-after-cancel` is now an
  unreachability check, predicted to complete without a violation.
- `cancelDuringEnd` now means the intent's notion: a cancel transaction after
  the end committed and before the invocation was cleared.
  `rxe-wit-cancel-during-end` reaches it through a lost end answer (about 15
  states).
- The applied-replay diagnostic under the latch fault goes through a lost end
  answer (about 14 states).

The earlier predictions for these three configs were withdrawn before any run.
