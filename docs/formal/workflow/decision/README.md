# The Decision state on controller 1.2.0, batch dd1

`WorkflowDecision.tla` models one Decision state's node execution as controller 1.2.0 runs it, bound to
`911c55582f08b4165ed58d4a0884a6610137e46b` ([correspondence](CORRESPONDENCE-911c5558.md)):

- the controller dispatches the state: a live run starts the Decision effect (`workflow-effect` 1.1.0, input
  `nodeType: "decision"`); a test run intercepts it, and its parent or a fixture answers;
- the effect runs `runDecision`, which reads the node, counts its attempt at entry (`store.enterScript`, only for a
  pending node of an active run), refuses a third delivery (`unavailable`, no claim, no call), admits the provider,
  claims the ledger row of (operation, attempt) before the call, calls the provider, and settles the claim in `finally`
  (first only, retried, its failure swallowed);
- Duroxide records the activity result in the effect's history; `recordEffectResult` stores it with
  `store.completeNode`, the pending-only compare-and-swap; the controller routes from the stored result;
- a worker crash before the result is in history delivers `runDecision` again (`MaxCrash`); a cancellation, deletion
  or the run's deadline ends the run and decides the pending node in one transaction, at any point.

The move of a run to 1.2.0 at continue-as-new, its feature gates and the frozen parsers that refuse a Decision plan are
in [`../handoff/`](../handoff/README.md) (batch ch3).

| Constant | Meaning |
|---|---|
| `TestRun` | the plan is a test run's |
| `Cancel` | a cancellation (or deletion, or the run's deadline) may commit at any point |
| `MaxCrash` | worker crashes of `runDecision` before its result is in history |
| `MaxSettleRetry` | settlement calls the best-effort retry repeats, over the whole behaviour |
| `Faults` | the protections removed on purpose: `noIntercept`, `noTestGuard`, `noCap`, `callBeforeClaim`, `noEntryGuard`, `settleNotFirstOnly`, `settleAlters`, `noCas`; `{}` is the code |

Properties: `Inv_CallCap` (at most two provider calls; a third or later delivery makes no claim and no call),
`Inv_ClaimBeforeCall`, `Inv_SettleOnce`, `Inv_SettlementInert` (settlement never changes the result),
`Inv_NoWorkAfterDecided` (a cancellation or lifecycle end that commits first stops the delivery before provider work),
`Inv_FirstWinnerKept`, `Inv_ResultFromHistory`, `Inv_RouteFromStored`, `Inv_TestNoEffect`, `Inv_TestNoProvider`,
`Inv_LiveNotIntercepted`; liveness `Prop_Routed` under weak fairness of the controller's and the effect's steps
(crashes are bounded; a cancellation and a test answer are free choices, never forced).

## Cases (dd1)

| Kind | Cases | Expected |
|---|---|---|
| holds | `dec.live` (two crashes, one lost settlement reply, cancellation), `dec.live-crash3` (three crashes), `dec.test` | PASS |
| liveness | `dec.live-routes` (no cancellation) | PASS |
| comparison | `cmp.dec-test-runtime-guard`: with no interception, `runDecision`'s own refusal of a test run still keeps every provider untouched | PASS |
| deliberate fault | `fault.dec-no-intercept`, `-no-test-guard`, `-no-cap`, `-call-before-claim`, `-settle-twice`, `-settle-alters`, `-no-entry-guard`, `-no-cas` | each violates its named rule |
| witness | `wit.dec-calls`, `-recovery-call`, `-third-refused`, `-uncertain-routes`, `-late-answer-loses`, `-call-after-late-cancel`, `-claim-unsettled`, `-test-answered` | each violates its `W_` predicate |

Bounds: one node execution; `Answers` = {yes, uncertain}, one provider error; `MaxCrash` 0 to 3; `MaxSettleRetry` 1.
Two crashes are the smallest bound that reaches a third delivery; three show the fourth refused too. More answer
values would only rename outcomes.

## Results

| Batch | Run | Outcome |
|---|---|---|
| dd1 | 2026-11-20 18:45Z, TLC 2.19 (tla2tools v1.7.4), Java 21.0.13.1 (Temurin), two workers, 300 s per case | 21 of 21 as expected: 5 PASS, 8 expected fault violations, 8 witnesses reached; no PARTIAL, no VOID. `dec.live` 6,709 distinct states (depth 26), `dec.live-crash3` 13,504 (depth 29), `dec.live-routes` 2,263 with its temporal property checked, `dec.test` 14, `cmp.dec-test-runtime-guard` 46. Each case finished in 2 s or less |

The witnesses also record three limits of the code, none of which breaks a rule above:

- `wit.dec-third-refused`: the attempt is counted at entry, so two crashes after entry and before any call leave the
  node `unavailable` with no provider call at all.
- `wit.dec-call-after-late-cancel`: a cancellation that commits after the entry does not stop the claim and the call;
  the liveness check aborts the call, and its result loses the compare-and-swap (`wit.dec-late-answer-loses`).
- `wit.dec-claim-unsettled`: a crash between the call and the settlement, or a settlement failure that the retry
  swallows, leaves a claimed attempt unsettled: its usage is not counted on the ledger or the budget meters.

The proposal's design model, `docs/proposals/workflow-decision-node/formal/DecisionEffectCompletion.tla`, was run once
as it is, with its own settings file (TLC 2.19, Java 21.0.13.1, two workers): PASS, all nine invariants, 230 states
generated, 164 distinct, depth 10, under 1 s (inputs: `.tla` sha256 `0d133af1`, `.cfg` sha256 `3abfe9d5`). It is design
evidence for the v10 policy, not bound to this head; this folder's model is.

Run: `python3 gen-cases.py`, then `./check-packet.sh` and `TLA_TOOLS=<dir> ./run-tlc.sh <out>` (v1.7.4).
