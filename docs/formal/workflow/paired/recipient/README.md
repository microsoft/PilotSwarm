# Recipient intake models: cancellation, settlement, turn binding and exposure

This folder holds the TLA+ models of the durable recipient intake of Workflow
(design `docs/proposals/workflow-durable-intake.md`). The request models
one folder up and in `../request/` are separate. A TLC pass is a bounded
check, not a proof.

## 1. What the models cover

| Group (case prefix) | Modules | Models | Notes |
|---|---|---|---|
| Intake machine (`ris-`, `ric-`) | `RecipientIntakeSpec` (intent), `RecipientIntakeCode` (code at `66739e07`) | Latched cancellation, lost acknowledgements, tombstone eviction and consumption, the store-only wake, the identity of a cancel (sections 3 to 7) | this README |
| Cancel order (`rco-`) | `RecipientCancelOrderSpec`, `RecipientCancelOrderB92`, `RecipientCancelOrder22A` | The latch must come before a tombstone is evicted or consumed: the obligation, the cancel branches at `b92ff04b` (negative control) and at `22a66ef7` | `CANCEL-ORDER.md` |
| Turn binding (`rts-`, `rts2-`, `rtg-`, `rtc-`, `rtcg-`) | `RecipientTurnSpec`, `RecipientTurnSpecR2`, `RecipientTurnSpecG`, `RecipientTurnCode`, `RecipientTurnCodeG`, `MCRecipientTurnWitness`, `MCRecipientTurnGWitness` | Which turns carry the intake invocation (W2): retry marker, interposed turns, the gate row; the code at `5df032f1` and its refinement | `W2-TURN-BINDING.md`, `W2-WITNESS-AMENDMENT.md`, `W2-CODE-REFINEMENT-5DF032F1.md`, `W2-GATE-AMENDMENT.md` |
| Exposure, intent (`rxs-`) | `RecipientExposureSpec` | The durable pre-send exposure protocol: marker, admission, end and cancel, the accepted result's origin | `EXPOSURE-SPEC.md` |
| Exposure, code at `c1bda7a2` (`rxc-`, `rxr-`, `rxe-`) | `RecipientExposureCode`, `MCExposureCodeC1Runs`, `MCExposureCodeC1EndCancel` | The worker as written, with the review findings W1 to W3 | `EXPOSURE-CODE-C1BDA7A2.md` |
| Exposure, code at `1e240b0f` (`rxr2-`, `rxc2-`, `rxf-`) | `MCExposureCode1e24Runs`, `MCExposureCode1e24Composed`, `MCExposureCodeRefines1e24` | The repaired worker, the composition and the code-to-intent refinement | `EXPOSURE-CODE-1E240B0F.md` |

## 2. The code these models are bound to

| Group | Code | Pin |
|---|---|---|
| Intake machine | `packages/sdk/src/orchestration_1_0_83/intake-machine.ts`, `intake-state.ts`; `packages/sdk/src/workflow/intake-activities.ts`, `intake.ts`, `store.ts` (`claimWorkflowIntake` 3610, `bindWorkflowIntake` 3686, `endWorkflowIntake` 3756, `cancelHeldWorkflowIntake` 3819, `cancelUnsentWorkflowIntake` 3843, `requestCancelWorkflowIntake` 3873) | `66739e07` (design blob `b8e927f4`) |
| Cancel order | `orchestration_1_0_83/queue.ts` (drain and sweep, `latchIntakeTombstones`), `intake-wiring.ts` | `b92ff04b`, corrected at `22a66ef7` |
| Turn binding | `orchestration_1_0_83/intake-machine.ts` (`carryIntakeInvocation`, `intakeOwnTurnStimulus`, `applyIntakeAttempt`), `intake-wiring.ts` (`beforeAttempt`, `noteAttempt`, `ownTurn`), `queue.ts` (`decide`), `turn.ts` | `5df032f1`; the orchestration files are byte-identical at `009109e2` |
| Exposure | `packages/sdk/src/session-proxy.ts` (admission, witness, runs), `managed-session.ts`, `workflow/store.ts` (`exposeWorkflowIntake`, `endWorkflowIntake`, `cancelUnsentWorkflowIntake`), migration `0095` | `c1bda7a2`; repaired at `1e240b0f` (`49ad1394` has the same SDK runtime source) |

