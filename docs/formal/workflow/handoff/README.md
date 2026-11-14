# Workflow controller hand-off at continue-as-new (FB-064), batch ch2, design-first

`ControllerHandoff.tla` checks the FB-064 rule: a running Workflow moves to the latest controller at continue-as-new,
as sessions do, while the carry and approval gates in the activities stay on the run's admission version.

Why the move is replay-safe (Duroxide core 0.1.32): `OrchestrationContinuedAsNew` stores only the input (`lib.rs`
1248); the continue-as-new action never becomes a history event (`replay_engine.rs` 1767-1770); a closed execution is
never run again; the next execution's version is resolved from the work item and recorded in its own
`OrchestrationStarted` (`dispatchers/orchestration.rs` 1081-1141, `state_helpers.rs` 517-528). So the target a frozen
handler passes is decided once, fresh, and is not compared on replay.

| Constant | Meaning |
|---|---|
| `Admitted` | 0 = 1.0.0, 1 = 1.1.0: the run's stored admission version |
| `CarryDecl`, `ApprovalDecl` | the plan declares carry; step 2 is an approval state |
| `GateBy` | `"admission"` (design) or `"execution"` (mutant) |
| `Target` | `"latest"` (FB-064), `"pinned"` (before FB-064), `"down"` (mutant) |
| `LenientParse` | hypothetical: the 1.0.0 plan parser accepted an approval state (it does not); ch2 uses it to show the approval path is not vacuous |

Properties: `Inv_GateHolds` (a 1.0.0 run keeps raw routing, as in `../carry/`), `Inv_NoCarryNull` (no carry envelope
for a predecessor entered without a snapshot), `Inv_ApprovalGated`, `Inv_NeverDown`, `Prop_Ends`; witness `W_NoMove`.

Expected: every design case passes, including a 1.0.0 run whose IR declares carry (reachable only through the
unsupported path of a 0.8.11 worker beside the new build); gating on the execution version breaks `Inv_GateHolds` and
`Inv_NoCarryNull`; a downgrade breaks `Inv_NeverDown`; a 1.0.0 approval plan fails at its first plan parse, before any
continue-as-new.

Not modeled: the controller's state transfer. `ControllerInput` and its parsers are identical in 1.0.0 and 1.1.0, and
the generators differ only on approval states; that is a source correspondence with recorded-history tests, not a
model obligation.

Run: `python3 gen-cases.py`, then `./run-tlc.sh <out>` (v1.7.4).

## Results

| Batch | Run | Outcome |
|---|---|---|
| ch1 | 2026-11-13 22:52Z, TLC 2.19, two workers, 300 s per case | 9 of 9 as expected: 5 PASS (22 distinct states each; `ch.design-100-approval` 2, by design: the initial state and the failure at the first plan parse, with no continue-as-new reachable), 4 VIOLATION each on its named property; no timeouts or errors |
| ch2 | 2026-11-13 22:57Z, as ch1 | 13 of 13 as expected: 6 PASS, 7 VIOLATION. The approval path is not vacuous: `wit.ch-approval-fails-at-parse` reaches the parse failure; under the hypothetical lenient parser the crossing to 1.1.0 is reachable (`wit.ch-approval-crosses`, 8 states), the admission gate still refuses the approval (`ch.hyp-100-approval-crosses`, 14 states), and gating on the execution version activates it (`mut.ch-approval-gate-exec`) |
