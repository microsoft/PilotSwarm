# Workflow parallel join model (k of n, timer)

`WorkflowParallel.tla` models one parallel state with the k-of-n join agreed
in the design decision of 2026-11-04 ("join k of n"):

- `join: all` (k = n, the default) or `join: { first: k }`;
- `failFast` as today;
- an optional `timeoutSeconds`: a durable timer from entry that races the join;
- outcomes `joined`, `blocked` or `timed_out`, exactly one decision per node;
- running branches cancelled after the decision (script effects asked to stop,
  agent children ended), queued branches `not_started`, finished outputs kept.

It is derived from that design first. The controller structure it follows is
controller 1.9.0 at `8d568890` (`R` = `packages/sdk/src/workflow/runtime.ts`,
`S` = `store.ts` at that commit): `startBranches`/`endBranch`/`joinIfDone`
(`R` 1222-1267), the pass order (`R` 1269-1630: admit every cursor, then
elapse due deadlines, then collect and route), `cancelBranches` (`R` 3998-4052),
the join activity (`R` 4054-4150), `cancelBranchScopes` (`S` 6104-6131) and
`enterScript` (`S` 3492-3507). Line numbers refer to `8d568890`. Every case
is pinned to the design (`head` = `design` in `cases.json`); the sections below
name the implementation head (J1b, J1d, J1e) each batch follows.

The orchestration models in `../orchestration/` already check the
all-required join of 8d568890 (`WfGraph`: fan-out, concurrency, failFast,
dropped results). This model adds k, the timer, the store-clock guard,
crash and retry of the decision and cancellation activities, continue-as-new
with a pending deadline, pause, and the stop of losing branches.

## Abstractions

- **One parallel state.** Each branch body is one work state (script or agent)
  and then its terminal. A branch ends `succeeded` when its terminal is
  admitted, or `failed` when its work's result has no route.
- **One deterministic controller.** It is in one step at a time. A replay is
  no step. Activities are transactions; the cancellation is its transaction
  and then the stop requests. A worker crash after a transaction, before the
  activity result is in history, runs the activity again (`MaxCrash`).
- **Pass order.** A pass admits every cursor before it elapses deadlines, so
  the timer fires only when no branch waits at an unadmitted state, unless the
  run is paused. Results collected in one batch are routed in any order.
