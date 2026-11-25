# Child Workflows: design check

This is a bounded design check for one parent and two child Workflows. It is
not a correspondence review of the shipping implementation.

**Revised design: PASS.** TLC finished at depth 45 with no errors or deadlocks:
11,922,657 states generated, 3,314,067 distinct, zero queued. The four companion
checks reached their intended witnesses. TLC reports exit 12 for those
deliberately false canaries; the safety run returned 0.

## Original design counterexample

The original model violated `NoRunningAfterCleanup`: 109 states generated,
76 distinct, with 33 queued at depth 7. The first violation stopped the
search. The exact failing model, config, and stdout are in [`original/`](original/).

1. The parent admits a spawn and dispatches its helper.
2. The helper commits the keyed child session claim. No child run exists yet.
3. The parent is cancelled (not deleted). Its cleanup finds no active child
   run and finishes.
4. The in-flight helper commits the child definition, active run and Start
   receipt. Cleanup has already returned. The helper can now dispatch the
   child controller; the invariant already fails at insertion.

This follows from the Start function and end-of-run cleanup design (see the
proposal's Components and Execution Sequences sections). Start creates the
child session row before inserting the child definition and live run row
(`admitted`). The saved-definition pin checks the definition owner (chat
session), not the spawning Workflow run (see the proposal's Data Model section).
Stopping an in-flight helper does not join an already-running database call, so
a live-parent check at session claim alone does not close the gap.

**Accepted fix:** In the transaction that inserts a *new* child run, lock and
verify that the spawning parent's live run is still active. The parent
terminal transition updates the same row before cleanup scans. If admission
wins, cleanup sees the active child (including status `admitted`); if
termination wins, admission writes no child run or receipt. The separate
session claim is harmless by itself. A matching receipt is returned first;
replay stays read-only even after the parent ends. A regression test should
pause Start after the session claim, cancel the parent, wait for cleanup, and
then resume Start.

## Model and receipt

One parent, two sequential spawn visits, and two child slots. A run can end
in either order; receive claims are FIFO by inbox insertion, not by spawn
order. `"running"` includes an active DB admission before controller start.
The model separates durable DB effects from controller starts, wakes, and
timer reads. Duplicate delivery uses two attempt generations per visit; a
stop can occur at each helper activity boundary, with one stop per visit.
The level check permits a same-level agent step but refuses a level-3
descendant. This is a safety check: it checks the availability of the timer
fallback, not eventual scheduling. It does not check message expiry,
authorization failures, payloads, or wall-clock duration.

```sh
java -Xmx1152m -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC -workers 2 -config ChildWorkflows.cfg ChildWorkflows.tla
for witness in duplicate stop out_of_order refused; do
  java -Xmx768m -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC -workers 1 \
    -config "ChildWorkflows_${witness}.cfg" ChildWorkflows.tla
done
```

| Witness | What the trace reaches | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| Duplicate | The spawn activity replays its Start receipt and stores the handle. | 2,312 | 1,238 | 11 |
| Worker stop | The worker stops after the run commit, then replays Start and stores the handle. | 2,280 | 1,224 | 11 |
| Out of order | Visit 2's child ends before visit 1's, and the parent receives both in that order. | 1,358,852 | 435,649 | 25 |
| Refused | The session is claimed, the parent ends, and admission refuses without a run or receipt. | 57 | 44 | 6 |

TLC 2.19 (`tla2tools.jar` v1.7.4), breadth-first search with deadlock checking
enabled. The main safety pass log is checked in as `ChildWorkflows.tlc.log`, and the
original failing counterexample run (exit 12) is checked in under `original/`.
