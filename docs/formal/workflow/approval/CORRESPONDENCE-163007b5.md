# WorkflowApproval correspondence to 163007b5 (controller freeze)

Code at `163007b5` on base `d0f5571b`; see `../CONTROLLER-VERSIONING-163007b5.md` for the five controller-versioning
obligations. The rows of `CORRESPONDENCE-004eff4e.md` hold (last confirmed at `a684aab3`), with the controller
generator's lines moved as below. `approval.ts`, `store.ts`, `service.ts` and `human-commands.ts` are unchanged from
`d0f5571b`, and the shared activities in `workflow/runtime.ts` keep their bodies. Paths are under
`packages/sdk/src/workflow/`; line numbers are at `163007b5`.

The model's `Gate` was a run-time feature check (approval at 1.1.0 only). It is now which controller code runs a run,
plus the same feature check in the shared activities:

| `CORRESPONDENCE-004eff4e` row | Code at 163007b5 |
|---|---|
| The controller refuses an approval without the gate | Frozen 1.0.0 (`controller_1_0_0/runtime.ts` 286 and 473) has no `approval` node type, so its plan parser refuses an approval IR before admission, with main's own message. The live 1.1.0 accepts it (`controller/runtime.ts` 291, 478) |
| `Timer`, with `Backstop` (`elapseDue`) | `controller/index.ts` 287-298 (`elapseDue`: approval nodes to `workflow.elapseApproval`, the rest to `workflow.elapse`), used at 573 and 803; frozen 1.0.0 calls `workflow.elapse` only (561, 788) |
| Activation (`enterApproval`) | `controller/index.ts` 651: `workflow.enterApproval` for an approval node, else `workflow.enter` |
| `Mode = "test"` (interception) | `controller/index.ts` 705-710: an approval waits as a wait does and, in a test run, is intercepted (`workflow.interceptApproval`) |
| Shared activities | `runtime.ts` 1987 (enter), 2288 (elapse) and 3739 (interception), and `store.ts` 3873 and 3889, require `workflowControllerFeatures(run.controllerVersion).approval`, read from the run |

## Verdict

Bound. `WorkflowApproval` (ap4, 35 of 35) holds at `163007b5` with `Gate` read as the run's controller version. No new
TLC run.
