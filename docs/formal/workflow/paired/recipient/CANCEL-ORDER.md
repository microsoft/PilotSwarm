# Cancel-order amendment: latch before eviction or consumption

This is a small, separate amendment to the recipient intake models
(`RecipientIntakeSpec`, `RecipientIntakeCode`, `README.md`). The proofs of
`ric-hd-refines` at 66739e07 do not cover the drain's tombstone ordering at
b92ff04b. Of the two hypothetical concurrent-caller cases, `ric-as-concurrent-done`
fails as expected; `ric-as-concurrent-end` is a separate comparison.

## The obligation and the environment

**Domain obligation (intent).** The first time a tombstone names a copy, the
cancel is latched in the carried state. Only after that may the tombstone
leave the bounded cancel set, whether it is evicted or consumed by an ordinary
prompt. Sources: design 5.5, "Latched cancels"; the wiring obligation in the
review of 813de112.

**Independent safety predicate.** `Inv_NoCancelLost`. No tombstone has ever
left the set, or failed to enter it, while a copy it names was present,
latchable (unclaimed, held, or an invocation item that may still be latched)
and not latched. The ghosts `lost` and `flost` record this the moment it
happens. The predicate does not use the intent's guard, so the same predicate
is checked on the intent model and on the b92 code model.

**Environment assumptions.** Each one is a constant in the b92 model, so
every result names the assumptions it needs.

| Id | Assumption | Constant |
|---|---|---|
| E-ID | An ordinary prompt may carry any client id, including an intake copy's canonical id (ids are untrusted text). | `AllowOrdinary` |
| E-BIG | One `cancelPending` may carry more than 200 ids. | `AllowBig` |
| E-WIN | The recent-id window forgets an id after 20 others. | `AllowForget` |
| E-PASS | A drain pass's stash and pending ids end with the pass. | the `DrainEnd` action |

Not an obligation: an ordinary prompt can consume a tombstone *before* any
intake copy that it names is present. The shared cancel set is first come,
first served. That copy is then claimed with no tombstone, and nothing was
latched or lost.

## Intent amendment `RecipientCancelOrderSpec.tla`

The module `EXTENDS RecipientIntakeSpec` (r3, unchanged).

- `OtherNext` copies r3's `Next`, disjunct for disjunct, without `TombDrop`.
- `TombDropCO(c)` is `TombDrop(c)`, guarded by the obligation when
  `Obligation = TRUE`: no present, latchable, unlatched copy is named by `c`.
  The guard updates the ghosts.
- `Obligation = FALSE` restores r3's unguarded drop. This is the negative
  control: it shows the predicate is not implied by r3.
- Every r3 invariant, property and fairness condition is reused unchanged:
  `LiveSpecCO` uses r3's `Fairness`.

## b92 code model `RecipientCancelOrderB92.tla`

The model instantiates `RecipientIntakeCode` (`C`) unchanged with
`Wiring = "serialized"` and `LatchFirst = TRUE`. It replaces the free
`TombArrive`, `TombDrop` and `LatchCancels` with the queue branches in their
real order. All sources are at b92ff04b.

| Source | Model |
|---|---|
| `queue.ts` 830-838 (drain), 1198-1200 (sweep): `addCancelledMessageIds`; `state.ts` 486-494: skip an id already present, add it, and evict the oldest beyond 200 | `CancelAdd(c, big, evictSelf, E)`. Without E-BIG, `c` is added. With E-BIG, the message's later ids may evict `c` (`evictSelf`). In insertion order that also evicts every older id. Otherwise `E` older ids are evicted. |
| `queue.ts` 842-851, 1203-1211: stashed prompts whose ids meet this pass's (drain) or this message's (sweep) cancels are dropped; `dropCancelledPrompt` (`lifecycle.ts` 414-421) deletes their ids from the set | `CancelConsume`: `ordStash ∩ passCan` leave the stash and the set. Using this pass's set for the sweep is an over-approximation. |
| `queue.ts` 854, 1215: `latchIntakeTombstones` | `CancelLatch`: the code model's `LatchCancels` over the ids still in the set, or nothing |
| `queue.ts` 958-964: an ordinary prompt whose id is in the set is dropped (consumption) | `OrdArrive(c)` when `c` is in `tombs` |
| `queue.ts` 966-970 (`duplicateClientMessageIds` 400-408): an id in the window or pending in this pass is a duplicate | `OrdArrive(c)` is not enabled for it; a duplicate changes nothing |
| `queue.ts` 882-887; `intake-wiring.ts` 248: the intake path ignores the window; once held, the canonical id enters the window | `C!Arrive`; `ClaimOkB` adds the id to `window` |
| One message at a time: no dequeue while a claim's activity is awaited | `NoClaimInFlight` guards `OrdArrive`, `CancelAdd` and `DrainEnd`; `stage` makes add, consume and latch one uninterrupted branch |

