# Workflow carry (FB-005): design model

`WorkflowCarry.tla` models opt-in per-state carry. It follows the design notes `valkyrie-workflow-loops-design.md`
(sha256 `bfb1ca31…`) and `fb005-carry-storage-design.md` (sha256 `cce4d9ad…`, base `d9ce57e0`): a nullable JSONB
`carry_snapshot` on `workflow_node_executions`, written once at admission. It is a design model; no implementation
exists yet.

## What it models

A state S declares `carry` and runs in `NB` branches, each with its own execution rows. It is visited `V` times in a loop:
S, then its successor, then S again. One visit:

1. **Evaluate.** The controller evaluates the carry selection against the arriving input and the pinned KV.
2. **Admit.** One transaction checks that the KV revision is still the evaluated one; if it moved (a `set_vars` race),
   the selection is evaluated again. It then writes the node with its snapshot, input and KV revision together.
   - A failed carry selection admits an immediate `invalid_input` with a null carry and no effect.
   - A failed input mapping after a valid selection keeps the snapshot with that failure.
3. **Effect.** The script, send or agent ends with a result or an error. The first result wins.
4. **Arrival.** The successor receives `{carry: <snapshot>, result: <result or error>}`.

A controller crash replays the enter activity: before the admission it runs again; after it, the existing row wins. A
cancellation stops admissions and routes. A late result is recorded and routes nothing.

A carry value is `<<branch, visit, kv>>`: whose arriving input it selected and the KV value it read. Payload byte limits
(64 KiB carry, 256 KiB combined) are checked by unit and integration tests, not here.

## Rules (the design's obligations)

| Obligation | Predicate |
|---|---|
| An admitted snapshot never changes | `Inv_SnapshotImmutable` |
| The successor's carry equals the source admission's snapshot; the current KV cannot alter it | `Inv_CarryIsAdmission` |
| No sibling's snapshot appears (and no other visit's) | `Inv_NoSiblingCarry` |
| The runtime error is preserved, and still arrives with its carry | `Inv_CarryOnError` |
| No effect before a valid admission with its snapshot | `Inv_NoEffectBeforeAdmit` |
| A failed carry selection admits no effect | `Inv_FailedCarryNoEffect` |
| The legacy route shape is unchanged (no carry: no snapshot, raw result) | `Inv_LegacyShape` |
| Controller 1.0.0 (gate `carry` off) routes raw results and writes no snapshot, even when the IR declares carry | `Inv_GateHolds` |
| Every visit arrives unless the run is cancelled | `Prop_Progresses` |

## Cases (batches ca1, 15, and ca2, 2; the ca2 packet runs all 17)

ca2 adds Ace's version plan: one controller registered at 1.0.0 and 1.1.0, `workflowControllerFeatures(version).carry`
false at 1.0.0 (`Gate`). Carry applies only where the IR declares it and the gate is on (`Carry == OptIn /\ Gate`).

| Group | Cases | Expected |
|---|---|---|
| design | `ca.design`, `ca.design-carry-fails`, `ca.design-input-fails`, `ca.legacy`, `ca.live` | PASS |
| fault | `fault.ca-reeval-at-completion` (`Inv_CarryIsAdmission`), `fault.ca-non-atomic` (`Inv_NoEffectBeforeAdmit`), `fault.ca-non-atomic-changes` (`Inv_SnapshotImmutable`), `fault.ca-shared-carry` (`Inv_NoSiblingCarry`), `fault.ca-reeval-on-replay` (`Inv_SnapshotImmutable`), `fault.ca-legacy-on-error` (`Inv_CarryOnError`), `fault.ca-failed-carry-effect` (`Inv_FailedCarryNoEffect`) | violation |
| witness | `wit.ca-carried-error`, `wit.ca-kv-changed-after-admission`, `wit.ca-invalid-with-snapshot` | violation (reachable) |
| ca2 | `ca2.gate-off` (PASS); `fault.ca2-gate-ignored` (`Inv_GateHolds`) | as stated |

The faults include the design's three required negative mutants: re-evaluating at completion, non-atomic admission,
and a shared cross-branch carry. `fault.ca-legacy-on-error` is today's behaviour, the motivation of FB-005.

## Code binding

`CORRESPONDENCE-1a6f582f.md` maps the model to Valkyrie's final commit `1a6f582f`, the same change as `aa0c4226`, rebased
onto `8409e475`. The correspondence holds, and no TLC re-run is needed. The mixed-worker gap is settled by the version
plan's stop-all deployment.

## Not modelled

- Payload sizes.
- The parallel state's own outer carry, separately from the branch states' carry.
- The successor's input schema.
- Nested routes inside a branch.
- A changed duplicate admission's refusal (`NONDETERMINISTIC_ADMISSION`): the model keeps the existing row, which is
  the outcome either way.

## Results

| Batch | Run | Result |
|---|---|---|
| ca1 | 2026-11-12 03:24Z, TLC 2.19, two workers, 600 s per case | 15 of 15 as expected; largest 17,796 states, depth 24-25 |
| ca2 | 2026-11-12 03:4xZ, as ca1 | 17 of 17 as expected; `ca2.gate-off` 17,796 states; `fault.ca2-gate-ignored` violates `Inv_GateHolds` in 3 steps |
