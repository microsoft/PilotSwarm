# Workflow receive loop: bounded TLA+ model

## Transaction boundaries

Only committed state is visible. `Enter`, `Accept`, and `Fire` each represent
a separate transaction serialized by the run-row lock. The predecessor
child-workflow design specifies that the inbox write and delivery to a
waiting parent share a transaction. This model carries that boundary
forward to all matching contracts; it does not validate the merge base.

| Action | What commits together |
| --- | --- |
| `Enter(v)` | Check the entry receipt for logical visit `v`; on the first entry, record the visit (and start the loop clock if needed), then write exactly one of: `exhausted`, immediate `elapsed`, the oldest matching inbox claim and its outcome, or a pending receive. |
| `Accept(m)` | Deduplicate by message ID, append the accepted message at the next sequence, and, if it matches the active pending receive, claim it and complete that visit in the same commit. Otherwise leave the message unclaimed. |
| `Fire(v)` | Check that the timer targets the same still-pending visit, then commit `elapsed`; do not claim a message. The clock can reach the deadline before this transaction runs. |
| `RetryEntry(v)`, `RetryAccept(m)` | Read the result of the committed operation without any durable mutation. Only a model observation flag can change. |

If a worker stops after inserting the message row but before completing the
pending receive inside `Accept`, no part of that transaction is committed.
A retry after rollback is the original action from the same committed state;
a retry after commit is a duplicate. The model does not assume that an
external wake-up or an activity acknowledgement commits with the database.

## assumptionsToCheck

- Preserve one acceptance transaction for inbox insertion, any consume mark,
  and completion of a matching pending visit. If there is a commit between
  them, the model does not cover it; a crash there needs durable repair.
- Check a stable logical visit receipt before changing the count or deadline
  anchor. Re-entering an old visit must not mutate the current one. The first
  committed loop entry starts the deadline exactly once.
- Keep the ordering `exhausted` before overdue entry `elapsed` before inbox
  lookup. Use the same acceptance-order key for every contract in the set,
  and allocate it under the run lock, not from a pre-lock timestamp.
  A duplicate accept must not insert, claim again, or advance that order.
- A pending visit can still take a matching arrival after the clock reaches
  its deadline if the timer completion has not yet committed. Once either
  completion commits, the other cannot overwrite it. Confirm the intended
  boundary and that a late timer checks the logical visit ID.
- This checks durable inbox delivery, not the later wake-up of a worker.
  Confirm the committed result can be discovered after a crash before that
  wake-up.

## Scope

This checks the design in sections 2 and 3 of *One-pager: fewer bookkeeping
states in Workflow loops* (25 November 2026; design base `263169efe`),
changes A, C1 and C2 only. The design maps `Enter` and `Accept` to the two
inbox matches in the store and maps the limits to the store's entry step.
Product code has not been matched to these actions.

One run has a single active receive at a time. State `L` receives `{P,E}`
with `maxVisits=2` and a one-tick total budget; state `O` receives the singleton
list `[Q]` and has one modeled visit. The scheduler can choose either state
when no visit is pending, including after an `elapsed` route. The model stops
entering `L` after its first `exhausted` result. Four message IDs (two `P`,
one `E`, one `Q`) can arrive in any order. Payloads, sender and correlation
filters, the legacy scalar-contract outcome, unrelated routes, and external
notification are out of scope.

The deadline is represented by one clock tick after the first loop entry.
There is no time or scheduling fairness assumption. A timer completion only
applies to the pending visit it names. Every modeled state is a committed
boundary, so `NoLostDelivery` checks **every** pending state, not just final
states or those where input has stopped.

## TLC results

**Bounded PASS.** The main run generated 107,351 states, found 21,035
distinct states at depth 13, and emptied the queue with no errors or
unexpected deadlocks. The optimistic fingerprint collision estimate was
`9.8E-11`. Deadlock checking was enabled, with an explicit stutter allowed
in finished states. There are no extra state or action constraints, view
projections, symmetry reductions, or fairness constraints.

`SimplerLoops.cfg` checks typing, uniqueness on both sides of a claim,
contract outcome and membership, increasing take order per state,
exclusive limits, and no lost delivery. `CommitSafety` checks transitions
for oldest-eligible selection, durable receipt stability, unchanged durable
state on a retry, and overdue entry behavior. `logs/main.log` includes
action coverage. The negative-control action is disabled in the main run.

| Reachability config | Observed trace |
| --- | --- |
| `NoPThenE` | First loop visit takes `P`; second takes `E`. |
| `NoArrival` | First loop visit waits; acceptance of `E` immediately completes it. |
| `NoEntryElapsed` | Second entry takes `elapsed` at the shared deadline and leaves an eligible `P` waiting. |
| `NoExhausted` | Third entry takes `exhausted` even though the deadline passed and a `P` is waiting. |
| `NoDuplicateEntry` | The same pending visit is entered again; the durable fields are unchanged. |
| `NoQWaiting` | A `Q` is accepted but left unclaimed while `{P,E}` is pending. |
| `NoDuplicateAccept` | Reaccepting the same `E` leaves the inbox and other durable fields unchanged. |
| `NoTimerElapsed` | The timer completes the pending visit; a later `E` remains unclaimed. |

Each reachability run stops when its intentionally negated invariant fails.
Those failures are expected, not failures of the design. All eight
witness traces are in `logs/`.

**Negative control:** `SplitCommit.cfg` allows a matching insert to commit
on its own, then models the worker stopping without durable repair.
`logs/split-commit.log` shows `Enter(L1)` then `AcceptThenStop("e")`:
`L1` stays pending, `E` is unclaimed, and the deadline has not passed.
`NoLostDelivery` fails at trace state 3. This is not a design
counterexample under the stated transaction boundary.

## Reproduce

The run used Temurin Java 21.0.13.1 in an isolated work pod and the
`tla2tools.jar` asset of the
[TLA+ v1.8.0 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0),
downloaded 25 November 2026. The jar reports TLC build
`2026.11.19.180144` (`bc1b506`); `run-tlc.sh` pins its SHA-256. The runner
uses breadth-first model checking with one worker and saves every command
and trace. Point it at the downloaded jar using an absolute path:

```bash
bash run-tlc.sh /absolute/path/to/tla2tools.jar
```