Line numbers refer to the pinned commits (`git show <commit>:<path>`), not to
the current head. The intake is not yet wired into the product at `66739e07`:
nothing calls the machine, so a violation that needs `Wiring = "concurrent"`
or `LatchFirst = FALSE` is about a hypothetical caller, not a shipped defect.

## 3. Scope of the intake-machine models

In scope:

- latched cancellation;
- transient failure and lost acknowledgement of each store write;
- the four places a copy can be: unclaimed, held, bound-unsent, and
  sent-ending;
- bounded tombstone eviction and consumption;
- the store-only due retry (the wake), which never starts a turn or unparks;
- the identity of a cancel: exchange and canonical client id together.

Bounds:

- 2 genuine exchanges (`e1`, `e2`). The genuine copy of each has its own
  canonical id.
- 1 forged, shape-valid copy that names exchange `e1` and yields client
  id `e2` (the trace of INTAKE-CANCEL-05).
- 1 invocation.
- 1 tombstone slot (`TombCap = 1`), which forces eviction.

Out of scope:

- capacity and size refusals (the caps are never reached);
- duplicates of genuine copies;
- the sender;
- KV;
- continue-as-new (carried state is the model's variables);
- session end;
- the hydration, exhausted and credential rows of the attempt table;
- retry due times (the wake may make any due write at any time).

## 4. Intent model `RecipientIntakeSpec.tla`

| Design | Model |
|---|---|
| 5.2 claim rows, 5.3 arrival | `Arrive`, `ClaimOk` (accepted; a latched or tombstoned copy becomes `settling`), `ClaimNoAck` (failed or lost answer: `unclaimed`) |
| 5.5 "Latched cancels" | `LatchBy(c, g, f)`: a tombstone latches the copies it names. The latch is never undone; `owed` records the store write each latch requires. |
| 5.2 cancel rows; 5.4 the wake | `CancelWrites(S, C, ack)`: item-by-item commits, idempotent, acknowledged only when all of `S` committed |
| 5.5 binding, carrying, the transition table | `Form`, `BindWrite`, `Attempt(w, r)` |
| 5.5 end | `EndWrite`, made only after a latched sent item's `cancel_requested` |
| Section 3, 5.5 identity | the forged copy: `ArriveForged`, `ForgedClaim` (unverified, retired), its own latch `flatch` |

| Property | Meaning |
|---|---|
| `Inv_LatchOwnId` | A cancel latches only the copy whose own client id it names. |
| `Inv_StoreCancelLatched` | The store records a cancel only for a latched copy. |
| `Inv_DoneLatchedRecorded` | A latched copy leaves the carried state only after its cancel is recorded. |
| `Inv_NoCarryAfterUnsentLatch` | No attempt carries a copy latched before it was sent. |
| `Inv_TruthfulNotDispatched` | I9: `not_dispatched` only for a copy that was never sent. |
| `Prop_LatchStable` | The decision stands across eviction, consumption, failure and a lost answer. |
| `Prop_EndAfterCancelRequested` | The end commits only after each latched sent item's `cancel_requested`. |
| `Prop_WakeStoreOnly` | I11: wake steps change no carried, sent or parked state. |
| `Prop_StoreFinal` | I1: final store states stay final. |
| `Live_LatchRecorded` | A latched cancel is recorded with store fairness only: no turn, no stimulus, no arrival. |

## 5. Code model `RecipientIntakeCode.tla`

The model follows the machine's pure functions. The future wiring appears as
constants, so the pure machine stays separate from assumptions about callers:

- `Wiring = "serialized"`: each write's call and its answer are one step.
- `Wiring = "concurrent"`: a hypothetical caller latches while the
  invocation's cancel write or its end is in flight.
- `LatchFirst`: decide calls `latchIntakeCancels` before it forms or carries.

Nothing calls the machine at 66739e07. A violation that needs
`Wiring = "concurrent"` or `LatchFirst = FALSE` is therefore about an unwired,
hypothetical caller. It is not a shipped defect.

| Code | Model action | Spec step |
|---|---|---|
| `applyIntakeClaim`, accepted (442-495) | `ClaimOk` | `ClaimOk` |
| `applyIntakeClaim`, failed: `keepUnclaimed` (398-412) | `ClaimNoAnswer` (latches when a tombstone names it now) | `ClaimNoAck` |
| unverified or conflict answer: retire, and `passOn` by exchange and id (455-456) | `ForgedClaim` | `ForgedClaim` |
| `latchIntakeCancels` / `latchCopies` (526-563) | `LatchCancels` | `LatchBy` (one tombstone at a time) |
| holder settle; `applyIntakeHolderSettle` (497-524) | `HolderSettle` | `CancelWrites({e}, ...)` |
| `cancel_held` list; `applyIntakeHeldCancelled` (658-662), which acknowledges the named items | `HeldCancel` | `CancelWrites(S, C, ack)` |
| `formIntakeInvocation` (687-704) | `Form` | `Form` |
| bind; `applyIntakeBound` (726-754) | `Bind` | `BindWrite` |
| `carryIntakeInvocation` + `applyIntakeAttempt` (812-961) | `Attempt` (one step: the orchestration awaits the turn) | `Attempt` |
| `intakeInvocationCancelCall` / `applyIntakeInvocationCancelled` (1028-1057); store `cancel_unsent`, `request_cancel` | `InvCancel` (serialized); `InvCancelCall` then `InvCancelAnswer` (concurrent) | `CancelWrites`; the call is a stutter |
| `intakeEndCall` / `applyIntakeEnded` (979-1002); store `endWorkflowIntake` | `EndWrite` (serialized); `EndCall`, `EndAnswer`, `EndAnswerThrows` (concurrent) | `EndWrite`; an empty end and `EndCall` are stutters. `EndAnswerThrows` (concurrent only) commits the store's end while a cancel is owed: it has no intent step and is a non-refining step of the hypothetical caller. The throw itself has no intent image. |

Mapping: `RecipientIntakeCode` `A == INSTANCE RecipientIntakeSpec`.

- The location maps from `q`.
- `latch` is the ghost `glatch`.
- `owed` maps as follows: a latched held entry and a settling entry owe
  `cancel`; an invocation item in `pend` owes `nd` when unsent and `creq`
  when sent.
- `inv` maps to `NoInv` when the code's invocation is absent or empty.
- The store and the ghosts map one to one.
- `Refines == A!Spec`. `Inv_Mapped` checks the intent invariants on the
  mapped state.

`pend` is a ghost for "latched and not yet answered by a cancel write". It
follows the machine: an answer clears every item latched now.

**Invocation bound.** The model has one ACTIVE invocation slot, and it keeps
the session's real sequential behavior. After an invocation ends, a later
`Form` starts the next one. In the source that is a new invocation id
(`ctx.newGuid`) with its own store membership. The model's store membership
`bm` is the active invocation's: `Form` resets it to empty, and the first
`Bind` of that invocation writes it. A lost-answer replay keeps it. The
store's per-invocation checks (end names every non-cancelled member, cancels
name members) read only the active invocation's membership. Earlier ended
invocations stay in the store rows (`row`, `proc`, `creq` per exchange) and
are never checked again. With 2 exchanges, at most two invocations happen in
sequence, and at most one is active at a time.