- **Clocks.** Flags: `stTime` (the store's clock against the deadline) and
  `ctTime` (the controller's; ahead of the store's with `AllowSkew`). The
  numeric clock is checked for the wait state in `../WorkflowWait.tla`.
- **Paused.** The timer runs while paused, as a wait state's does (RT-6). A
  timeout decided while paused cancels the branches at once (`now`) or at the
  resume (`resume`); the implementation states which rule J1 implements.
- **Run end.** A cancel, deletion or the run's deadline decides every pending
  node in one transaction (`AllowRunEnd`); afterEnd then ends agent children.
  A failed end at that point is not modelled (orchestration `agent.end-fails`).
- **Agent children.** A child is not kept when its state was decided before
  the spawn (the end after a spawn of a10c2e07, checked in `WfAgent`).
- **Not modelled.** Compile-time checks (a literal forEach with fewer items
  than k, the required `timed_out` route), output schemas and size limits,
  the UI (J2), IR 9 refusal by older workers.

## Groups and bound code

| Group | Cases | Meaning |
|---|---|---|
| `par-safety` | 10 | The design's safety rules hold (expected PASS). |
| `par-live` | 10 | Every entered state is decided and routed; cancelled work stops (expected PASS). |
| `par-edge` | 3 | k > n at run time, n = 0 with all, n = 0 with first k (expected PASS). |
| `par-witness` | 14 | A behavior is reachable (expected safety FAIL of a W_ rule). |
| `par-fault` | 10 | A deliberate fault breaks its rule (expected FAIL). |
| `par-compare` | 4 | Controls and rule choices. |
| `par2-safety` | 8 | p2: the decided rules hold on J1's structure (expected PASS). |
| `par2-live` | 6 | p2: progress under the decided rules; a paused timeout stops work (expected PASS). |
| `par2-edge` | 3 | p2: n < k, n = 0 with all, n = 0 with first k under the decided rules (MF-P1 fixed). |
| `par2-witness` | 4 | p2: join due, commit-order winners, blocked at the time limit, timeout while paused. |
| `par2-compare` | 7 | p2: the p1 behavior, a terminal count, H1 (a winners-only join check), no join check, a swallowed child end, the resume rule. |
| `par3-pause` | 4 | p3: R2-RT-1, a pause committed while every cursor is pending. |
| `par4-owed` | 5 | p4: J1d, owed loser ends; the J1c fail-run comparison. |
| `par4-witness` | 2 | p4: an end is owed; an owed end is completed while paused. |
| `par5-owed` | 4 | p5: J1e, owed ends retried on every pass; a busy run (J1d-R1) and its J1d comparison. |

## p2: the decided rules (2026-11-04) on J1b's structure

`Rules = "decided"` adds the answers to the formal questions PJ-Q1 to PJ-Q3 of
the design; `Rules = "p1"` keeps the first design for the comparisons. Store time decides in both
directions: a branch's success counts when its work committed succeeded at
or before the deadline (`wAt = "before"`).

- **Timeout (PJ-Q1).** With k such branches it answers "join due" and decides
  nothing; the controller routes them and joins. `TimeoutCounts = "terminals"`
  counts admitted terminals instead (comparison).
- **Join (PJ-Q1).** After the deadline the join counts the same on-time work
  (`JoinCheck = "work"`), admitted or not, and joins with the first k of it;
  with fewer it decides timed_out. `"winners"` counts only the controller's
  admitted winners (hazard H1, comparison); `"none"` has no check.
- **Paused (PJ-Q2).** A timeout while paused cancels at once and routes on the
  resume.
- **Impossible (PJ-Q3).** Once k is impossible the outcome is blocked; a later
  time limit cancels the rest and keeps blocked with `timedOut`.
- **J1-R2 (J1b).** A failed child end fails the cancellation activity
  (`EndFailRetries`, at most `MaxEndFail` times); its retry enumerates the
  cancelled states again, so every losing child is ended before the route
  (`Inv_LoserEndedBeforeRoute`). At J1 the failure is swallowed
  (`cmp.par2-end-swallowed`).
- **Not modeled: J1-R1.** The timed-out report picks each branch's last state
  by a millisecond sort; the model has no report rows or timestamps.
- **J1b structure (f2aeeb25).** The store decides (`CancelFirst = FALSE`:
  decide, then cut). k is impossible by failures committed on time
  (`StoreImpossible`); a blocked verdict asked after the deadline without it
  is timed_out. The time limit's transaction cancels the running work
  (`StoreCutsOnTimeout`), also when it answers join due; after the time limit
  no new branch work starts. J1b joins only once the winners' terminals are
  admitted; the model joins at once with the same winners (same outcome).

`cases.tsv` lists every case; `BATCH=<p1..p5> python3 gen-cases.py` regenerates
the tables with a one-batch list. The settings files (`.cfg`) are generated from `cases.json` and `tlc-templates.json` (`../../tlc_cases.py`) and are not committed. The settings of the p1 batch also name
`Rules = "p1"`.

## p3: R2-RT-1, a pause committed while every cursor is pending

At 8d568890 and J1b the controller learns a pause only when the store refuses
a cursor's admission (`PauseSeen = "admission"`). With every cursor pending,
a branch result, a failFast cancellation or the parallel state's own result
is routed while paused (`Inv_NoRouteWhilePaused`). The fix (batch S) reads the
paused status at the collection (`PauseSeen = "collect"`, the setting of every
p1 and p2 case). 

## p4: J1d (874af832 on c4481682), owed loser ends

J1C-1: at J1c the cancellation activity retried a failed loser end for up to
half an hour and then failed the run (`EndBudget = "fail-run"`,
`cmp.par4-end-fail-run`). At J1d it tries each end once (`MaxEndFail = 0`) and
answers the branches still owed (`EndBudget = "owe"`, variable `owed`); the
controller goes on at once. `RetryOwed` tries an owed end again between the
controller's steps, running or paused; with `EndForever` every retry fails.
The run's end ends every owed child (`AfterEnd`).

- `Prop_JoinRouted`: a decided join is routed unless something outside the
  controller ended the run. `Prop_CommandTaken`: a queued cancel is taken
  (the controller is never held inside an activity's retries).
  `Prop_OwedEnded`: every owed end is completed in the end.
- `Inv_WinnersNeverCut`: a cut decides only work still running; a winner's
  work, stored succeeded, is never cut. J1d's race fix also changes which
  branches the `workflow.branches_cancelled` event names; the model has no
  events, so that part rests on J1d's race test.
- Not modeled: the backstop period that spaces the retries; recover (the
  model ends the run instead). In the model a script stops once its state is
  decided: its own liveness check (`EffStop`) usually stops it within about
  1 s. J1d's residual needs both that check and the cancel request to fail:
  the script then runs until recovery or its own timeout, which the model
  does not show. Its late result still loses the compare-and-swap
  (`EffFinish`).
- J1d-R1 (from an independent review): the owed retry runs only at the idle wait and
  in the paused collector (`RetryOwed`, as the code). A loop that never goes
  idle can starve it until a pause or the run's end; liveness here holds
  through `AfterEnd`. J1e's active-loop retry is for p5.

## p5: J1e (68079fed on f5751acc), owed ends retried on every pass

J1e calls `retryOwedCuts` at the top of every controller pass, busy or idle,
and at the first pass after continue-as-new (`RetryAt = "every-pass"`; the
backstop-period rate limit is unchanged and not modeled). J1d retried only at
the idle wait and in the paused collector (`RetryAt = "idle-paused"`, which
over-approximates them: it never includes a busy pass).

`BusyAfter` keeps the run busy after the route (`ctl = "busy"`): a ready result
in every pass, so the controller never idles, and the run does not end
(`AllowRunEnd = FALSE`). A pause during the busy phase is not modeled; under
J1d it would let the paused collector retry.

- `par5.busy-live`: J1e completes the owed end although the run stays busy
  (`Prop_OwedEnded`). `cmp.par5-busy-j1d`: J1d never retries it (J1d-R1).
  `Prop_Routed` is left out of the busy cases: its target names the control
  state, which the busy phase leaves (as MF-P4); `Prop_JoinRouted` counts the
  route instead.
- `par5.owed-safety`, `par5.owed-live`: the p4 settings with J1e's retry.
- `cmp.par2-end-swallowed` is rerun: its p2b match came through MF-P3.

## 6. Results

The cases ran on 2026-11-04 on an isolated machine (TLC 2.19, 2 workers), in batches
p1, p2b, p2c, p3, p4, p4b and p5. Together with the reminder's r1 batch (`../reminder/`) they
covered 112 cases: 110 as predicted, 55 PASS and 57 FAIL (expected violations included),
0 VOID. The mismatches were model errors (MF-P1: a fairness quantifier over an empty set;
MF-P2, MF-P3: rules too wide for the decided design); each was fixed and its cases re-ran in
p2c (15 of 15 PASS). The code findings H1, J1-R1, J1-R2, J1C-1 and R2-RT-1 were fixed in the code
(J1b to J1e, S-RT1) and their cases re-ran. The expected outcomes are in `cases.json` (94 cases
listed in `cases.tsv`: 52 PASS, 36 safety violation, 6 liveness violation). These are batch
runs; one complete run of all 94 cases with this folder's `run-tlc.sh` is not recorded. Two older settings
files (`wit.par2-checked-join`, `cmp.par2-late-join`) are not produced
by `gen-cases.py` any more and are not in `cases.tsv`; they belong to an earlier
form of the join check (PJ-Q1, PJ-Q4) and are kept for the record in
`cases-retired.json` (`python3 ../../tlc_cases.py gen --with-retired .` writes them). A case that
exceeds its time or memory cap is PARTIAL (VOID if it stops on an error),
never PASS.

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
`CHECK_DEADLOCK TRUE`. A TLC pass is a bounded check, not a proof. Comments of
`WorkflowParallel.tla` were edited to remove an internal reference; no
definition changed.
