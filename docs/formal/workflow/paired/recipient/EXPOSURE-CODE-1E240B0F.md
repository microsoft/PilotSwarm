# Exposure code model: repaired worker at 1e240b0f (correspondence)

Source: `1e240b0f0c912fbad0c7fe60f0bfd9cf076aa656`, tree
`9ff6cef4f09ac46798239fad763d6807f30a4086`. It contains three commits on top
of c1bda7a2:

- `e966b418`: native crash-redelivery tests (see section 7).
- `50291121`: definite assignment of the admission answer variable.
- `1e240b0f`: the W1–W3 fixes.

The model is derived from the diff `c1bda7a2..1e240b0f` of the immutable
source only. The review's proposed fixes are not used as a model. Results are
in `README.md`.

Kept unchanged:

- `RecipientExposureCode.tla` (e4343cce, a partial abstraction);
- the defective c1 companion `MCExposureCodeC1Runs.tla` (3e933044) with its
  W1–W3 counterexample configs;
- `MCExposureCodeC1EndCancel.tla` (767083a4);
- the intent model and every earlier result.

## 1. What changed at 1e240b0f, and where it is modelled

| Source (1e240b0f) | Change | `MCExposureCode1e24Runs` |
|---|---|---|
| `session-proxy.ts` 1676-1689 `intakeIncludedAny`, `intakeRun`, `withIntakeWitness` | W1: each run keeps its own evidence. The witness is the latest run's own result: `sent` only if that run included the items; otherwise that run's refusal; otherwise `sent:false, exposed:true` if an earlier run included them; otherwise not sent | `act.any`, `act.runInc`, `act.runRef`, reset at each run start; `CompleteR` |
| `session-proxy.ts` 1695-1716 `intakeAdmissionFor(…, run, eligible)` | `admit` reads `eligible()` before the store (a retryable error if not eligible). A refusal sets `run.refused`. `included()` sets `run.included` and `intakeIncludedAny` | `StartExecR`/`StartBlocked` (eligibility at run start); `AdmitTxnR`; `DeliverR` |
| `session-proxy.ts` 4646-4657 | A new run object is made before the run starts. `eligible()` reads `activityCtx.isCancelled()` and latches the activity-level `cancelled`. A cancelled activity starts no run and returns `INTAKE_ENDED_BEFORE_SEND_MESSAGE` | `StartBlocked`, `act.latched` |
| `session-proxy.ts` 4129-4130 (poll, unchanged) | The poll also latches `cancelled` | `Poll` sets `latched` |
| `managed-session.ts` 4088 | W2: the final synchronous recheck also refuses when `eligible()` is false, for an include and an omit alike | `DeliverR` requires eligibility; `DeliverBlocked` ends the run with nothing sent |
| `managed-session.ts` 4031 | W3: `runCorrection` sends nothing when the run was aborted (`runInterrupt.reason`) or the activity is not eligible | `Correct` requires `~aborted` and eligibility |
| `managed-session.ts` 1530-1531, 1610 | Steers need eligibility | **Not modelled** (steers were not in the c1 model either) |
| `intake-machine.ts` 874-883 (comment only), 985-1015 | `applyIntakeAttempt` is unchanged. An `exposed` witness counts as possibly sent, and `completed` needs the run's own `sent` | `ApplyX` (base `Apply` plus the exposed-not-refused branch) |
| `types.ts`, `intake-admission.ts` | Documentation, the moved message constant, `raw = undefined` | No behaviour change |

The store, migration and orchestration logic are unchanged from c1bda7a2.
Therefore `RecipientExposureCode`'s store and machine actions, and
`MCExposureCodeC1EndCancel` with its section 7 dispositions, apply unchanged
at 1e240b0f. Those dispositions are:

- the end commit and its answer as separate steps;
- the store's replay rule `coerce(req) = out`, which accepts the original
  and the applied replay;
- `end_after_cancel`;
- per-item cancel transactions in both orders beside admissions (M6);
- the stated excluded orderings;
- A-MICRO narrowed to the synchronous recheck → `included()` → start of
  `send` segment. At 1e240b0f that segment also contains the eligibility read
  (`managed-session.ts` 4088-4100).

## 2. Assumptions and uncertainties carried forward

