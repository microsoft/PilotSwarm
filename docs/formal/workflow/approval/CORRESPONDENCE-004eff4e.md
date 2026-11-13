# WorkflowApproval correspondence to 004eff4e

Code at `004eff4e`, Ace's batch-2 integration head (`waldemort/fb-batch-2`, controller 1.1.0 with carry and approval).
The approval code merged from Dag's final head `419d2de8`:
- `approval.ts` and `human-commands.ts` are byte-identical to `419d2de8`.
- The cited regions of `runtime.ts`, `store.ts` and `service.ts` are identical in content; only their line numbers
  moved, after the carry merge (FB-005), the agent tool delegation merge (FB-020) and the parent re-check in
  `recordSessionCommand`.
- `controller-features.ts` 21 still holds `approval: true` at 1.1.0 only.
- Since `419d2de8` the compiler also refuses `carry` on an approval state (`b9f7b92f`), so no approval execution has a
  carry snapshot. A carrying predecessor's `{carry, result}` wrapper can arrive at an approval state. It is then part of
  the input the approval freezes, and consent covers exactly that.

Earlier bindings: `9fe74425`, `db6693cd`, `89c5b1a2`, `1d391f28`, `419d2de8`. Line numbers are at `004eff4e`. The
contract is still `e117753e`, with addendum `47cfbb47`. The model is ap4 (35 of 35).

| Model | Code at 004eff4e |
|---|---|
| `Gate` | `controller-features.ts` 21 (`approval: true` at 1.1.0 only; 1.0.0 has no features). The controller refuses to admit an approval without the gate (`runtime.ts` 1437). New activities `workflow.enterApproval`, `workflow.elapseApproval` and `workflow.interceptApproval` (3766, 3767, 5250) check the run's admitted version. `store.ts` 3826-3840 admits an approval only for a live run whose version has the gate and whose IR declares it. At 1.0.0 none of these is scheduled |
| Activation: `pin` and the effective deadline `Min(now + D, RunDl)` | `store.ts` 3826-3840: under `enterNode`'s session lock, the owner is read (`approvalOwnerIn`, `approval.ts` 50-57). 3995: `LEAST(admission + timeoutSeconds, run deadline)` by the store's clock. 4024 and `approval.ts` 60-79: the immutable snapshot and its digest (`context_sha256`) are written in the same transaction. An agent subtree or a missing owner admits `forbidden` (`runtime.ts` 3713; `store.ts` 3836) |
| `Deliver`: one transaction | `approval.ts` 120-180 (`respond`): the session row, then the current owner (`approvalOwnerIn`, `FOR SHARE`), then the receipt, then the run, node and approval rows (`locked`, 93-103), then one clock reading (105-108) |
| `OwnerOk`: pinned AND current owner (`Inv_OnlyPinned`, `Inv_OwnerAtDecision`) | `approval.ts` 121 (`actor.kind = "user"`), 126-129 (the current owner), 139-141 (the pinned owner) |
| The exact visit and the digest (`Inv_ConsentFresh`) | `approval.ts` 99 (the row by node execution, run and Workflow) and 142 (`context_sha256`) |
| `Acceptable`: pending row, run not ended, no accepted stop, uncut branch, `now < deadline` (`Inv_NoAnswerAfterStop`, `Inv_BeforeDeadline`) | `approval.ts` 143-145 (live mode, the version's `approval` gate, admitted, running or paused, `stop_requested_at` null, node pending, no decision); 148-155 (the enclosing parallel state still pending and inside its own deadline); 156-161 (at or after the deadline the answer settles the timeout instead and returns `APPROVAL_EXPIRED`) |
| `Accept` atomic (`Inv_AuditAgrees`, `Inv_OneDecision`) | `approval.ts` 166-175: the node result (`WHERE state='pending'`), the approval row (`WHERE decision IS NULL`), the operation receipt and the session event in one transaction |
| `Replay` (`Inv_ReceiptStable`) | `approval.ts` 130-137: the same operation id and the same request hash (command plus actor) return the stored receipt with `replayed: true`; another request under the id is `OPERATION_CONFLICT` |
| The wake after commit (`LoseWake`) | `service.ts` 1426-1431: `respondWorkflowApproval` wakes the run after the transaction, only when the run is active with no stop |
| `Timer`, with `Backstop` | `runtime.ts` 1072-1082 (`elapseDue`), used in the ordinary pass and the paused pass (1359, 1590) → `elapseApproval` → `approval.ts` 182-197 (`expire`): under the same locks, a pending row that is due becomes `timed_out`. A decided row returns no remaining time, so the controller collects it |
| `Route` once, only while running; `PausedWakeKept`, `ResumeReread`, `CanReread` | The existing cursor machinery: `cursor.pending` holds the node execution (`runtime.ts` 1492), collect consumes a completed node once, the paused pass routes nothing, and continue-as-new carries the cursors |
| `Mode = "test"`; `FixtureLive = FALSE` | `respond` refuses a test run (`approval.ts` 143). A test approval is an interception (`runtime.ts` 3668-3674, 1495-1497, 5250). Its deadline is virtual only: `elapseApproval` never times a test approval out on the wall clock (`runtime.ts` 3776-3788) |
| `EndRun`, `Cut`, `Stop` | The existing run end, branch cut and stop-grace paths complete or cancel a pending node. `respond` and `expire` act only on a pending node of a live session (`approval.ts` 144, 186) |

Notes (neither changes the verdict):

1. **Receipt lock position.** The contract orders the locks session, run, node, approval, receipt. `respond` reads and
   locks the receipt row right after the session and owner rows. Every approval transaction takes the Workflow
   session row FOR NO KEY UPDATE first, so they are serialized before any of these rows. The receipt row is keyed by
   its own operation id, so only the same id can conflict.
2. **Retry after an owner change.** Access checks come before the receipt, as the contract says (`approval.ts`
   124-129), so an identical retry after the owner changed is `FORBIDDEN`, not a replay. The model's
   `Inv_ReceiptStable` holds because the design has no owner change: no owner transfer and no hand-over exist.

The note from `9fe74425` about literal `"1.1.0"` checks is resolved: all three use the shared gate.
