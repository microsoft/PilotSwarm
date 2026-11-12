# WorkflowCarry correspondence to 1a6f582f

Code at `1a6f582f`, Valkyrie's final FB-005 commit, rebased as one commit onto Ace's batch-2 base `8409e475`. The
change is identical to `aa0c4226` on `288cb6c3`: `git range-diff 288cb6c3..aa0c4226 8409e475..1a6f582f -- packages/sdk/src
packages/sdk/test` reports `=`. Earlier bindings were at `aa0c4226`, `b86525b3` and `ad2bb3cf`, whose source trees
were identical. Line numbers are at `1a6f582f`: `runtime.ts` lines are one higher than at `aa0c4226`, because of an
import in the base; `store.ts` lines are unchanged. Storage is a nullable TEXT `carry_snapshot`, not JSONB, so that NUL and lone-surrogate strings
survive (`fb005-carry-storage-correction.md`). The model does not depend on the column type.

| Model | Code at 1a6f582f |
|---|---|
| `Carry == OptIn /\ Gate` | `runtime.ts` 146 (`carry: true` at 1.1.0; 1.0.0 has no features). The entry checks `workflowControllerFeatures(current.controllerVersion).carry` and the IR's `node.carry` (3518). The arrival checks `run.controllerVersion` and the predecessor's `carry` (3371). A null controller version means no carry |
| `Eval` | `runtime.ts` 3518-3524: `evaluateCarry(node.carry, scopeFor(current, arrived.incoming, …, kv, branch))` (`carry.ts` 12), before the `input:` mapping (3526). A failed selection sets an immediate `invalid_input` (`CarryFail`) |
| `Admit` and the KV race | `runtime.ts` 3496: the evaluation loop. A `kv_changed` refusal evaluates carry and input again. `store.ts` 3720: the snapshot is canonicalized. 3925 and 3937: written as `carry_snapshot` in the same INSERT as the input and the KV revision. An input-mapping failure after a valid selection keeps `carryText` with the immediate failure (`InputFail`) |
| Replay (the existing row wins) | `store.ts` 3733-3740: an existing node is returned as stored. On the same KV basis, a different snapshot raises `NONDETERMINISTIC_ADMISSION`. No statement updates `carry_snapshot` |
| `Arrive` | `runtime.ts` 3371-3376: `carryArrival(predecessor.carrySnapshot, result)` (`carry.ts` 24) for a business result and a runtime error alike; `runtimeError` stays the raw error. The snapshot is read from the row (`store.ts` 573, `readCarrySnapshot`, `carry.ts` 16), never evaluated again |
| Keys per execution row (`SharedCarry = FALSE`) | The column is on `workflow_node_executions`, one per node execution. A parallel branch's first state takes its manifest item (unchanged), and a parallel state's own snapshot reaches its outer successor |
| Migration | `cms-migrations.ts` 424 registers 0090 `workflow_carry` (`migrations/workflow-carry-0090.ts`): `ADD COLUMN IF NOT EXISTS carry_snapshot TEXT`, `lock_timeout` 5 s |

Not modelled, and one gap:

- The 64 KiB and 256 KiB limits are covered by tests, not by the model.
- **Gap: mixed worker versions.** The carry is in the existing `workflow.enter` activity (`runtime.ts` 281), changed in
  place. It is routed by the workflow-request capability tag (`storeTagged`), which workers without this code also
  carry, not by controller version. During a rolling deploy, a worker without this code can run `workflow.enter` for a
  1.1.0 run. It then writes no snapshot and routes the raw result. The model has one code version.
- This needs either a new or tagged activity, or a deployment rule that the 1.1.0 carry gate is in use only once every
  worker runs this code. Settled by deployment: Ace's version plan (`pse/wfv2/team/version-plan`) stops the portal and
  every worker, deploys, then starts them, with all three gates together and no partial deployment, so no mixed fleet
  runs a 1.1.0 admission.
- A same-basis replay whose snapshot holds NUL or a lone surrogate must not raise `NONDETERMINISTIC_ADMISSION` (the
  comparison at `store.ts` 3737). A regression test for it, on a real duplicate `enterNode` and on an activity replay,
  is in `aa0c4226` and passes.
