# WorkflowCarry correspondence to 163007b5 (controller freeze)

Code at `163007b5` on base `d0f5571b`; see `../CONTROLLER-VERSIONING-163007b5.md` for the five controller-versioning
obligations. The rows of `CORRESPONDENCE-004eff4e.md` hold (last confirmed at `a684aab3`). Carry lives in the shared
activities, not in the controller generator: `carry.ts` and `store.ts` are unchanged from `d0f5571b`, and the shared
activities in `workflow/runtime.ts` keep their bodies, at new line numbers. Paths are under `packages/sdk/src/workflow/`;
line numbers are at `163007b5`.

| Model | Code at 163007b5 |
|---|---|
| `Carry == OptIn /\ Gate` | `runtime.ts` 2034: the entry requires `workflowControllerFeatures(current.controllerVersion).carry` and the IR's `node.carry`, read from the run, never from the worker; `controller-features.ts` keeps `carry: true` at 1.1.0 only |
| `Arrive` | `runtime.ts` 1884: the arrival takes the predecessor's snapshot under the same run-version check |
| `Eval`, `Admit` | The same code as `004eff4e`, moved: the evaluation and the `kv_changed` loop run inside `workflow.enter`, unchanged |
| Version dispatch | A 1.0.0 run stays on the frozen generator, which schedules main's activities; the shared `workflow.enter` and arrival then skip carry for it by the run-version check |

The controller generators schedule `workflow.enter` with the same inputs in 1.0.0 and 1.1.0 (the only generator
difference is approval's), so carry's correspondence needs no generator row.

## Verdict

Bound. `WorkflowCarry` (ca2, 17 of 17) holds at `163007b5`. No new TLC run.
