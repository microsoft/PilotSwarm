# Workflow approval step (FB-007): design model

`WorkflowApproval.tla` models the person-facing approval step (Dag, FB-007). Batch ap1 followed the design note
`dag-human-approval-design.md` (sha256 `d224c115…`, base `bacabe64`). Batch ap2 binds the acknowledged contract
`dag-human-approval-schema.md` (sha256 `e117753e…`) and its addendum `dag-human-approval-model-addendum.md` (sha256
`47cfbb47…`), on Ace's controller 1.1.0 plan (gate `approval`; base `288cb6c3`; migration 0091). It is a design model;
no implementation exists yet.

## Contract binding (ap2)

| Contract (e117753e) | Model |
|---|---|
| `approval_id` is the node execution id, with `context_sha256` over the frozen snapshot (section 1, addendum 1) | A request names its visit (`VisitOf`); `MatchByNode` is the fault of selecting the state's newest pending row |
| Actor must equal both the pinned owner and the Workflow's current owner (section 2) | `OwnerOk`: `Who(r) = pin[v]` and `Who(r) = owner`; `pin` is fixed at activation; `ChangeOwner` makes them differ; faults `PinnedOnly`, `CurrentOnly`. Readers, admins, shared writers, agents and system actors are never the owner |
| Lock order session, run, node, approval, receipt; one clock reading after the locks; acceptance needs a pending node, an active run (paused allowed), no accepted stop, a matching digest and `now < effectiveDeadline` (section 4) | One transaction per decision and per timeout (`Deliver`, `Timer`); `OnTime`; `Acceptable`; faults `NoLock`, `AtDeadline`, `NoStopCheck` |
| Effective deadline: the earlier of admission + `timeoutSeconds` and the run deadline; pausing never extends it (section 1) | `dl = Min(now + D, RunDl)`; the run's own deadline also ends the run (`EndRun`) |
| Node result, audit row, operation receipt and session event commit atomically; the wake is sent after commit (section 4, addendum) | `Accept` writes `rec` (node result and audit), `receipt` and the wake in one step; fault `SplitReceipt` |
| Identical retries return the stored receipt, also after the deadline or the run's end; changed content under the same id conflicts; a fresh late or second answer is refused (section 2) | `Replay`, `SameAsReceipt`; `ownConflict1` reuses `ownA1`'s id with the other decision; fault `NoIdem` |
| Cancel, delete, stop, run and branch deadlines win first or keep an accepted result without starting work (section 4) | `EndRun` and `Cut` close a pending row; `Stop` refuses fresh answers and the run ends once the row is final; `Route` needs a running run and an uncut branch |
| Durable deadline timers, collect while paused without routing, consume each settled node once after resume, lost wake recovered by the backstop, continue-as-new carries identifiers and deadlines only (section 4, addendum 2-3) | `Timer` (`Backstop`), `PausedWakeKept`, `ResumeReread`, `Route` guarded by the node execution, `Can` with `CanReread` |
| Test mode creates an interception answered only by fixtures; no fixture can decide a live approval (section 4) | `Mode`; a test run accepts only `fixture`; fault `FixtureLive` |
| Controller 1.0.0 has no approval path (version plan) | `Gate = FALSE`: the state is never admitted |

Graceful stop, as integrated at `288cb6c3` (Dag, 03:41Z): the store pins a stop deadline (default grace 60 s,
`service.ts` 997; at most 3,600 s, `store.ts` 282). At that deadline the controller calls stop (`runtime.ts` 1681,
1756), and `finishStoppedRun` (`store.ts` 6888) cancels every pending node, the approval included, keeping an accepted
result without routing it. Stop is handled before pause (`runtime.ts` 1638). In the model that close is `EndRun`
(enabled while stopping when `AllowEnd`), so a stopping run does not wait for the approval's own deadline. `StopEnds`
covers the other order, where the row became final first. The no-answer-after-stop check stays under the locks.

Code binding: `CORRESPONDENCE-004eff4e.md` maps the model to Ace's batch-2 integration head `004eff4e` (bound before at
`9fe74425`, `db6693cd`, `89c5b1a2`, `1d391f28` and `419d2de8`).