Not modeled:

- forming, binding, carrying and attempts (not wired at b92ff04b;
  `WithInvocation = FALSE` in every configuration below);
- `dropConvertedMessages`, which may evict older ids, already latched at
  their own arrival;
- prompts in the FIFO, which `decide` consumes only after that cancel's latch;
- a second ordinary prompt with the same id in a later pass. The model allows
  it because it does not update the window when an ordinary prompt is
  dispatched. This over-approximates arrivals, and no predicted trace uses it.

**Reachability of the consumption trace.** In one drain pass:

1. An ordinary prompt with id X arrives. X is not in the window, so the
   prompt is stashed and X becomes pending.
2. The intake copy whose canonical id is X arrives. The intake path does not
   consult the window or the pending ids, so the copy is claimed and held, and
   X enters the window.
3. `cancelPending [X]` arrives. X is added. The stashed prompt is dropped,
   which consumes X. The latch then finds no X.

The other order (held first, then the ordinary prompt) is a duplicate while X
is in the window. It is reachable only after E-WIN. Drain keeps collecting in
one pass until the queue is empty (`queue.ts`, "the 10 ms sweep below keeps
collecting"). The trace therefore needs E-ID and E-PASS, and nothing that the
window dedup forbids.

## Configurations (7 new, none run)

| Configuration | Module | Constants | Expected |
|---|---|---|---|
| `rco-spec-hd-safety` | `RecipientCancelOrderSpec` | `Obligation = TRUE` | PASS: r3's 6 invariants and 4 properties, plus `Inv_NoCancelLost` |
| `rco-spec-as-unguarded` | `RecipientCancelOrderSpec` | `Obligation = FALSE` | `Inv_NoCancelLost` violated: Arrive e1, ClaimOk (held), TombArrive e1, TombDrop e1 |
| `rco-spec-hd-liveness` | `RecipientCancelOrderSpec` | `Obligation = TRUE`, `LiveSpecCO` | PASS: `Live_LatchRecorded` |
| `rco-spec-wit-drop-after-latch` | `RecipientCancelOrderSpec` | `Obligation = TRUE` | `Wit_DropAfterLatch` violated (a guarded drop still happens) |
| `rco-b92-consume` | `RecipientCancelOrderB92` | E-ID only | `Inv_NoCancelLost` violated, 6 states: OrdArrive(e1), Arrive e1, ClaimOkB e1, CancelAdd(e1), CancelConsume |
| `rco-b92-big` | `RecipientCancelOrderB92` | E-BIG only | `Inv_NoCancelLost` violated, 4 states: Arrive e1, ClaimOkB e1, CancelAdd(e1, big, evictSelf) |
| `rco-b92-wit-latched` | `RecipientCancelOrderB92` | no E-ID, no E-BIG | `Wit_B92Latched` violated (positive control: the branch latches): Arrive e1, ClaimOkB, CancelAdd, CancelConsume, CancelLatch |

The configurations of this amendment: 2 expected to hold, 1 removes the
obligation in the intent, 2 are environment-enabled failures of the b92 code,
2 are witnesses.

No configuration is meant to show that b92ff04b holds. A cancel-branch
configuration that should hold belongs to the corrected code (`RecipientCancelOrder22A`).

## Limits

- Bounds are 2 exchanges and 1 forged copy. The intent keeps r3's single
  tombstone slot. The b92 model allows both ids to be in the set, and tracks
  eviction only through E-BIG.
- `>200` is abstracted to "the message's own later ids evict `c`" (and every
  older id). Other id values are not modeled.
- The b92 model reads the source as written. Nothing executes
  TypeScript.
- The b92 model has no refinement to the amended intent. The predicate is
  checked directly on both models.
