# Credential ownership correspondence

Source commit: **`40e26986fcd141b3feb6bf740e11aaf6da07d645`**, over upstream
`b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`. `CODE-BLOBS.tsv` records the
Git-normalized source blob IDs at that commit. Line numbers below refer to
that exact source, not a released package. Rebind and rerun if it changes.

The model was designed first, then checked against the actual implementation.
Independent review found two missing boundaries in the original model and code:
reset erased an admitted key, and a new cold workflow holder incorrectly
blocked rotation. `StartupOwnership` now models both with pre-fix comparisons
and corrected cases. The new regression suite reproduced their failures before
the corresponding fixes. The retirement-repeat comparison captures an earlier
implementation regression, not a released-runtime defect.
Final review also found that an unbounded warm-handle disconnect could stall
retirement's callers and shutdown. A real SDK disconnect regression reproduced
it before the existing deadline helper was applied; `RetirementPass` now includes
the stalled path and its timeout.

## Lifecycle model

Paths in the table are under `packages/sdk/src/`.

| Model action or definition | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `G`, `Publish` | `github-credentials.ts:10-12,35-45` | **Model simplification.** Worker-local current authority and history become ordered bounded generations. Production generation IDs are opaque immutable strings, not ordered counters. |
| `Request`, `Offers` | `github-credentials.ts:23-34` | **Code behavior**, abstracted callback outcomes; acquisition is serialized. Exceptions remain errors rather than ambient fallback. |
| `Fresh`, `Allowed`, `Reject`, `Inv_ScopeBound` | `github-credentials.ts:16-20,28-44`; `session-manager.ts:1625-1638,1916-1931` | **Code behavior.** Actual finite expiry, expected scope and immutable generation are validated. Historical-token relabeling is tested separately; the model does not contain token bytes or fingerprints. |
| `Admit`, `lease`, `Inv_ActiveUsesLive` | `session-manager.ts:2742-2743`; `session-proxy.ts:2049` | **Code behavior.** `sessionClientKeys` reserves a native process before asynchronous SDK setup, while the enclosing run-turn operation lock protects admission through execution. There is no separate durable lease object. |
| `Begin`, `RejectReady`, `Inv_FreshAdmission` | `session-manager.ts:1641-1647`; `session-proxy.ts:4943`; `managed-session.ts:4541,4621` | **Code behavior.** Validate the exact session-bound token immediately before initial/corrective sends, including after slow setup. Ten-minute integer bounds make `remaining > 2` the same bound as the configured three-tick minimum. |
| `Finish`, `Release` | `managed-session.ts:4457-4470`; `session-manager.ts:2081-2091` | **Code behavior**, abstracting model completion and lock release. No successful result is invented after a credential error. |
| `AcquireDiscovery`, `ReleaseDiscovery` | `session-manager.ts:1651-1677` | **Code behavior.** Register an auxiliary owner before acquire/startup; reserve its token before SDK setup; release in `finally`. The model has one aggregate discovery owner, not every possible auxiliary request. |
| `OpenWorkflow`, `CloseWorkflow` | `session-manager.ts:4914,5187-5190` | **Code behavior**, abstracting workflow holders. The lifecycle model's workflow starts on a warm handle; cold opening is explicitly covered by `StartupOwnership`. |
| `Detach` | `session-manager.ts:1722-1734` | **Code behavior.** Skip held operation locks and workflow owners; detach obsolete warm handles under the session lock, then remove the binding. |
| `Stop`, `Owned` | `session-manager.ts:1736-1746,1760-1777` | **Code behavior.** Recheck current generation, auxiliary uses and all remaining bindings. Remove the pool entry before awaiting the shared shutdown helper. Successful process stopping is abstracted as one step; force-stop restoration is tested, not modelled. `RetirementPass` separately covers a stalled warm-handle disconnect. |
| `Tick`, `Inv_TurnBeforeExpiry` | `github-credentials.ts:4-5,16-20`; `managed-session.ts:4457-4470` | **Model simplification.** Finite host turn deadlines are assumed to work; the model cannot prove an external native tool/process honors cancellation. |
| `Idle`, `Fairness`, `Prop_OldClientsDrain` | `session-manager.ts:1711-1757,2090,5190` | **Model simplification.** Named weak fairness assumes owners and successful cleanup eventually settle. `RetirementPass` separately checks that the implementation requests a repeated scan when release overlaps an awaited cleanup. |
| Faults and `W_` predicates | `github-credential-lifecycle.test.js:131-198,202-263,295-318,416-489,606-634,688-699` | **Rule to evaluate.** Deliberately removed guards and reachability witnesses; not claims of currently defective production code. Test ranges identify related routing/ownership scenarios, not a one-to-one trace equivalence proof. |

`acquireModelSessionOptions`, summary and regeneration are also source-aware
(`session-manager.ts:1616-1630,1694-1708`;
`session-proxy.ts:6005,6149-6179,6927-6928`; `regen-worker.ts:637-700`).
Pooled auxiliary owners are represented by discovery. Ephemeral regeneration
clients are activity-local and outside the pool-retirement model; no additional
formal coverage is claimed for their internals.

The shared `copilot-client.ts:260-282` prompt helper is extracted from existing
summary handling and used by pooled auxiliary prompts. The shared stop helper
at `session-manager.ts:1760-1777` is extracted from existing shutdown handling.
The vision parser at `session-manager.ts:1427-1441` is shared by the existing
and external-credential paths. These extractions do not change the model's
admission, ownership or cleanup transitions.

