# Workflow paired models: the messaging request (request and reply)

This folder holds the paired TLA+ models of the Workflow messaging request
(design `docs/proposals/workflow-messaging-request.md`). The core models of
`../` are separate. Two sub-folders belong to the same effort:

- `recipient/`: the durable recipient intake (claim, bind, expose, settle,
  cancel). See `recipient/README.md`.
- `request/`: variant B of the request intent (the chosen design for durable
  expiry). See `request/README.md`.

The pair has two tracks:

1. **Intent model.** It comes only from the design text. Every counterexample
   is classified and fed back into the design.
2. **Code model.** It comes later and on its own from the code at an exact
   commit. An explicit mapping relates it to the intent model. Two PASS
   results do not show that the models are equivalent; only the mapping and
   its refinement obligations can.

TLA+ does not verify the TypeScript or PostgreSQL code directly. Code
correspondence comes from a human-checked mapping and from concrete regression
tests. A TLC pass is a bounded check, not a proof.

## 1. What the models cover

| Module | Track | Models |
|---|---|---|
| `WorkflowRequestSpec.tla` | intent | One request, its requester workflow, the frozen responder and one other authenticated session; design text at `8021c75e` (blob `3e9b7927`) |
| `WorkflowRequestSpec57.tla` | intent | The same with durable expiry (a request stays expired once an operation was bound `expired`); design blob `d57b406b`; a `ClockMode` of `"monotone"` (A-CLK) or `"rollback"` |
| `MCWorkflowRequestSpec57Late.tla` | intent, witness wrapper | History variables for `Prop_NoDecisionFromLateReading`; changes no definition |
| `MCWorkflowRequestSpecView.tla` | intent, projection wrapper | Adds a `VIEW` (`SafetyView`) for the projection configuration `rs-pv-decision` |
| `WorkflowRequestCode.tla` | code | The request store at `8021c75e`, with a refinement mapping to `WorkflowRequestSpec` |
| `WorkflowRequestCodeAuth.tla` | code | The same, with the authority environment chosen by `AuthEnv` (`CODE-AUTH-AUDIT.md`) |
| `WorkflowRequestCode57.tla` | code | The request store at `57fbb0d6` (in-time check `at < Deadline /\ ~ExpiredBound`), mapped to `WorkflowRequestSpec57` |
| `MCWorkflowRequestCode8021Clock.tla` | code | The `8021c75e` code model, unchanged, plus clock rollback and `Inv_C_NoDecisionAfterExpiry` |

Notes that explain the models:

| File | Subject |
|---|---|
| `CODE-MODEL.md` | The code model at `8021c75e`: source files, action table, mapping to the intent model, observations C1 to C5 |
| `CODE-AUTH-AUDIT.md` | The authority audit behind assumption A-OWN, and an erratum on the requester's deletion |
| `CLOCKFIX-57FBB0D6.md` | The durable-expiry correction at `57fbb0d6`: the models, the eligibility refinement, the residual R57-1 |

## 2. The code these models are bound to

| Item | Pin |
|---|---|
| Design | `docs/proposals/workflow-messaging-request.md`: blob `3e9b7927` at `8021c75e`; blob `d57b406b` at `57fbb0d6`; blob `fdb38954` at `98979a12` and `2943167c` |
| Code at `8021c75e` | `packages/sdk/src/workflow/store.ts` (`respondToRequest` 2785-2935, `finishRun` 3133-3189, `elapseWait` 2442-2475, `enterNode` 2240-2345, `lockSessionPair` 1055-1079), `authority.ts` 53-99, `runtime.ts` (the plan activity refuses a request state, 1376), migrations `workflow-v2-0087.ts` and `workflow-v2-0093.ts` |
| Code at `57fbb0d6` | The same files; only the in-time check of `respondToRequest` changed (`store.ts` 3108-3117) |
| Code at `98979a12` | `WorkflowStore.transaction` issues `BEGIN ISOLATION LEVEL READ COMMITTED` (`store.ts` 1535-1549); every modeled function is byte-identical to `57fbb0d6` |

Line numbers refer to the pinned commits (`git show <commit>:<path>`), not to
the current head. The request is a disabled foundation at these commits: no
runtime path enters a request, and the models start with one request already
entered pending.

Assumption A-ISO: the store's transactions read committed data after a lock
wait. It is enforced in source at `98979a12`, and two native regression tests
of the durable expiry (`packages/sdk/test/local/workflow-request.test.js`)
passed there, one of them with an inherited REPEATABLE READ default. No model
change or rerun was needed.

## 3. Assumptions and design findings