Not bound: compile-time shape checks, the agent-subtree `forbidden` refusal at activation, payload limits, the read
projection and `mayAnswer`, the UI, and host clock skew (the store's clock is the only clock).

Interactions. There is no owner transfer and no hand-over: a Workflow's current owner never changes after
activation. `ChangeOwner` is a robustness fault: it shows that the check would still hold if the owner did change.
Approval authority is owner-based, not share-based, so a person who can read the run, for example through sharing,
cannot answer (`AnyReader` is the fault). FB-005 carry does not touch the frozen snapshot: the snapshot is the
approval's input at admission.

## What it models

One approval state in a run. With `Loop`, a rejection routes back to a second visit whose context changed. Each visit has
one approval record. The store's clock fixes the record's deadline at activation (`now + D`), and pausing does not move
it.

| Part | Model |
|---|---|
| A person's decision | A request names who sends it, the visit (and so the context digest) its page showed, the decision and an operation id. It may be delivered twice. Accepted only from the pinned owner, for the current visit's pending record, on a run that has not ended, while `now < deadline`, in one transaction under the record's lock. An operation id with a receipt replays the receipt (the same request) or is refused (another request). |
| Timeout | The controller's durable deadline timer fires at or after the deadline, also while paused. In the record's transaction it settles a pending record as `timed_out`. Then the controller reads the record (the backstop for a lost wake). |
| Wake | An accepted decision enqueues a wake. It may be lost (`LoseWake`) or duplicated (`DupWake`). |
| Route | The controller completes the node execution once (guarded by the node execution) and only while the run is running. A rejection with `Loop` activates the second visit. |
| Pause, resume, cancel or delete | Pausing stops routing but not the deadline. A resume reads the record (`ResumeReread`). Cancel or delete closes a pending record; a settled record stays and starts nothing. |

## Rules (the design's required invariants)

| Rule | Predicate |
|---|---|
| At most one final decision | `Inv_OneDecision` |
| Only a pinned human can accept | `Inv_OnlyPinned` |
| No acceptance at or after the deadline | `Inv_BeforeDeadline` |
| No step starts while paused or ended | `Inv_NoStartUnlessRunning` |
| A buffered acceptance routes once | `Inv_RoutedOnce` |
| Changed context never reuses prior consent | `Inv_ConsentFresh` |
| Duplicate deliveries replay the original receipt; a lost response then the exact retry returns the acceptance | `Inv_ReceiptStable` |
| The actor is the pinned and the current owner (live); a fixture (test) | `Inv_OnlyPinned`, `Inv_OwnerAtDecision` |
| Node result, audit and receipt agree | `Inv_AuditAgrees` |
| No fresh answer after an accepted stop | `Inv_NoAnswerAfterStop` |
| Controller 1.0.0 has no approval path | `Inv_GateHolds` |
| A stopping run ends | `Prop_StopEnds` |
| Every record settles; a settled record of a live run is routed, despite lost wakes and pauses | `Prop_Settles`, `Prop_Routed` |

## Cases (batches ap1, 18, and ap2, 17; the ap4 packet runs all 35)

| Group | Cases | Expected |
|---|---|---|
| design | `ap.design-v1`, `ap.design-loop`, `ap.live`, `ap.live-pause-reread` | PASS |
| fault | `fault.ap-any-reader` (`Inv_OnlyPinned`), `fault.ap-at-deadline` (`Inv_BeforeDeadline`), `fault.ap-no-lock` (`Inv_OneDecision`), `fault.ap-match-by-node` (`Inv_ConsentFresh`), `fault.ap-no-idem` (`Inv_ReceiptStable`), `fault.ap-no-route-guard` (`Inv_RoutedOnce`), `fault.ap-route-while-paused` (`Inv_NoStartUnlessRunning`), `fault.ap-no-backstop` and `fault.ap-pause-forgets` (`Prop_Routed`) | violation |
| witness | `wit.ap-approval`, `wit.ap-second-visit`, `wit.ap-timeout-while-paused`, `wit.ap-accepted-then-ended`, `wit.ap-boundary-refusal` | violation (reachable) |
| ap2 design | `ap2.design-contract`, `ap2.design-loop`, `ap2.test-mode`, `ap2.gate-off`, `ap2.run-deadline`, `ap2.live` | PASS |
| ap2 fault | `fault.ap2-pinned-only` (`Inv_OwnerAtDecision`), `fault.ap2-current-only` and `fault.ap2-fixture-live` (`Inv_OnlyPinned`), `fault.ap2-no-stop-check` (`Inv_NoAnswerAfterStop`), `fault.ap2-split-receipt` (`Inv_ReceiptStable`), `fault.ap2-split-audit` (`Inv_AuditAgrees`), `fault.ap2-can-forgets` (`Prop_Routed`) | violation |
| ap2 witness | `wit.ap2-paused-then-routed`, `wit.ap2-run-deadline-first`, `wit.ap2-accepted-then-cut`, `wit.ap2-replayed-receipt` | violation (reachable) |

## Design points the model fixes

- A request must name its visit: the node execution, or the context digest. Matching only the node's current visit
  lets a late approval of old context approve new context (`fault.ap-match-by-node`).
- The deadline timer must also read a record that is already decided. Otherwise a lost wake leaves the run waiting
  forever (`fault.ap-no-backstop`). The design's "recovery/backstop" can be exactly this timer.
- A wake taken while paused must be kept, or the resume must read the record (`fault.ap-pause-forgets`).

## Not modelled

- More than one approval state, and named additional approvers (deferred by the design).
- The UI, and security-audit records of refused attempts.
- Clock skew between hosts: the store's clock is the only clock.

## Results

| Batch | Run | Result |
|---|---|---|
| ap1 | 2026-11-12 03:23Z | 12 of 18 as expected: all 7 safety faults and all 5 witnesses. The 4 design cases and the 2 liveness faults stopped on a model defect: `TypeOK` mixed the string `"none"` with receipt tuples, which TLC cannot compare. Fixed in ap3 (`NoRcpt == <<0, "none">>`) |
| ap2 | not run (superseded by ap3: the same cases with the `TypeOK` fix) | |
| ap3 | 2026-11-12 03:4xZ, TLC 2.19, two workers, 600 s per case | 33 of 35 as expected; no evaluation errors. `ap2.design-contract` 14,914,368 states (430 s). Two mismatches, both model defects: `ap.live` violated liveness because the model's clock stopped at `MaxT` once the second visit's row was settled, so its deadline timer (the backstop for the lost wake) could never fire; `ap2.design-loop` reached the 600 s cap at 21,063,780 states (not checked). Fixed in ap4: the clock runs on to the current visit's deadline until its timer fires, and `ap2.design-loop` drops the duplicate wake, stop, cut and the second rejection (stop and cut are covered by `ap2.design-contract`) |
| ap4 | 2026-11-12 04:09Z, as ap3 | 35 of 35 as expected. `ap2.design-contract` 14,914,368 states, depth 27, 443 s; `ap2.design-loop` 1,092,636; `ap.live` 179,034. Liveness faults: traces 9, 13 and 10 |
