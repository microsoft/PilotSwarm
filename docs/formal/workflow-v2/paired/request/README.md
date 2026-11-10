# Workflow V2 request, variant B: the chosen durable-expiry intent

This folder holds the intent models of the Workflow V2 messaging request
(design `docs/proposals/workflow-messaging-request.md`) for the design text at
`2943167c` (blob `fdb38954`), in two variants. The earlier intent models and
the code models of the request store are in `../`. A TLC pass is a bounded
check, not a proof.

## 1. What the models cover

| Module | Models |
|---|---|
| `WorkflowV2RequestSpec57.tla` | Variant A, the literal design text: a byte-identical copy of `../WorkflowV2RequestSpec57.tla` (durable expiry: a request stays expired once an operation was bound `expired`) |
| `MCRequestCandidate.tla` | Entry module of variant A: `EXTENDS WorkflowV2RequestSpec57` and adds one witness predicate (`Wit_ObservedAfterExpiry`, decision D-REQ-1) |
| `WorkflowV2RequestSpecB.tla` | Variant B, the chosen intent (D-REQ-1, option B): after the durable expiry point, the controller's observation does not decide, and the elapse decides `timed_out` whatever its reading; it records its actual reading |
| `MCRequestBStrict.tla` | Strict witnesses for B: history variables only; closes two weaker witnesses |

Notes: `SPEC-CANDIDATE-2943167C.md` (variant A: design sections to model
elements, bounds, fairness, properties, open findings) and
`SPEC-CANDIDATE-B.md` (what B changes, invariants, the dispositions of the
findings F2 to F6, the configurations).

## 2. The code these models are bound to

The models read no product code: they are derived from the design text only.
The request runtime is a disabled foundation (see `../CODE-MODEL.md`), and the
code models of the request store are in `../` (`WorkflowV2RequestCode*.tla`,
bound to `packages/sdk/src/workflow/v2/store.ts` at `8021c75e` and `57fbb0d6`).
This folder's design pin is `docs/proposals/workflow-messaging-request.md` at
`2943167c1073d440faee9065982baef6f4104086`.

## 3. Case taxonomy and expected results

`hd` = expected to hold, `df` = deliberate fault, `as` = a check that removes a
property of B, `wit` = witness (expected violation that proves reachability).
`rq-*` are variant A (entry module `MCRequestCandidate`); `rqb-*` are variant B
(entry module `WorkflowV2RequestSpecB`, or `MCRequestBStrict`).

| Group | Cases | Expected |
|---|---|---|
| Holds | `rqb-hd-expiry-small`, `rqb-hd-wake`, `rqb-hd-liveness-small` (under `LiveSpecB`), `rqb-hd-decide-rollback`; the variant A copies `rq-hd-*` | PASS (complete searches only) |
| Faults (6) | `rqb-df-no-lock`, `-replay-first`, `-bind-on-deleted`, `-wake-separate`, `-no-token`, `-abandon-twice`; the A copies `rq-df-*` | the named property is violated |
| Witnesses | `rqb-wit-stale-holder`, `-abandoned-after-enqueue`, `-op-conflict`, `-closed-after-delete`, `-delivery-failed-after-deadline`, `-timed-out-while-paused`, `-timed-out-after-rollback`; the A copies `rq-wit-*` | reached |
| Strict witnesses | `rqb-wit-strict-op-conflict`, `rqb-wit-strict-elapsed-while-paused` | reached |
| Control | `rqb-as-raw-deadline`: Spec57's raw `Inv_Deadline` must fail under B with rollback (B keeps the actual reading and invents no time) | violated |
| A comparison | `rq-wit-observed-after-expiry`: the situation that B prevents | reached under A |

Bounds: `Deadline = 1`, `MaxTime = 2` (the last value stands for all later
time); operations `o1`, `o2`; result identities `X` and the decline; binding
limit 1 or 2 (50 in the design); attempt cap 1 or 2 (100 in the design); 0 to 2
dispatchers. Fairness `FairnessB`: weak on `Tick`, `Commit`, `ElapseB`,
`Resume` and the wake steps, strong on `Collect`. Liveness is claimed only with
a monotone clock. `cases.tsv` lists all 36 cases with their entry module;
`cases.json` has the expected result of each case.

## 4. Results

Recorded runs (TLC 2.19, `-workers 2`, `-Xmx2g`, deadlock check on, each case
run once), 2026-11-02. Model commits `71248816` and `4016d3f4`.

| Batch | Cases run | PASS | Expected violations | PARTIAL | VOID |
|---|---|---|---|---|---|
| Expiry | 4 | 1 (`rqb-hd-expiry-small`, 257,760 distinct states) | 3 (`rqb-wit-timed-out-after-rollback`, `rqb-as-raw-deadline`, `rq-wit-observed-after-expiry`) | 0 | 0 |
| Diagnostics | 12 | 0 | 12 (6 faults, 6 witnesses) | 0 | 0 |
| Holds | 3 | 3 (`rqb-hd-wake`, 1,838,944 distinct; `rqb-hd-liveness-small`, 362,080; `rqb-hd-decide-rollback`, 2,789,568) | 0 | 0 | 0 |
| Strict witnesses | 2 | 0 | 2 | 0 | 0 |
| **Total** | **21 of 36** | **4** | **17** | **0** | **0** |

Not run (15): the `rq-*` cases other than `rq-wit-observed-after-expiry`. Their
`rqb-*` copies were run on variant B; results of one variant do not transfer to
the other.

Remarks:

- All 6 faults were caught by the intended cause. Of the 6 witnesses, 4 reached
  the situation by the intended path. `rqb-wit-op-conflict` reached a conflict
  on an `expired` binding (not on a decided response) and
  `rqb-wit-timed-out-while-paused` a pause after the timeout; the strict
  witnesses (`MCRequestBStrict`) close both: an `OPERATION_CONFLICT` on a
  binding decided to the winning response, and an elapse that decides
  `timed_out` while the run is paused.
- In the expiry cases, TLC found the clock step back before the commit rather
  than after it; the durable `expired` binding exists before `ElapseB` or
  `Observe` decides in every trace, so the cause is the intended one.
- The three full holds pass at their bounds: `rqb-hd-wake` (1 operation, limit 1,
  attempt cap 2, 2 dispatchers, monotone clock; 9 invariants and 9 action
  properties), `rqb-hd-liveness-small` (`Live_Decides`, `Live_WakeSettles`,
  `Live_Collected`) and `rqb-hd-decide-rollback` (2 operations, limit 2, clock
  rollback; 8 invariants and 7 action properties, including
  `Inv_NoObserveAfterExpiry` and `Inv_DeadlineB`).
- Not established: request liveness beyond the bounds, wake races beyond the
  bounds, source conformance, native behavior or deployment. R57-1 (an unobserved
  deadline passage that the clock then takes back) is a stated limit.

## 5. How to run

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
`CHECK_DEADLOCK TRUE`: deadlock checking was on in all recorded runs. Comments
of `WorkflowV2RequestSpecB.tla` were edited to remove an internal reference; no
definition changed. `SHA256SUMS` pins every file named above. The settings files are generated from `cases.json` and
`tlc-templates.json` (`../../../tlc_cases.py`) and are not committed.
