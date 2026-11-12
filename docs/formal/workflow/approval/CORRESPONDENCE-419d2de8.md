# WorkflowApproval correspondence to 419d2de8

Code at `419d2de8`, Dag's final FB-007 delivery head on `waldemort/dag-approval`, base `8409e475`. Its
`packages/sdk/src` tree, `366cefec`, is identical to `1d391f28`'s. From `1d391f28` only the approval skill's description
line and one CLI test change. From `89c5b1a2`, `1d391f28` changed
only skill text, skill and catalog tests, and five comment lines in `controller-features.ts`. `approval.ts`, `store.ts`,
`runtime.ts`, `service.ts` and `human-commands.ts` are byte-identical to `89c5b1a2`. Earlier bindings were at `9fe74425`,
`db6693cd`, `89c5b1a2` and `1d391f28`. Since `db6693cd`:
- the frozen snapshot's and the read projection's times are UTC ISO microseconds instead of the server's `::text`
  form; comparisons, locks, clock readings and the digest's fields are unchanged;
- the version-feature map moved to `controller-features.ts`, and the three literal `"1.1.0"` checks use the shared
  `approval` gate.

Line numbers are at `419d2de8`, the same as at `1d391f28`; from `89c5b1a2` only the `controller-features.ts` line moved, from 16 to 21. The contract is still `e117753e`, with addendum `47cfbb47`. The model is ap4 (35 of 35).

| Model | Code at 419d2de8 |
|---|---|
| `Gate` | `controller-features.ts` 21 (`approval: true` at 1.1.0 only; 1.0.0 has no features). The controller refuses to admit an approval without the gate (`runtime.ts` 1434). New activities `workflow.enterApproval`, `workflow.elapseApproval` and `workflow.interceptApproval` (3745, 3746, 5229) check the run's admitted version. `store.ts` 3768-3782 admits an approval only for a live run whose version has the gate and whose IR declares it. At 1.0.0 none of these is scheduled |
| Activation: `pin` and the effective deadline `Min(now + D, RunDl)` | `store.ts` 3768-3782: under `enterNode`'s session lock, the owner is read (`approvalOwnerIn`, `approval.ts` 50-57). 3937: `LEAST(admission + timeoutSeconds, run deadline)` by the store's clock. 3966 and `approval.ts` 60-79: the immutable snapshot and its digest (`context_sha256`) are written in the same transaction. An agent subtree or a missing owner admits `forbidden` (`runtime.ts` 3693; `store.ts` 3778) |
| `Deliver`: one transaction | `approval.ts` 120-180 (`respond`): the session row, then the current owner (`approvalOwnerIn`, `FOR SHARE`), then the receipt, then the run, node and approval rows (`locked`, 93-103), then one clock reading (105-108) |
| `OwnerOk`: pinned AND current owner (`Inv_OnlyPinned`, `Inv_OwnerAtDecision`) | `approval.ts` 121 (`actor.kind = "user"`), 126-129 (the current owner), 139-141 (the pinned owner) |
| The exact visit and the digest (`Inv_ConsentFresh`) | `approval.ts` 99 (the row by node execution, run and Workflow) and 142 (`context_sha256`) |
| `Acceptable`: pending row, run not ended, no accepted stop, uncut branch, `now < deadline` (`Inv_NoAnswerAfterStop`, `Inv_BeforeDeadline`) | `approval.ts` 143-145 (live mode, the version's `approval` gate, admitted, running or paused, `stop_requested_at` null, node pending, no decision); 148-155 (the enclosing parallel state still pending and inside its own deadline); 156-161 (at or after the deadline the answer settles the timeout instead and returns `APPROVAL_EXPIRED`) |
| `Accept` atomic (`Inv_AuditAgrees`, `Inv_OneDecision`) | `approval.ts` 166-175: the node result (`WHERE state='pending'`), the approval row (`WHERE decision IS NULL`), the operation receipt and the session event in one transaction |
| `Replay` (`Inv_ReceiptStable`) | `approval.ts` 130-137: the same operation id and the same request hash (command plus actor) return the stored receipt with `replayed: true`; another request under the id is `OPERATION_CONFLICT` |
| The wake after commit (`LoseWake`) | `service.ts` 1386-1391: `respondWorkflowApproval` wakes the run after the transaction, only when the run is active with no stop |
| `Timer`, with `Backstop` | `runtime.ts` 1069-1079 (`elapseDue`), used in the ordinary pass and the paused pass (1356, 1587) → `elapseApproval` → `approval.ts` 182-197 (`expire`): under the same locks, a pending row that is due becomes `timed_out`. A decided row returns no remaining time, so the controller collects it |
| `Route` once, only while running; `PausedWakeKept`, `ResumeReread`, `CanReread` | The existing cursor machinery: `cursor.pending` holds the node execution (`runtime.ts` 1489), collect consumes a completed node once, the paused pass routes nothing, and continue-as-new carries the cursors |
| `Mode = "test"`; `FixtureLive = FALSE` | `respond` refuses a test run (`approval.ts` 143). A test approval is an interception (`runtime.ts` 3648-3654, 1492-1494, 5229). Its deadline is virtual only: `elapseApproval` never times a test approval out on the wall clock (`runtime.ts` 3755-3767) |
| `EndRun`, `Cut`, `Stop` | The existing run end, branch cut and stop-grace paths complete or cancel a pending node. `respond` and `expire` act only on a pending node of a live session (`approval.ts` 144, 186) |

Notes (neither changes the verdict):

1. **Receipt lock position.** The contract orders the locks session, run, node, approval, receipt. `respond` reads and
   locks the receipt row right after the session and owner rows. Every approval transaction takes the Workflow
   session row FOR NO KEY UPDATE first, so they are serialized before any of these rows. The receipt row is keyed by
   its own operation id, so only the same id can conflict.
2. **Retry after an owner change.** Access checks come before the receipt, as the contract says (`approval.ts`
   124-129), so an identical retry after the owner changed is `FORBIDDEN`, not a replay. The model's
   `Inv_ReceiptStable` holds because the design has no owner change: no owner transfer exists, and an FB-002 hand-over
   keeps the user.

The note from `9fe74425` about literal `"1.1.0"` checks is resolved: all three use the shared gate.
