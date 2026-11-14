# WorkflowCarry correspondence to 004eff4e

Code at `004eff4e`, Ace's batch-2 integration head (`waldemort/fb-batch-2`, controller 1.1.0 with carry and approval).
The carry code merged from Valkyrie's final commit `1a6f582f`:
- `carry.ts` is byte-identical.
- The cited regions of `runtime.ts` and `store.ts` are identical in content; only their line numbers moved.
- The gate's feature map moved from `runtime.ts` to `controller-features.ts`, where `carry: true` is at line 20, for
  1.1.0 only.
- An approval state refuses `carry` at compile time (`b9f7b92f`).

Earlier bindings: `ad2bb3cf`, `b86525b3`, `aa0c4226`, `1a6f582f`. Line numbers are at `004eff4e`. Storage is a nullable
TEXT `carry_snapshot`, not JSONB, so that NUL and lone-surrogate strings survive (`fb005-carry-storage-correction.md`).
The model does not depend on the column type.

| Model | Code at 004eff4e |
|---|---|
| `Carry == OptIn /\ Gate` | `controller-features.ts` 20 (`carry: true` at 1.1.0; 1.0.0 has no features). The entry checks `workflowControllerFeatures(current.controllerVersion).carry` and the IR's `node.carry` (`runtime.ts` 3516). The arrival checks `run.controllerVersion` and the predecessor's `carry` (3366). A null controller version means no carry |
| `Eval` | `runtime.ts` 3516-3522: `evaluateCarry(node.carry, scopeFor(current, arrived.incoming, …, kv, branch))` (`carry.ts` 12), before the `input:` mapping (3524). A failed selection sets an immediate `invalid_input` (`CarryFail`) |
| `Admit` and the KV race | `runtime.ts` 3494: the evaluation loop. A `kv_changed` refusal evaluates carry and input again. `store.ts` 3777: the snapshot is canonicalized. 4008 and 4020: written as `carry_snapshot` in the same INSERT as the input and the KV revision. An input-mapping failure after a valid selection keeps `carryText` with the immediate failure (`InputFail`) |
| Replay (the existing row wins) | `store.ts` 3790-3797: an existing node is returned as stored. On the same KV basis, a different snapshot raises `NONDETERMINISTIC_ADMISSION`. No statement updates `carry_snapshot` |
| `Arrive` | `runtime.ts` 3366-3371: `carryArrival(predecessor.carrySnapshot, result)` (`carry.ts` 24) for a business result and a runtime error alike; `runtimeError` stays the raw error. The snapshot is read from the row (`store.ts` 575, `readCarrySnapshot`, `carry.ts` 16), never evaluated again |
| Keys per execution row (`SharedCarry = FALSE`) | The column is on `workflow_node_executions`, one per node execution. A parallel branch's first state takes its manifest item (unchanged), and a parallel state's own snapshot reaches its outer successor |
| Migration | `cms-migrations.ts` 425 registers 0090 `workflow_carry` (`migrations/workflow-carry-0090.ts`): `ADD COLUMN IF NOT EXISTS carry_snapshot TEXT`, `lock_timeout` 5 s |

Not modelled, and one gap:

- The 64 KiB and 256 KiB limits are covered by tests, not by the model.
- **Gap: mixed worker versions.** The carry is in the existing `workflow.enter` activity (`runtime.ts` 254), changed in
  place. It is routed by the workflow-request capability tag (`storeTagged`), which workers without this code also
  carry, not by controller version. During a rolling deploy, a worker without this code can run `workflow.enter` for a
  1.1.0 run. It then writes no snapshot and routes the raw result. The model has one code version.
- This needs either a new or tagged activity, or a deployment rule that the 1.1.0 carry gate is in use only once every
  worker runs this code. Settled by deployment: Ace's version plan (`pse/wfv2/team/version-plan`) stops the portal and
  every worker, deploys, then starts them, with all three gates together and no partial deployment, so no mixed fleet
  runs a 1.1.0 admission.
- A same-basis replay whose snapshot holds NUL or a lone surrogate must not raise `NONDETERMINISTIC_ADMISSION` (the
  comparison at `store.ts` 3794). A regression test for it, on a real duplicate `enterNode` and on an activity replay,
  is in `aa0c4226` and passes.