| Id | Statement |
|---|---|
| A-CANCEL-READ | `activityCtx.isCancelled()` is the activity's native cancellation flag at the moment of the read. The delay before an orchestration-side cancellation reaches the worker is outside the model: the model's `cancel` *is* that flag. Under this assumption the W2 invariants hold **by the modelled guard**. Their check value is the regression against the c1 companion and their interaction with recovery, the poll and duplicates. The real obligation is the source correspondence above |
| A-ADMIT-START | `admit`'s eligibility read before the store is represented by the run-start read. A cancellation between run start and the store call can still commit the marker in the model; the code would throw before the store. This is conservative (extra possible exposure, no extra send) |
| A-LATE-REFUSAL | The store returns its answer whatever the abort signal, so `run.refused` can be set after the run ended, if that happens before the witness is taken (`AdmitTxnR`). The c1 companion does not model this late `??=` refusal. It does not change any c1 finding's direction |
| H-W1 | **Decided in section 5 (false for an accepted execution).** Can an item be settled while its attempt is carrying? Section 5 gives the answer. At 1e240b0f a final-run `settled` refusal reaches the witness. If H-W1 is real, the orchestration fails visibly with an `applyIntakeAttempt` invariant error instead of completing (`rxr2-diag-w1-settled-visible`) |
| A-NATIVE | An assumption. Section 7 records the bounded native evidence |
| A-ACCEPT, A-LOCK, A-ONE/A-BATCH | As for c1bda7a2 |

## 3. Cases and their c1 companions

| # | Step | Bounds (att/exec/recovery; cancel; H-W1) | Expected |
|---|---|---|---|
| 1 | SANY `MCExposureCode1e24Runs` | — | valid |
| 2 | `rxr2-hd-w2w3` | 1/1/1; on; off | PASS, complete: 14 base invariant entries (13 + TypeOK), the 7 W1–W3 invariants and 4 action properties |
| 3 | `rxr2-hd-dup` | 1/2/1; on; off | PASS, complete (300 s; a timeout is INCONCLUSIVE) |
| 4 | `rxr2-hd-w1-hw1` | 1/1/1; off; **on** | PASS, complete: no hidden settled refusal and no completion without the final run's include, even under H-W1 |
| 5 | `rxr2-diag-w1-settled-visible` | 1/1/1; off; **on** | `Inv_C_NoSettledRefusalAccepted` violated, about 12 states: under H-W1 the code fails closed and visibly |
| 6 | `rxr2-wit-legit-correction` | 1/1/1; off; off | reached, about 6 states |
| 7 | `rxr2-wit-recovered-include` | 1/1/1; off; off | reached, about 8 states |
| 8 | `rxr2-wit-eligibility-blocked` | 1/1/1; on; off | reached, about 6 states (the recheck reads the cancellation) |
| 9 | `rxr2-wit-exposed-witness` | 1/1/1; off; off | reached, about 10 states (`exposed` witness applied as possibly sent, no completion) |

Only the stated causal shape counts. Compare each config with its c1 companion:

| 1e240b0f | c1bda7a2 companion (expected violated there) |
|---|---|
| step 2 | `rxr-c1-w2-unpolled-cancel-send`, `rxr-c1-w2-observed-cancel-send`, `rxr-c1-w2-gap-recovery-send`, `rxr-c1-w3-correction-after-abort` |
| step 3 | `rxr-c1-diag-w1-loser-settled-hidden` |
| step 4 | `rxr-c1-w1-settled-hidden`, `rxr-c1-w1-completion-without-final-include` |

The recorded results are in `README.md`.

## 4. Remaining obligations

- **Refinement** (required, as in section 7.4 of `EXPOSURE-CODE-C1BDA7A2.md`).
  Map the 1e240b0f code state (base, `MCExposureCode1e24Runs` and
  `MCExposureCodeC1EndCancel`) to `RecipientExposureSpec`. Each gap must be
  either a named exclusion or a counterexample.
- **A combined module.** The run-level module and the end/cancel module both
  extend the base separately. Their composition is an argument, not a check:
  the worker run actions change worker state and admissions, and the
  end/cancel actions change orchestration state and the store after the
  attempt is applied. They interact only through store admission (the
  marker), which both modules include, with the base `AdmitTxn` semantics. A
  checked composition is part of the refinement step.
- **A-NATIVE.** It is evidence only from an executed native run, not from
  the e966b418 test source (section 7).

