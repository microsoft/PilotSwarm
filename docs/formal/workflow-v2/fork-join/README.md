# Workflow V2 fork + join: formal models (option A, named branches)

These models check the design of a Workflow V2 fork + join before and while it
is implemented. The method has three parts: an abstract model of the intended
specification, a detailed design model that must refine it, and a comparison
model of the token design. The detailed model is then bound to the
implementation. A TLC pass is a bounded check, not a proof.

## 1. What the models cover

| Module | What it is |
|---|---|
| `AbsForkJoin.tla` | The intended specification for one fork visit: named branches queued, running, succeeded or failed; one decision (joined with k winners, blocked, timed_out, cancelled); the rest dropped (cancelled, late, not_started). |
| `WfForkJoin.tla` | Option A as designed and as implemented: a fork state with NB named branches, each with its own small body graph (one state, two states, a branch-local error route, a loop), script or agent states, the join of all or of the first k, failFast, a time limit with join due, the store's one count in commit order, the losers' cut and their stop requests, worker crashes, pause, graceful stop, cancel now, the node limit, the entry error, the stop fence after an accepted stop (NB-R2) and the one-transaction join (NB-R5). |
| `WfForkTokens.tla` | Option B: a fork in a transition and a free join node, run with tokens; its hazards. The same graphs with `Sem = "compiled"` are option C (the arrow sugar compiled to named branches), with option C's compile check `CValid`; on accepted graphs it refines `AbsForkJoin`. |

Design assumptions the models make explicit:

- n is static in option A, so k > n is a compile error (no "blocked at entry").
- A first-k join passes `{ name: output }` of the k winners only; the report
  lists every branch once.
- A branch ending after the time limit is reported `late` and does not count.

## 2. The code these models are bound to

The detailed model is bound to the named-branches head
`e76a6133` (on `bb9a6022`). Its line numbers are taken at the fix head
`cf2a31416d339eec6fae72f4ff66fe56999cd082`: for every modelled state the engine
code is identical at `cf2a3141`, `571ed468`, `afe2c822` and `e76a6133` (the
commits after `cf2a3141` change only tests, wording and the cut event's branch
labels). The line-by-line mapping of each model action to the code is
`CORRESPONDENCE-cf2a3141.md`.

| Model part | Code (`packages/sdk/src/workflow/v2/`, lines at `cf2a3141`) |
|---|---|
| Branch start, initials, ordinal keys, scope per branch | `runtime.ts` 1453 `startBranches`, 629 `parallelBranchInitial`, 643 `namedForkValid`, 1741-1790 (`enter`); `parallel.ts` 12 |
| Entry error (`EntryErr`) | `runtime.ts` 3758-3780 (branch inputs and `inputSchema`; `invalid_input`) |
| Refusal past the time limit (`AdmitRefusedPast`) | `store.ts` 3587-3599; `runtime.ts` 1768, 1618 `cutBranch` |
| Verdict, winners, one count in commit order | `parallel.ts` 183, 243, 268, 323; `store.ts` 6909 `elapseParallelNode`, 6963 `decideParallelJoin`, 7000 `settleParallelIn`, 7064 `parallelBranchesIn` |
| Stop fence (`StopFence`, NB-R2) | `store.ts` 7012 (a named fork is held once a stop is accepted), 6932 |
| Join in the store (`AllJoinPath`, NB-R5) | `runtime.ts` 1480 `storeJoins`, 5268 (join activity) |
| Cut and stop requests | `store.ts` 6849 `cancelBranchScopes`, 7122 `cancelBranchWorkIn`; `runtime.ts` 1537 `cutBranches` |
| Routes, catch-all, stop, cancel, pause | `runtime.ts` 2012-2050 `selectRoute`, 3303 `stoppingRefusal`, 1113 `applyCommand`, 2943 `endWorkflowV2RunAgents`, 1637 `pausedPass`, 1604 `askTimedJoins`; `compiler.ts` 1248 (a fork with `timeoutSeconds` must route `timed_out`) |
| Unbounded branch warning (FJ-S11) | `compiler.ts` 1363 `WORKFLOW_BRANCH_UNBOUNDED` |

The design investigation of the fork + join (`b236778a`) and the For each
implementation that option A reuses are the sources. Reused modelling:
`../parallel/WorkflowV2Parallel.tla` (activity split, crash, cut and stop
requests, pause) and `../orchestration/WfGraph.tla` (node executions, cursors,
routes, catch-all, node limit, stop, cancel).