## Repeat-pass implementation model

| `RetirementPass` action | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `Order`, `Clients` | `session-manager.ts:1717-1724` | **Model simplification.** Two obsolete clients in fixed scan order, one owner held. Actual clients may have one credential with different workspace roots. |
| `ReleaseOwner`, `requested` | `session-manager.ts:1713-1715,2090,5190` | **Code behavior.** A release during a pending pass sets `githubRetirementRequested`, rather than merely returning the running promise. |
| `Scan` | `session-manager.ts:1717-1739` | **Code behavior.** A busy first client is skipped; a second unowned client enters asynchronous teardown. |
| `StopCompletes` | `session-manager.ts:1726-1746,1760-1777` | **Model simplification.** Successful warm detach, stop and possible force-stop become one cleanup step. A separate branch models one permanently stalled disconnect; other failures/restoration remain outside this model. |
| `DetachTimesOut`, `Inv_TimeoutRetainsClient`, `Prop_RetirementSettles` | `session-manager.ts:1729,1732-1746,1755-1757,4285-4286`; `github-credential-lifecycle.test.js:700-733` | **Code behavior**, abstracting the existing 20-second deadline as a weakly fair timeout. Reject before forgetting the warm handle or binding; the shared retirement promise settles, allowing operation finalizers and shutdown to proceed. No eventual cleanup of a permanently stalled client is promised. |
| `FinishPass` | `session-manager.ts:1749-1755` | **Code behavior.** Clear the repeat request at scan start; run another pass when it was set while awaiting. |
| `LiveSpec`, `Prop_ReleasedClientsDrain` | same loop | **Model simplification.** Weak fairness on scan, successful cleanup, deadline expiration and pass completion; owner release is never forced. Drain is checked only when disconnect is not permanently stalled. |
| `FaultLostRequest`, `W_NoReleaseDuringStop` | `github-credential-lifecycle.test.js:606-636` | **Rule to evaluate.** Lost-request comparison and overlap witness. The regression gates another handle's teardown while the first operation owner releases. |
| `StalledDetach`, `FaultUnboundedDetach` | `github-credential-lifecycle.test.js:700-733` | **Rule to evaluate.** A permanently stalled SDK `session.detach` with or without the deadline. The pre-fix comparison leaves the shared retirement promise pending; the fix retains its client while settling the attempt. |

The comparison reaches: skip held client A; release A; finish B; end the pass
without a repeat; idle forever with A still live. The overlap witness also
reaches release while awaiting B. The fixed case drains under the stated
fairness. The stalled-disconnect case checks settlement, not eventual cleanup.

## Startup/reset implementation model

| `StartupOwnership` action | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `Scenario`, `WorkflowHolder` | `session-manager.ts:4914,5173-5187` | **Model simplification.** Epoch reset, cold workflow reopening with a retained old key, or an actually workflow-owned warm handle. |
| `Acquire` | `session-manager.ts:2720-2743` | **Code behavior.** A changed key is refused only for an existing warm workflow-owned handle. Cold setup reserves its new key even though its newly opening workflow holder already exists. |
| `Reset` | `session-manager.ts:1999-2017,2038-2053,3473,3532,3546` | **Code behavior.** Internal setup passes `preserveClientKey=true`; admission remains discoverable throughout SDK-registration and store deletion awaits. Public reset keeps the default false and is separately regression-tested. |
| `Begin` | `session-manager.ts:1641-1647`; `managed-session.ts:4541` | **Model simplification.** Successful setup followed by execution. Actual lifetime rejection after setup is covered by the lifecycle model and regression suite, not this small model. |
| `Rotate`, `StopOld` | `github-credentials.ts:35-45`; `session-manager.ts:1722-1739` | **Code behavior**, abstracting pool lookup through the binding. Losing the key makes the actual held session lock invisible to retirement; preserving it prevents premature stop. |
| `Inv_StartupReserved`, `Inv_ActiveUsesLive` | `github-credential-lifecycle.test.js:321-396` | **Rule to evaluate.** Pre-fix comparisons lose the key, then can stop the admitted process after rotation. All three reset-path regressions fail without preservation, including inside the awaited reset. |
| `Inv_WarmOwnerRefused`, `Prop_ExpectedOutcome` | `github-credential-lifecycle.test.js:416-489` | **Rule to evaluate.** Cold share reopening succeeds; an existing warm workflow owner remains protected. The pre-fix cold-holder case rejects the first setup; later retries are not modelled. |
| `LiveSpec` | actual startup/reset calls above | **Model simplification.** Weak fairness assumes acquisition, reset and successful SDK setup settle. No credential/network/backend failures are included in these valid-setup scenarios. |

## Boundaries

No orchestration generator, yielded action sequence, frozen handler or snapshot
format changed. Existing durable replay, store, hydrate/dehydrate and Workflow
controller models retain their previous bindings; this packet does not replace
or rerun them.

The holding cases assume enclosing operation locks, finite host deadlines,
immutable authority descriptions and successfully settling cleanup. They do
not prove live GitHub authentication, actual token issuance/rotation, same-
session recovery on Linux, cancellation of arbitrary native tasks, database
transactions or long-running deployment behavior. The exact deployed
SDK/CLI pair and real-provider flows still require separate qualification.