| Id | Assumption | In the model | Without it |
|---|---|---|---|
| A-CLK | The store clock never goes back between readings (also across a failover). `clock_timestamp()` does not guarantee it. | `Tick` only moves forward | `rs-as-clock-backward`: a response is decided after another operation got `REQUEST_EXPIRED` (F1) |
| L1 | Every node producer serializes with an open response transaction (requester `FOR NO KEY UPDATE`, responder `FOR SHARE`, then run and node) | Every producer except a response needs `~LockBlocks` | `rs-df-no-lock` |
| A-OWN | Authority inputs do not change while a response holds the session locks (the code locks only the two session rows) | `CLoseAuthority` guard | `rc-as-auth-unlocked-loss` |
| A-SCHED, A-RESUME, A-BACKSTOP | Healthy scheduling; a paused run is resumed or ended; the backstop collects when the run is unpaused infinitely often | Weak fairness on the steps, `WF(Resume)`, `SF(Collect)` | Liveness only |

| Id | Class | Finding (design text) |
|---|---|---|
| F1 | Missing assumption | "The winner is always the first binding" holds only with A-CLK. With a clock that steps back, an operation gets `REQUEST_EXPIRED` and a later one decides. Fixed by durable expiry (`57fbb0d6`). |
| F2 | Ambiguity | A new operation with a deleted requester gets `REQUEST_CLOSED` with the derived status and no receipt, also when a response won before the deletion |
| F3 | Clarification | `abandoned` can follow a successful enqueue with a lost acknowledgement: it means "dispatch not confirmed", not "no hint was enqueued" |
| F4 | Ambiguity | After the deadline and before the elapse runs, delivery failure, run end and deletion can still decide the node; deadline precedence applies between observation and elapse |
| F5 | Ambiguity | The elapse may decide `timed_out` while the run is paused; collection waits for the resume |
| F6 | Missing assumption | The lock order of `failDelivery` is "as a send's"; the serialization argument needs every producer to wait for an open response |
| R57-1 | Residual | Durable expiry starts only when an operation observes the expiry. A deadline passage that nobody observed and the clock then steps back is not stopped. |

The findings are questions about the design, not confirmed code faults.

## 4. Limits of the code models

1. The kernel starts from a request that is already entered. Nothing at
   `8021c75e` enters one at run time.
2. Validation steps write nothing and are not modeled (operation id, call
   shape, size, schema).
3. PostgreSQL is abstracted: one response transaction at a time holds the
   requester's row lock; the other writers are atomic and run only when no
   response holds it; a statement reads one committed snapshot; deadlock aborts
   are not modeled.
4. The clock is monotonic in `WorkflowRequestCode`. Rollback is modeled in
   `WorkflowRequestCode57` and in the `8021c75e` clock wrapper.
5. Cancellation times use the current clock; the code writes `now()`.
6. A-OWN is discharged by a static audit of repository code only (writes from
   outside the repository are excluded).
7. There is no request elapse, observation, delivery or wake dispatch at these
   commits. Those intent variables map to constants, and no liveness is claimed.
8. One request, with no other runs or nodes.
9. The mapping is a human reading of the code. TLC checks the model and the
   mapping, not the TypeScript.
10. `Refines` is a safety refinement obligation. A violation of a configuration
    that removes an assumption shows that the refinement depends on it; it is
    not a code defect.

## 5. Case taxonomy and expected results

Case ids are `<prefix>-<kind>-<name>`. Prefixes: `rs` (intent at `8021c75e`),
`rs57` (intent with durable expiry), `rc` (code at `8021c75e`), `rc57` (code at
`57fbb0d6`), `rc8021` (the `8021c75e` clock wrapper). Kinds: `hd` (expected to
hold), `df` (deliberate fault), `as` (an assumption removed), `wit` (witness:
expected violation that proves reachability), `cand` (a candidate hazard), `px`
and `pv` (projections of the full cases).