## 5. H-W1 disposition

**H-W1 is false for an accepted execution**, from the implementation's author with source
citations (section 8 of `EXPOSURE-CODE-C1BDA7A2.md`). The cited files are
unchanged at 1e240b0f.

- `rxr2-hd-dup` is the source-faithful W1 check at this pin. Its losing
  duplicate's witness must carry the final run's `settled` refusal
  (`Inv_R_LoserSettledNotHidden`).
- `rxr2-hd-w1-hw1` and `rxr2-diag-w1-settled-visible` are hypothetical
  robustness checks. They are kept, but they no longer describe a reachable
  path, so they rank last.

## 6. Corrections made before the first execution, and the combined modules

- **AdmitTxnR, r1 correction.** `admit` sets `run.refused` as soon as the
  answer arrives (`session-proxy.ts` 1709), before the race resolves. The
  first version set the refusal only for a run that had already ended, so a
  guard between the answer and the send lost it. Now any answered or ended
  run keeps the refusal. Changed before the first execution.
- **`MCExposureCodeC1EndCancel`.** Its local `allVars` is renamed to
  `eAllVars`, so the composed module can extend it beside the run module. The
  rename changes no behaviour.
- **Source 49ad1394.** Its SDK runtime source is identical to 1e240b0f (the
  diff is a +6/-2 wiring test fixture), so nothing is re-derived.
- **Blocking writes.** `MCExposureCodeC1EndCancel` now makes every
  orchestration store write a blocking yield (`OrchFree`); see section 9 of
  `EXPOSURE-CODE-C1BDA7A2.md`.
- **Composition and refinement** are now modules:
  `MCExposureCode1e24Composed.tla` and `MCExposureCodeRefines1e24.tla`. 

## 7. A-NATIVE: bounded native evidence

Inputs:

- The 1e240b0f Vitest run.
- A focused native rerun at 5307b247. Its only change is a test-only bounded wait; the SDK `src` tree 177b0874 is identical to 1e240b0f and 49ad1394.

The first run passed 163 of 164 tests. The one failure was case 1: the test read
the `end_applied` CMS event before the end activity had completed (history ended
at the end's ActivityScheduled). It is a test timing defect, not a protocol
counterexample. The focused rerun passed 5 of 5 native redelivery cases in
27.9 s. The exact `end_applied` assertion passed after the bounded wait; the raw
event row was not dumped.

| Native case | Observed | Model correspondence |
|---|---|---|
| 1 crash after send; redelivered run stops before its send | 1 scheduled attempt, 2 model runs with the same input; redelivered `sent:false` completion accepted; end requested `not_dispatched`, applied `interrupted` | A second execution of one attempt (A-NATIVE), witness `unsent`, store coercion (`Inv_C_NotDispatchedTruthful`, `Inv_C_CoercionOnly`) |
| 2 crash after send; redelivered run admitted again and sends | Duplicate request; invocation completes | `Wit_C_DuplicateSends`; same attemptId admitted again |
| 3 crashed execution's admission, after the accepted negative result, before the end | End applied `interrupted` | Late admission commit before the end, then coercion (`Wit_C_LateCommitCoerced` shape). The request is injected directly into the real store |
| 4 the same, after the end | Refused `settled`; nothing recorded; end stays `not_dispatched`; 0 exposure rows | `StoreAdmit` after the end answers `settled` and inserts no marker; `Inv_C_NotDispatchedTruthful`. The request is injected directly |
| 5 crash after send; redelivered run fails before send; parks unsent; the next attempt is refused as exposed | 2 scheduled attempts, 3 model runs; ends `interrupted` | `Wit_C_RefusedExposed` (another attempt's marker) |

**A-NATIVE is now partly evidenced, within these limits:**

- reuse of the scheduled attempt's input and attemptId across one redelivery;
- after a controlled shutdown (500) and a runtime restart, not an OS kill;
- with a scripted model and a fake session manager, and no snapshot store;
- only the order in which the redelivered run's completion is accepted. The
  other acceptance order is not observed;
- cases 3 and 4 inject the crashed request into the real store and do not run
  an old worker.

The models keep A-NATIVE as an **assumption**. These runs are bounded evidence
for it, not a proof of every acknowledgement order. No model or config changes because of them.
