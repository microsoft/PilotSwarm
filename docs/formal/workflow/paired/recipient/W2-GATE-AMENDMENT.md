# W2 gate row amendment and worker witness boundary

Source pins (read-only):

- **5df032f1:** the W2 orchestration.
- **22be2ba4:** 5df032f1 plus the native and UI slices.
- **009109e25f03ec46aee6152cfbe6c379563cf74d** (tree `007526fc`, on top of 22be2ba4): the worker witness fix. `git diff 5df032f1 009109e2 -- packages/sdk/src/orchestration_1_0_83/` is empty, so the code model `RecipientTurnCode` stays valid for this pin.

The recorded results are in `README.md`.

## 1. Worker witness boundary

The code models take the worker's witness as an input. The boundary
assumption **A-WITNESS** is now stated in the models:

- `sent: true` only if the model request with the items may have been issued.
- `sent: false` only if it was not issued.
- An adopted saved result keeps its own witness, or has none.

The model checks the orchestration under A-WITNESS. A-WITNESS itself is
checked at the source, not by TLC.

| Id | At 5df032f1 / 22be2ba4 | At 009109e2 |
|---|---|---|
| W2-WIT1 | `intakeSent = true` before `session.runTurn` (session-proxy 4560). The run can still return without a send: a missing required tool (managed-session 3345-3351) or a held Stop (3945-3951), both before the SDK send (3958). So the witness says `sent: true` for an unsent attempt. This breaks I9 at product level: a false `completed`, or `interrupted` instead of `not_dispatched`. **Needed a fix.** | `onBeforeInitialSend` is called right before the initial `copilotSession.send` (managed-session 3960), after both checks. Steer sends (1588) need the steer gate open, which happens after the first send. Corrective sends (3919) run inside the turn, after the first run. **Fixed in source by reading; native evidence pending.** |
| W2-WIT2 | `withIntakeWitness` synthesizes a missing witness on an adopted result from the current attempt (session-proxy 1657-1659, 4992). The current attempt's state is not the saved turn's. **Needed a fix.** | `adoptedSavedResult` (session-proxy 1824, 4991): an adopted result keeps its own witness or none. **Fixed in source by reading.** |

New candidates from that reading. Reachability is not confirmed; they are
open questions for the implementation.

- **W2-WIT3 (P2 candidate).** An invocation can be formed and carried on a retry that reuses a thrown turn key.
  - Sequence: turn T's first attempt carries nothing and throws after the worker committed. Before the retry, a new item is claimed. The retry's `beforeAttempt` forms, binds and carries the ready invocation (turn.ts 380). The key reuse is decided only after that (turn.ts 535). The worker preamble then adopts T's saved result (session-proxy 1809-1824), which has no witness. The orchestration reads that as possibly sent: row 9, `interrupted`.
  - Effect: conservative, no false `completed`. But the items end `interrupted` and are never shown to a model.
  - Suggested fix: decide key reuse before the carry, and do not carry an unsent invocation on an attempt that will adopt a saved turn.
  - Suggested regression: thrown-after-commit, then a claim, then the retry.
- **W2-WIT4 (P3 candidate, race).** A losing commit-race attempt that did send adopts the winner's witness (session-proxy 4987-4991).
  - If the winner carried the same invocation but reported `sent: false`, the actual send is hidden.
  - Suggested fix: if the adopted witness names this invocation, use `saved.sent || intakeSent`.
  - Reaching it needs two racing attempts with the same input and different held-Stop or required-tool outcomes.

The finding from the 5df032f1 checkpoint (O-W2-3, retry-count reset and key
reuse) stands unchanged.

## 2. The gate row: source premises (009109e2 = 5df032f1 orchestration)

| Premise | Source | Verdict |
|---|---|---|
| Gates run in the activity before any model send. A refusal is a `wait` result with `sent: false` | session-proxy 1865-1948, 1961-2030; send only after 3960 (009109e2) | confirmed |
| A refusal parks the unsent invocation for the gate and arms the gate's wait | intake-machine 927-938; turn.ts 1206, 1419-1437 | confirmed |
| A person's message ends a workspace wait | queue.ts 1115-1120 | confirmed |
| A person's message interrupts a budget wait. A gated interrupted wait is dropped after the turn, never re-armed | queue.ts 1032-1049; turn.ts 806-808 | confirmed |
| Queued interactive work releases a gated wait (saved as interrupted with its gate, dropped later) | queue.ts 534-541, 560-590 | confirmed |
| A ready child digest replaces a gated wait | queue.ts 1679 | confirmed |
| `retry_workspace` / `set_workspace` end the wait into the pending prompt (stimulus `other`, not `gate_retry`) | lifecycle.ts 963-971, 1149-1152 | confirmed |
| A gate-parked invocation starts no turn of its own | intake-machine 859-866 | confirmed |
| Only the wait's own fire is `gate_retry` | turn.ts 1688, 1810 | confirmed |