| Group | Cases | Expected |
|---|---|---|
| Holds, intent | `rs-hd-safety`, `rs-hd-safety-limit`, `rs-hd-liveness` (full bounds); smaller bounds `rs-hd-safety-decide`, `rs-hd-safety-wake`, `rs-hd-liveness-small` | PASS (complete searches only) |
| Projections of the full holds | `rs-px-decision`, `rs-px-decision-limit`, `rs-px-wake`, `rs-px-live-decide`, `rs-px-live-wake`, `rs-pv-decision` | PASS; sound arguments, not equivalences (the `VIEW` is not shown to be exact) |
| Deliberate faults | `rs-df-no-lock`, `-second-reading`, `-replay-first`, `-bind-on-deleted`, `-wake-separate`, `-no-token`, `-abandon-twice` | the named property is violated |
| Assumption removed | `rs-as-clock-backward` | `Inv_NoDecisionAfterExpiry` violated (F1) |
| Witnesses | `rs-wit-straddle-deadline`, `-stale-holder`, `-closed-after-delete`, `-abandoned-after-enqueue`, `-delivery-failed-after-deadline`, `-timed-out-while-paused` | violated (reachable) |
| Durable expiry | `rs57-df-no-durable-expiry`, `rs57-as-rollback-original-eligibility`, `rs57-wit-late-commit`, `rs57-wit-late-commit-rollback`, `rs57-wit-unobserved-late` | violated; `rs57-hd-rollback-small`, `rs57-hd-monotone-equiv-small`: PASS at a smaller bound |
| Code at `8021c75e` | `rc-hd-refines`, `rc-hd-refines-limit`, `rc-hd-refines-auth-source` | PASS (conditional on A-OWN and an entered request) |
| Code hazards | `rc-cand-elapse-store-api`, `rc-cand-elapse-refines` (C1: the generic `elapseWait` on a request node), `rc-as-auth-unlocked-loss` | violated |
| Code at `57fbb0d6` | `rc8021-as-rollback` | violated (the old rule, reproduced) |
| | `rc57-as-rollback`, `rc57-hd-monotone` | PASS (conditional on the limits above) |

`cases.tsv` lists all 42 cases with their entry module; `cases.json` has the
expected result of each case from its settings file.

## 6. Results

Recorded runs (TLC 2.19, `-workers 2`, `-Xmx2g`, deadlock check on). Dates are
2026-11-01 to 2026-11-02; the model commits were `e9d2336e`, `732ec4a3` and
`8a86ddd4`.

| Batch | Model | Cases run | PASS | Expected violations | PARTIAL | VOID |
|---|---|---|---|---|---|---|
| First intent batch | `WorkflowRequestSpec` | 6 | 0 | 3 (`rs-wit-straddle-deadline`, `rs-df-second-reading`, `rs-as-clock-backward`) | 3 (`rs-hd-safety`, `rs-hd-safety-limit` at 120 s; `rs-hd-liveness` at 180 s; no violation found) | 0 |
| Smaller bounds | `WorkflowRequestSpec` | 3 | 2 (`rs-hd-safety-wake`, 1,838,944 distinct states; `rs-hd-liveness-small`, 362,080) | 0 | 1 (`rs-hd-safety-decide`, 120 s) | 0 |
| Durable expiry | `WorkflowRequestSpec57`, `WorkflowRequestCode57`, `MCWorkflowRequestCode8021Clock` | 5 | 1 (`rc57-as-rollback`, 260,286 distinct states) | 4 (`rs57-df-no-durable-expiry`, `rc8021-as-rollback`, `rs57-as-rollback-original-eligibility`, `rs57-wit-late-commit`) | 0 | 0 |
| **Total** | | **14 of 42** | **3** | **7** | **4** | **0** |

Every recorded violation was caught by its named property with the expected
cause. The three full-bound holds and the `rs-hd-safety-decide` case did not
finish; the state space grows by about 2.5 to 3.3 million distinct states per
minute at the full bounds, mainly from two operations, two dispatchers and
three result identities. A timeout is PARTIAL, not PASS.

Not run in the recorded batches (28 cases): the other 5 deliberate faults,
the other 5 witnesses, the 6 projection cases, `rs57-wit-late-commit-rollback`,
`rs57-wit-unobserved-late`, `rs57-hd-rollback-small`,
`rs57-hd-monotone-equiv-small`, `rc-hd-refines`, `rc-hd-refines-limit`,
`rc-hd-refines-auth-source`, `rc-cand-elapse-store-api`,
`rc-cand-elapse-refines`, `rc-as-auth-unlocked-loss` and `rc57-hd-monotone`.

What the `rc57-as-rollback` pass covers: the `57fbb0d6` response transaction
as modeled, `finishRun`, the deletion trigger, the responder's deletion and
clock rollback; the code invariants `TypeOK_C`, `Inv_C_NoDecisionAfterExpiry`,
`Inv_C_StatusMapped`, `Inv_C_NoCorruptAnswer`; and the `Refines` obligation to
`WorkflowRequestSpec57`, at deadline 1, clock up to 2, two operations, two
values, binding limit 2. It does not cover larger bounds, authority changes
during an open response, any request elapse, observation, delivery or wake
dispatch, liveness, or R57-1.

## 7. How to run

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
`CHECK_DEADLOCK TRUE`: deadlock checking was on in all recorded runs of this
folder. A bounded pass is not a proof.

`SHA256SUMS` pins every `.tla`, `cases.*`, `tlc-templates.json`, runner and this README; the settings files
are generated from the case tables (`../../tlc_cases.py`) and not committed.
Comments of some modules were edited when this folder was prepared for the
repository (internal references removed); no definition changed.
