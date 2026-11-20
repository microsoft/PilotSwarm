# Workflow controller hand-off at continue-as-new (FB-064, then controller 1.2.0), batches ch2 and ch3

`ControllerHandoff.tla` checks the FB-064 rule: a running Workflow moves to the latest controller at continue-as-new,
as sessions do, while the carry and approval gates in the activities stay on the run's admission version. Batch ch3
adds controller 1.2.0 (1.1.0 frozen), whose only change is the Decision state: a run admitted at 1.0.0 or 1.1.0 moves
to 1.2.0 with an unchanged `ControllerInput`; its gates still come from its admission version, and 1.2.0's features
are 1.1.0's; it never moves down; and the frozen 1.0.0 and 1.1.0 parsers refuse a Decision plan, so a run admitted
before 1.2.0 never holds a Decision state. The Decision state itself (its effect, the test interception, the provider
deliveries) is in [`../decision/`](../decision/README.md).

Why the move is replay-safe (Duroxide core 0.1.32): `OrchestrationContinuedAsNew` stores only the input (`lib.rs`
1248); the continue-as-new action never becomes a history event (`replay_engine.rs` 1767-1770); a closed execution is
never run again; the next execution's version is resolved from the work item and recorded in its own
`OrchestrationStarted` (`dispatchers/orchestration.rs` 1081-1141, `state_helpers.rs` 517-528). So the target a frozen
handler passes is decided once, fresh, and is not compared on replay.

| Constant | Meaning |
|---|---|
| `Admitted` | 0 = 1.0.0, 1 = 1.1.0, 2 = 1.2.0: the run's stored admission version |
| `CarryDecl`, `ApprovalDecl`, `DecisionDecl` | the plan declares carry; step 2 is an approval state; step 3 is a Decision state |
| `GateBy` | `"admission"` (design) or `"execution"` (mutant) |
| `Target` | `"latest"` (FB-064), `"pinned"` (before FB-064), `"down"` (mutant) |
| `LenientParse` | hypothetical: the frozen plan parsers accepted a state type they do not know (they do not); ch2 and ch3 use it to show the approval and Decision paths are not vacuous |
| `Latest` | 1 for the FB-064 rows (ch1, ch2: 1.1.0 was the latest), 2 for ch3 |
| `Feature120` | `TRUE`: 1.2.0's feature entry is 1.1.0's (the code); `FALSE` is a mutant |

Properties: `Inv_GateHolds` (a 1.0.0 run keeps raw routing, as in `../carry/`), `Inv_NoCarryNull` (no carry envelope
for a predecessor entered without a snapshot), `Inv_ApprovalGated`, `Inv_NeverDown`, `Prop_Ends`; ch3 adds
`Inv_CarryKept` (a run admitted at 1.1.0 or later that declares carry keeps carry routing on any later handler),
`Inv_DecisionOnLatest` and `Inv_DecisionAdmitted` (a Decision state is dispatched only by a 1.2.0 execution, and only
in a run admitted at 1.2.0); witnesses `W_NoMove`, `W_NotFailed`, `W_NoApprovalCross`, `W_NoDecision`,
`W_NoDecisionCross`.

Expected: every design case passes, including a 1.0.0 run whose IR declares carry (reachable only through the
unsupported path of a 0.8.11 worker beside the new build); gating on the execution version breaks `Inv_GateHolds` and
`Inv_NoCarryNull`; a downgrade breaks `Inv_NeverDown`; a 1.0.0 approval plan fails at its first plan parse, before any
continue-as-new.

Expected in ch3: every design case passes at `Latest = 2`; a 1.1.0 run's carry survives the move even if the gate read
the execution version (1.2.0's features equal 1.1.0's), but not with a 1.2.0 entry that drops carry; a 1.0.0 or 1.1.0
Decision plan fails at its first parse; under the lenient parser a 1.1.0 Decision plan crosses to 1.2.0 and is
dispatched, which breaks `Inv_DecisionAdmitted`: the frozen parsers are the Decision's only guard.

Not modeled: the controller's state transfer. `ControllerInput` and its parsers are identical in 1.0.0 and 1.1.0, and
the generators differ only on approval states; that is a source correspondence with recorded-history tests, not a
model obligation.

Code binding: FB-064 rows at `93710d97` ([correspondence](CORRESPONDENCE-93710d97.md)); ch3 at `911c5558`
([correspondence](CORRESPONDENCE-911c5558.md)).

Run: `python3 gen-cases.py`, then `./run-tlc.sh <out>` (v1.7.4).

## Results

| Batch | Run | Outcome |
|---|---|---|
| ch1 | 2026-11-13 22:52Z, TLC 2.19, two workers, 300 s per case | 9 of 9 as expected: 5 PASS (22 distinct states each; `ch.design-100-approval` 2, by design: the initial state and the failure at the first plan parse, with no continue-as-new reachable), 4 VIOLATION each on its named property; no timeouts or errors |
| ch2 | 2026-11-13 22:57Z, as ch1 | 13 of 13 as expected: 6 PASS, 7 VIOLATION. The approval path is not vacuous: `wit.ch-approval-fails-at-parse` reaches the parse failure; under the hypothetical lenient parser the crossing to 1.1.0 is reachable (`wit.ch-approval-crosses`, 8 states), the admission gate still refuses the approval (`ch.hyp-100-approval-crosses`, 14 states), and gating on the execution version activates it (`mut.ch-approval-gate-exec`) |
| ch3 | 2026-11-20 18:46Z, TLC 2.19 (tla2tools v1.7.4), Java 21.0.13.1 (Temurin), two workers, 300 s per case | 30 of 30 as expected: the 13 FB-064 rows re-run with their recorded counts (22 distinct states each for the moving cases, 2 for the parse failure, 14 and 8 for the lenient approval cases); the 17 ch3 rows: 7 PASS (22 distinct states each; 2 for the 1.0.0 and 1.1.0 Decision plans, which fail at their first parse), 10 VIOLATION each on its named property (`cmp.ch3-110-decision-lenient` breaks `Inv_DecisionAdmitted` after a continue-as-new, 18 distinct states). No PARTIAL, no VOID; each case under 3 s |
