# Workflow receive loop: bounded TLA+ model

## Transaction boundaries

Only committed state is visible. `Enter`, `Accept`, and `Fire` each represent
a separate transaction serialized by the run-row lock. The predecessor
child-workflow design specifies that the inbox write and delivery to a
waiting parent share a transaction. This model carries that boundary
forward to all matching contracts; it does not validate the merge base.

| Action | What commits together |
| --- | --- |
| `Enter(v)` | Check the entry receipt for logical visit `v`; record a new visit and set the total deadline only on the first loop entry. Write exactly one of: `exhausted`, immediate `elapsed`, the oldest matching inbox claim and its outcome, or a pending receive. |
| `Accept(m)` | Deduplicate by message ID and append a new message at the next sequence. Claim it and complete a matching pending visit in the same commit only if the deadline filter permits it. |
| `Fire(v)` | Check that the timer targets the same still-pending visit, then commit `elapsed`; do not claim a message. The clock can reach the deadline before this transaction runs. |
| `RetryEntry(v)`, `RetryAccept(m)` | Read the result of the committed operation without any durable mutation. Only a model observation flag can change. |

If a worker stops after inserting the message row but before completing the
pending receive inside `Accept`, no part of that transaction is committed.
A retry after rollback is the original action from the same committed state;
a retry after commit is a duplicate. The model does not assume that an
external wake-up or an activity acknowledgement commits with the database.

The **deadline filter** allows a matching arrival to complete a pending
receive only if it has no deadline or `now` is strictly before its deadline.
At or after the deadline, acceptance inserts the message unclaimed and leaves
the visit pending. A later timer step completes that visit as `elapsed`
without claiming the message.

## Code assumptions

- Preserve one acceptance transaction for inbox insertion, any consume mark,
  and completion of a matching pending visit. If there is a commit between
  them, the model does not cover it; a crash there needs durable repair.
- Check a stable logical visit receipt before changing the count or deadline
  anchor. Re-entering an old visit must not mutate the current one. Store the
  absolute total deadline when visit 1 enters. Every later visit uses that
  stored value without recomputing it.
- Check `exhausted` first, then return `elapsed` at entry if the total
  deadline has been reached, even when a matching message is already in the
  inbox. Only then look up the oldest matching unclaimed message. Use the same
  acceptance-order key for every contract in the set, and allocate it under
  the run lock, not from a pre-lock timestamp.
  A duplicate accept must not insert, claim again, or advance that order.
- Apply the deadline filter inside the acceptance transaction. A late timer
  must check the logical visit ID and require that visit to still be pending.
  No completion can overwrite a committed completion.
- This checks durable inbox delivery, not the later wake-up of a worker.
  Confirm the committed result can be discovered after a crash before that
  wake-up.

## Scope

This checks the receive loop against the reviewed deadline and entry rules.
`Enter` and `Accept` model the two inbox matches in the store. This is a
bounded model check, not a verification of the implementation.

One run has a single active receive at a time. State `L` receives `{P,E}`
with `maxVisits=2` and a one-tick total budget; state `O` receives the singleton
list `[Q]` and has one modeled visit. The scheduler can choose either state
when no visit is pending, including after an `elapsed` route. The model stops
entering `L` after its first `exhausted` result. Four message IDs (two `P`,
one `E`, one `Q`) can arrive in any order. Payloads, sender and correlation
filters, the legacy scalar-contract outcome, unrelated routes, and external
notification are out of scope.

The bounded clock runs from 0 to 2. Visit 1 can enter at tick 0 or 1 and sets
the deadline to its entry time plus one tick. State `O` has no deadline.
There is no time or scheduling fairness assumption. At every committed state,
`NoLostDelivery` checks that a still-eligible pending wait has no matching
unclaimed message. It permits a matching unclaimed message once the deadline
has been reached, even while the visit is still pending.

## TLC results

**Bounded PASS.** The main run generated 406,012 states, found 77,352
distinct states at depth 14, and emptied the queue with no errors or
unexpected deadlocks. The optimistic fingerprint collision estimate was
`1.4E-9`. Deadlock checking was enabled, with an explicit stutter allowed
in finished states. There are no extra state or action constraints, view
projections, symmetry reductions, or fairness constraints.

`SimplerLoops.cfg` checks typing, uniqueness on both sides of a claim,
contract outcome and membership, increasing take order per state,
exclusive limits, and no lost delivery. `CommitSafety` checks transitions
for oldest-eligible selection, durable receipt stability, unchanged durable
state on a retry, the fixed total deadline, and overdue entry behavior.
The negative-control action is disabled in the main run.

| Witness | Reachability config | Observed trace |
| --- | --- | --- |
| W1 | `NoPThenE` | First loop visit takes `P`; second takes `E`. |
| W2 | `NoArrival` | Acceptance of `E` before the deadline completes the waiting visit. |
| W3 | `NoEntryElapsed` | The second visit has an entry-time `elapsed` receipt and an eligible `P` is unclaimed. |
| W4 | `NoExhausted` | Third entry takes `exhausted` at the deadline even though a `P` is waiting. |
| W5 | `NoDuplicateEntry` | The same pending visit is entered again; the durable fields are unchanged. |
| W6 | `NoQWaiting` | A `Q` is accepted but left unclaimed while `{P,E}` is pending. |
| W7 | `NoDuplicateAccept` | Reaccepting the same `E` leaves the inbox and other durable fields unchanged. |
| W8 | `NoTimerElapsed` | The timer completes the pending visit; a later `E` remains unclaimed. |
| W9 | `NoLateArrivalThenTimer` | At the deadline, `E` is accepted and stays unclaimed while visit 1 is pending. The timer then completes visit 1 as `elapsed`. |
| W10 | `NoSpentEntryWithMessage` | An eligible `P` is already in the inbox when visit 2 enters at the stored deadline. Entry returns `elapsed` without a claim. |

Each reachability run stops when its intentionally negated invariant fails.
Those failures are expected, not failures of the design. All ten witnesses
were reached. None of the original eight became unreachable. W10 checks
the order that W3 alone does not require: the message precedes the entry.

**Negative control:** `SplitCommit.cfg` allows a matching insert to commit
on its own, then models the worker stopping without durable repair.
The trace shows `Enter(L1)` then `AcceptThenStop("e")`:
`L1` stays pending, `E` is unclaimed, and the deadline has not been reached.
`NoLostDelivery` fails at trace state 3. This is not a design
counterexample under the stated transaction boundary.

## Reproduce

The run used Temurin Java 21.0.13.1 and the `tla2tools.jar` asset of the
TLA+ v1.8.0 release. The jar reports TLC build `2026.11.19.180144`
(`bc1b506`); `run-tlc.sh` verifies its SHA-256. The runner uses breadth-first
model checking with one worker. `run-tlc.sh` produces `logs/` with commands,
action coverage, and traces. Point it at the downloaded jar using an
absolute path:

```bash
bash run-tlc.sh /absolute/path/to/tla2tools.jar
```