One correction to the alternative in the implementation's rationale. A pending-prompt turn
that passes the gates while the gate's wait **stays armed** does not strand
the invocation: the wait still fires a `gate_retry` turn later. That only
delays it. Stranding needs the wait ended. The progress predicate is
therefore "gate-parked, an attempt passed the gates since, **and the wait is
gone**". `Inv_C_GateParkClearedOnPass` in `RecipientTurnCode` is tightened the
same way. The first form of the predicate (without the wait condition) stays valid for
its own earlier run; it would also flag the delay-only case. In that run the
reported trace ended the wait (state 7: `gateWait = FALSE`), so it was the real
stranding shape.

Amendment after review of d229a253: the spec predicate also excludes any
active turn (current or held) that is eligible to carry the invocation. A
`gate_retry` turn that has consumed the wait but not yet attempted is
therefore not reported. In the code model, the raw invocation is unparked
when an attempt that carries it begins, so the code predicate already
excludes an attempt in flight. Under either rule, a pending or held retry
that is eligible to carry a gate park cannot coexist with `passed` (argued,
not checked).

## 3. Interpretation and proposed amendment

The design's current reasons for the resume rows:

- A parked invocation never starts a turn (I11).
- It rides "the gate's own retry attempt" for a gate.
- For the other causes, it rides a new stimulus, so "a lasting failure ... repeats only once per new stimulus, never on its own".

For a gate, the cause is outside the invocation: the refusal is session-wide,
costs no model call, and is re-decided by the worker inside every attempt
before any send. "The gate's own retry" was the attempt known to re-ask the
gate. In the code, **every** attempt re-asks it. The timer is one of several
events that end the gate's wait, and the others drop it without a retry.

Proposed gate row: *a gate-parked invocation rides any attempt; the worker
re-checks the gates in that attempt before any send; a refusal parks it
again; it starts no turn of its own.*

| Requirement | How the proposed row keeps it | Evidence |
|---|---|---|
| Permissions: no send past a closed gate | The worker checks both gates before the send callback | Source (A-GATE-FIRST, A-WITNESS at 009109e2); not a TLC claim |
| No own-turn spin | Unchanged I11: gate-parked is not `Ready` | `rtg-reval-safety` |
| I8 | Only unsent invocations park; the sent rows are unchanged | `rtg-reval-safety`, `rtcg-refines-reval` |
| I9, latched cancels | Rows unchanged | `rtg-reval-safety` |
| Progress | Any attempt that passes the gates carries it | `rtg-reval-safety` (`Inv_GateParkClearedOnPass`) against `rtg-timer-strand` |

My view: this clarifies the existing gate intent and adds no new product
semantics. So D-W2-2 can close as routine, on three conditions:

1. Design 5.5's gate row is reworded as above.
2. The bounded run confirms the expected outcomes (see `README.md`).
3. A-WITNESS holds at the pin used (009109e2).

The one visible change is which turn delivers the items after a gate: any
turn that passes, including an agent follow-up, not only the timer's. It is a
product decision whether that change is acceptable.

## 4. Models

| File | Role |
|---|---|
| `RecipientTurnSpecG.tla` | Amended-intent proposal (r3), self-contained. Gate environment made explicit; three-valued witness as in the design; `GateResume` switches between `timer_only` (current row) and `revalidated` (proposed). All r1 properties are unchanged; one progress predicate is added. r1 and R2 are kept unchanged beside it |
| `MCRecipientTurnGWitness.tla` | History wrapper (amended after review): a gate-parked invocation is completed, with the wait gone, by the turn whose start ended the wait, and that turn was not `gate_retry` (ghosts `waitEnder`, `doneByEnder`) |
| `RecipientTurnCodeG.tla` | Independent code comparison. Extends the unchanged code model (5df032f1 = 009109e2 orchestration) with a second mapping to `RecipientTurnSpecG`: `code` against `revalidated`, hypothetical `design` against `timer_only` |
| `RecipientTurnCode.tla` | Only change: the stranding predicate gains "and the wait is gone" (section 2) |

## 5. Limits

The models are a finite safety and refinement check under A-ATOMIC,
A-SCHED, A-RETRY, A-GATE, A-ONE and A-WITNESS.

- Progress is stated as a bounded safety predicate, not as liveness with fairness.
- Permissions and the witness are source obligations on the worker, not model results.
- The models give no TypeScript, native, W3 or activation result.
- W2-WIT3 and W2-WIT4 are candidates; their reachability has not been confirmed.

## 6. Status of the claims

- **A-RETRY is not shown to be a superset.** No mapping relates a per-turn retry cap to the global `retryCount` and `thrownTurnKey`. The O-W2-3 rerun risk lies outside the model. The module headers' word "superset" is withdrawn.
- **W2-WIT3 and W2-WIT4** stay candidates until causal reachability is shown. The W2-WIT4 fix `saved.sent || intakeSent` is only a hypothesis: whether the invocation was possibly sent and whether a durable winner result exists are separate questions.
- **R2 E1-E4 are explicit environment-assumption revisions.** The results of the r1 turn model stay separate.
- **A-WITNESS.** At 5df032f1 the worker witness was not truthful on every pre-send path (W2-WIT1, W2-WIT2). The code models' witness constraints are an assumption, not a source proof of I9 at 5df032f1. 009109e2 changes only the worker boundary.