Two code findings came from a code review of `3f3e96fb`, and the model now
covers both. The constants `StopFence` and `AllJoinPath` select the rule (the
default, matching `cf2a3141`) or the earlier code:

- NB-R2: after an accepted graceful stop, the fork's join and time limit still
  decided, cut started work and wrote a report. Rule: a named fork settles
  nothing after an accepted stop (`Inv_NoSettleAfterStop`). The first models
  missed this because their stop rule covered only the stop's own transaction
  (MF-FJ2).
- NB-R5: join all with failFast and no time limit cut the other branches in one
  transaction and decided the fork in a later one. Rule: verdict, cut and
  decision in one store transaction (`Inv_CutOnlyWithDecision`).

Model simplification: when the store refuses to settle after a stop, the
model's controller learns the stop at once; the code's controller learns it at
its next refused admission, and its timer waits until the stop's deadline.

## 3. Case taxonomy and expected results

`cases.tsv` lists all 91 cases; `cases.json` gives each case its group, its
invariants and properties, its expected result (`PASS`, or `VIOLATION:<rule>`)
and whether TLC checks deadlock (`CHECK_DEADLOCK TRUE` in 64 settings files,
`FALSE` in 27). 48 cases are expected to pass and 43 to violate a named rule.

| Group | Cases | Meaning |
|---|---|---|
| `abs` | 4 | The specification itself holds. |
| `a-safety` | 10 | Option A's safety rules hold. |
| `a-refine` | 3 | `WfForkJoin` refines `AbsForkJoin`. |
| `a-live` | 5 | Progress under stated fairness; the stop case checks only stop-conditioned properties. |
| `a-cmp` | 1 | A design-true limit (FJ-S11): a branch that never ends and no time limit. |
| `a-wit` | 15 | Reachability: each witness is violated. |
| `a-fault` | 13 | Each rule must catch its deliberate fault. |
| `impl`, `impl-wit` | 14, 2 | Implementation-shaped cases: refusal past the time limit, the entry error, the NB-R2 stop fence and the NB-R5 one-transaction join, with refinement and liveness. |
| `impl-fault` | 2 | The code before the fix: `fault.impl-r2-stop-settles` must violate `Inv_NoSettleAfterStop`; `fault.impl-r5-two-step` must violate `Inv_CutOnlyWithDecision`. |
| `b-safety`, `b-live`, `b-hazard` | 2, 1, 9 | Option B: a well-formed fork holds; each hazard shows an expected violation. |
| `c-compile`, `c-refine`, `c-live`, `c-wit` | 5, 3, 1, 1 | Option C: the compile check, refinement of `AbsForkJoin`, liveness and a witness. |

The compile rule of a fork's routes is an assumption of the model: joined and
blocked need routes, and with a time limit `timed_out` needs its route; the
catch-all is checked with the entry error.

## 4. Results

Recorded runs (TLC 2.19, `-workers 2`, a limit of 300 s per case):

| Batch | Date | Cases | As expected | Other | Notes |
|---|---|---|---|---|---|
| fj1 | 2026-11-08 | 73 | 72 | 1 mismatch | A case error, not a design defect (MF-FJ1): `l.stop-hang` checked properties that need a stop, but a stop is the environment's choice. |
| fj2 | 2026-11-08 | 84 | 83 | 1 PARTIAL | `impl.past-cut-live` reached the 300 s limit with no violation found. |
| fj3 | 2026-11-08 | 91 | 91 | none | The current cases, bound to `e76a6133`. 48 PASS, 43 expected violations, 0 PARTIAL, 0 VOID. Largest case 1,978,580 states; longest 75 s. |

fj3 is the run of the files in this folder. `impl.past-cut-live` was resized
for it (one two-state branch, node limit 6): it still reaches a work state
refused past the deadline, and passed in 75 s (25,732 distinct states).

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
PASS); other codes are setup or model errors. Each settings file states
`CHECK_DEADLOCK` explicitly.
`gen-cases.py` regenerates `cases.tsv`, `cases.json` and `tlc-templates.json`. The settings files (`.cfg`) are generated from `cases.json` and `tlc-templates.json` (`../../tlc_cases.py`) and are not committed.
Comments of `AbsForkJoin.tla`, `WfForkJoin.tla` and `WfForkTokens.tla` were
edited to remove internal references; no definition changed.