**Declared abstractions, not equivalences.** Under `Wiring = "serialized"`
a write's call and its answer are one model step. This is a declared
abstraction of the future caller, not the literal activity: the model
includes item-by-item partial commits (`C` a part of the list) and commits
with no answer (lost answer), but no blanket behavioral equivalence with the
runtime is claimed. The intent model's revisions r2 and r3 keep every
property, invariant and fairness formula, but they change actions. They do
not prove that r1 and r3 are semantically equivalent; r3 is the intent model
that the mapping targets.

## 6. Findings and where the models address them

| Finding | Status | Model |
|---|---|---|
| INTAKE-MACHINE-01, loss of the cancel decision during a failed settlement | addressed in source, per the review | `Prop_LatchStable`, `Inv_DoneLatchedRecorded`, `Live_LatchRecorded`; fault `ris-df-drop-latch`; code `Refines` |
| INTAKE-MACHINE-02, no idle retry for held or unsent cancels | addressed in source | `Live_LatchRecorded` with store fairness only (`ris-hd-liveness`, `ric-hd-liveness`) |
| INTAKE-MACHINE-03, sent cancel discarded during a pending end | addressed in source | `Prop_EndAfterCancelRequested`; fault `ris-df-end-before-creq`; code `EndWrite` waits for `~cw` |
| INTAKE-CANCEL-04, size | withdrawn (a 100-byte miscalculation, not a real defect for normal ids) | not modeled; sizes are out of scope |
| INTAKE-CANCEL-05, propagation by exchange alone | closed at 66739e07 (exchange and canonical id) | `Inv_LatchOwnId`; fault `ris-df-exchange-only`; the forged copy in both models; code `Refines` |
| Wiring: the cancel answer clears every item latched now | open obligation for the future caller | `ric-as-concurrent-refines`, `ric-as-concurrent-done` |
| Wiring: the end answer is refused while a cancel is pending | open obligation (the caller must reconcile) | `ric-as-concurrent-end` |
| Wiring: latch before form and carry | open obligation | `ric-as-no-latch-first` |

## 7. Correspondence limits

1. The model checks the pure machine and abstract store transactions as read
   at 66739e07. Nothing executes TypeScript or PostgreSQL. The wiring does
   not exist yet.
2. The store transactions are atomic per item. A list write commits item by
   item, as `runWorkflowIntakeSettle` does. Store refusals that the code throws
   on (`intakeBroken`) set `broken`.
3. A turn's carry and its result are one step, because the orchestration
   awaits the turn.
4. Under `Wiring = "serialized"` a call and its answer are one step.
5. `TombCap = 1` is needed for the mapping. With two live tombstones, one
   `latchCopies` step can latch two ids, which is two spec steps.
6. Time and retry backoff are abstracted, and so are all byte caps.
7. Liveness assumes the store eventually answers every due write (A-STORE).
8. One active invocation slot: sequential invocations are distinct ids. The
   store membership checks apply to the active one only (see "Invocation
   bound").


## 8. Case taxonomy and expected results

Case ids are `<prefix>-<kind>-<name>`. Kinds: `hd` (expected to hold), `df`
(deliberate fault), `as` (an assumption about the caller removed), `wit`
(witness: expected violation that proves reachability), `diag` (diagnostic),
`ref` (refinement). `cases.tsv` lists all 113 cases with their entry module;
`cases.json` has the expected result of each case from its settings file.

| Prefix | Cases | Expected |
|---|---|---|
| `ris-` (13) | `hd-safety`, `hd-liveness`: PASS; `df-drop-latch`, `-exchange-only`, `-end-before-creq`, `-wake-unpark`, `-carry-latched`: the named property violated; 6 witnesses | PASS / violated / reachable |
| `ric-` (10) | `hd-refines`, `hd-liveness`: PASS (serialized wiring, `LatchFirst`); `as-concurrent-refines`, `-concurrent-done`, `-concurrent-end`, `-no-latch-first`: violated (hypothetical caller); 4 witnesses | PASS / violated / reachable |
| `rco-` (12) | PASS: `spec-hd-safety`, `spec-hd-liveness`, `22a-all-env`, `22a-consume`, `22a-big`; `Inv_NoCancelLost` violated: `spec-as-unguarded`, `b92-consume`, `b92-big` (the b92 cases are the negative control); witnesses: `spec-wit-drop-after-latch`, `b92-wit-latched`, `22a-wit-latched`, `22a-wit-latched-then-consumed` | PASS / violated / reachable |
| `rts-`, `rts2-` (11) | `rts-hd-safety`, `rts2-hd-safety`: PASS; `rts-df-marker-any`, `-own-parked`, `-carry-latched`: violated; `rts-wit2-*`: reachable; 3 superseded `rts-wit-*` | PASS / violated / reachable |
| `rtc-`, `rtcg-` (8) | `rtc-hd-code-safety`, `rtc-refines-nogate`, `rtc-design-refines`, `rtcg-refines-reval`, `rtcg-refines-timer`: PASS; `rtc-refines-gate`, `rtc-design-strand`, `rtc-df-marker-any`: violated (the design rule strands; the original gate row) | PASS / violated |
| `rtg-` (4) | `timer-safety`, `reval-safety`: PASS; `timer-strand`, `wit-other-turn`: violated | PASS / violated |
| `rxs-` (15) | `hd-cancel`, `hd-redelivery`: PASS; 8 faults; 5 witnesses | PASS / violated / reachable |
| `rxc-` (10) | `RecipientExposureCode` (first code model): 2 holds, 3 faults, 5 witnesses | see section 9 |
| `rxr-`, `rxe-` (16) | c1bda7a2: `rxr-c1-w2-*`, `-w3-*`, `-diag-w1-loser-settled-hidden`: the findings W1 to W3 reached (violated); `rxr-c1-hd-no-concurrent-settle`, `rxe-hd-*`: PASS; `rxr-c1-w1-*`: hypothetical (H-W1); witnesses | PASS / violated / reachable |
| `rxr2-`, `rxc2-` (10) | 1e240b0f: `hd-w2w3`, `hd-dup`, `rxc2-hd-composed-a`, `-ab`: PASS; witnesses; `diag-w1-settled-visible`, `hd-w1-hw1`: hypothetical (H-W1) | PASS / reachable |
| `rxf-` (4) | `ref-strict-a`: violated at a named gap; `ref-gapped-*`: PASS | refinement |

## 9. Results

Recorded runs (TLC 2.19, `-workers 2`, `-Xmx2g`, deadlock check on, each case
run once). Dates are 2026-11-01 to 2026-11-02. Model commits: `4683dec0`
(intake machine), `06e5f073` to `4a480ace` (cancel order), `42816034` (turn
spec), `567aeacc` (W2 code model), `cd826245` (gate row), `85e0b815`
(exposure spec), `949128a1` (exposure code correspondence).

| Group | Cases run | PASS | Expected violations | VOID | Not run |
|---|---|---|---|---|---|
| Intake machine (`ris-`, `ric-`) | 5 | 2 (`ris-hd-safety`, `ric-hd-refines`) | 3 (`ris-df-exchange-only`, `ris-df-drop-latch`, `ric-as-concurrent-done`) | 0 | 18 |
| Cancel order (`rco-`) | 7 | 2 (`rco-spec-hd-safety`, `rco-22a-all-env`) | 5 (`rco-spec-as-unguarded`, `rco-b92-consume`, `rco-b92-big`, `rco-b92-wit-latched`, `rco-22a-wit-latched-then-consumed`) | 0 (the first run of `rco-b92-consume` stopped on a model evaluation error; it was fixed and rerun) | 5 |
| Turn binding (`rts-`, `rts2-`, `rtg-`, `rtc-`, `rtcg-`) | 20 | 9 | 11 | 0 | 3 (superseded `rts-wit-*`) |
| Exposure intent (`rxs-`) | 15 | 2 | 13 | 0 | 0 |
| Exposure code (`rxr-`, `rxr2-`, `rxe-`, `rxc2-`, `rxf-`) | 23 | 8 (incl. `rxe-wit-end-after-cancel`, a bounded unreachability check that completes without a violation) | 14 | 1 (`rxf-ref-strict-a`: a model error, evaluation order in `GenH`, exit 75) | 17 (`rxc-*` 10, `rxf-ref-gapped-*` 3, 4 hypothetical H-W1 cases) |
| **Total** | **70 of 113** | **23** | **46** | **1** | **43** |

PARTIAL (timeout): none recorded. Every recorded violation was caught by its
named property; where TLC returned another shortest path than the one
predicted (`rts-df-own-parked`, `rco-b92-consume`, `rco-22a-wit-latched-then-consumed`),
the path was checked against the source and the violation was correct.

What the recorded results show:

- `ris-hd-safety` (118,797 distinct states) and `ric-hd-refines` (113,451)
  pass at the stated bounds, with `Wiring = "serialized"`, `LatchFirst = TRUE`
  and the declared abstractions. No liveness claim: `ris-hd-liveness` and
  `ric-hd-liveness` were not run.
- The concurrent-caller case shows the wiring obligation: a cancel answer that
  clears every item latched now loses a cancel latched during the call.
- The cancel-order results show a cancel can be lost when a tombstone is
  consumed before it is latched (`b92ff04b`); the corrected branch at `22a66ef7`
  keeps `Inv_NoCancelLost` with all three environment assumptions on (E-ID,
  E-BIG, E-WIN) at 2 exchanges and 1 forged copy.
- At `5df032f1`, the original gate row (a gate-parked invocation is carried
  only by the gate's own retry) can strand the invocation when another turn
  ends the gate's wait; the accepted row ("revalidated": any otherwise eligible
  attempt may carry it after revalidating the gates) keeps the turn invariants
  (`rtg-reval-safety`, `rtcg-refines-reval`).
- At `c1bda7a2`, W2 (a send after an observed or unpolled cancellation, in
  three forms) and W3 (a corrective send after an abort) are reachable; at
  `1e240b0f` their holds pass (`rxr2-hd-w2w3`, `rxr2-hd-dup`) and the composition
  passes (`rxc2-hd-composed-a`, `-ab`). W1 is a defect of the witness contract
  for a losing duplicate only (`rxr-c1-diag-w1-loser-settled-hidden`); it is
  false for an accepted execution (`EXPOSURE-CODE-C1BDA7A2.md`, section 8).
- The code-to-intent refinement of the exposure protocol (`rxf-`) has no valid
  result yet.

Limits: finite bounds as stated in each note; the assumptions A-ATOMIC,
A-SCHED, A-RETRY, A-GATE, A-ONE, A-WITNESS, A-NATIVE and A-CANCEL-READ are
model assumptions, not source proofs; there is no TypeScript, native or
activation result, and no liveness proof outside `ris-hd-liveness` and
`ric-hd-liveness` (not run).

## 10. How to run

Java 17 or later is required.

```sh
TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh
TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]
```

`run-tlc.sh` pins `tla2tools.jar` v1.7.4 by SHA-256, runs SANY on every module
named in `cases.tsv`, then TLC on every case (`-workers 2 -Xmx2g`, a limit of
`TLC_CASE_SECONDS` per case, default 300 s). Read `<out>/executions.tsv` and
each case's `tlc.log`. Exit code 0 means no violation in the bounded search,
12 a safety violation, 13 a liveness violation, 124 a timeout (PARTIAL, never
PASS); other codes are setup or model errors. Every settings file states
`CHECK_DEADLOCK TRUE`: deadlock checking was on in all recorded runs. Some
module comments name notes that are not in this folder (they were review
notes); comments of a few modules were edited to remove internal references,
and no definition changed. `SHA256SUMS` pins every file named above. The settings files are generated from `cases.json` and
`tlc-templates.json` (`../../../tlc_cases.py`) and are not committed.
