# Credential ownership correspondence

Base commit: **`f10b422c93171a2b09a72e30bf67feac980f3630`**.
Binding: the **uncommitted source snapshot** identified by the Git-normalized
blob IDs in `CODE-BLOBS.tsv`, not the unchanged base commit alone. Unchanged
dependencies retain that base commit's content. No new released or committed
code head is claimed. Line numbers below are in those exact source blobs.
Rebind and rerun if they change; after committing, record the resulting full
commit as well.

The model was designed first, then checked against the actual implementation.
Independent review found two missing boundaries in the original model and code:
reset erased an admitted key, and a new cold workflow holder incorrectly
blocked rotation. `StartupOwnership` now models both with pre-fix comparisons
and corrected cases. The new regression suite reproduced their failures before
the corresponding fixes. The retirement-repeat comparison captures an earlier
implementation regression, not a released-runtime defect.

## Lifecycle model

Paths in the table are under `packages/sdk/src/`.

| Model action or definition | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `G`, `Publish` | `github-credentials.ts:10-12,35-45` | **Model simplification.** Worker-local current authority and history become ordered bounded generations. Production generation IDs are opaque immutable strings, not ordered counters. |
| `Request`, `Offers` | `github-credentials.ts:23-34` | **Code behavior**, abstracted callback outcomes; acquisition is serialized. Exceptions remain errors rather than ambient fallback. |
| `Fresh`, `Allowed`, `Reject`, `Inv_ScopeBound` | `github-credentials.ts:16-20,28-44`; `session-manager.ts:1625-1638,1924-1935` | **Code behavior.** Actual finite expiry, expected scope and immutable generation are validated. Historical-token relabeling is tested separately; the model does not contain token bytes or fingerprints. |
| `Admit`, `lease`, `Inv_ActiveUsesLive` | `session-manager.ts:2747-2748`; `session-proxy.ts:2053` | **Code behavior.** `sessionClientKeys` reserves a native process before asynchronous SDK setup, while the enclosing run-turn operation lock protects admission through execution. There is no separate durable lease object. |
| `Begin`, `RejectReady`, `Inv_FreshAdmission` | `session-manager.ts:1641-1647`; `session-proxy.ts:5434`; `managed-session.ts:4529,4609` | **Code behavior.** Validate the exact session-bound token immediately before initial/corrective sends, including after slow setup. Ten-minute integer bounds make `remaining > 2` the same bound as the configured three-tick minimum. |
| `Finish`, `Release` | `managed-session.ts:4445-4456`; `session-manager.ts:2084-2096` | **Code behavior**, abstracting model completion and lock release. No successful result is invented after a credential error. |
| `AcquireDiscovery`, `ReleaseDiscovery` | `session-manager.ts:1651-1677` | **Code behavior.** Register an auxiliary owner before acquire/startup; reserve its token before SDK setup; release in `finally`. The model has one aggregate discovery owner, not every possible auxiliary request. |
| `OpenWorkflow`, `CloseWorkflow` | `session-manager.ts:4939,5207-5210` | **Code behavior**, abstracting workflow holders. The lifecycle model's workflow starts on a warm handle; cold opening is explicitly covered by `StartupOwnership`. |
| `Detach` | `session-manager.ts:1733-1747` | **Code behavior.** Skip held operation locks and workflow owners; detach obsolete warm handles under the session lock, then remove the binding. |
| `Stop`, `Owned` | `session-manager.ts:1749-1768` | **Code behavior.** Recheck current generation, auxiliary uses and all remaining bindings. Remove the pool entry before awaiting stop. Successful cleanup is abstracted as one step; errors/timeouts/force-stop restoration are tested, not modelled. |
| `Tick`, `Inv_TurnBeforeExpiry` | `github-credentials.ts:4-5,16-20`; `managed-session.ts:4445-4456` | **Model simplification.** Finite host turn deadlines are assumed to work; the model cannot prove an external native tool/process honors cancellation. |
| `Idle`, `Fairness`, `Prop_OldClientsDrain` | `session-manager.ts:1727-1780,2095,5210` | **Model simplification.** Named weak fairness assumes owners and successful cleanup eventually settle. `RetirementPass` separately checks that the implementation requests a repeated scan when release overlaps an awaited cleanup. |
| Faults and `W_` predicates | `github-credential-lifecycle.test.js:85-152,156-217,249-272,370-443,560-588,642-653` | **Rule to evaluate.** Deliberately removed guards and reachability witnesses; not claims of currently defective production code. Test ranges identify related routing/ownership scenarios, not a one-to-one trace equivalence proof. |

`acquireModelSessionOptions`, summary and regeneration are also source-aware
(`session-manager.ts:1616-1630,1694-1721`;
`session-proxy.ts:6497,6648,7422`; `regen-worker.ts:637-700`).
Pooled auxiliary owners are represented by discovery. Ephemeral regeneration
clients are activity-local and outside the pool-retirement model; no additional
formal coverage is claimed for their internals.

## Repeat-pass implementation model

| `RetirementPass` action | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `Order`, `Clients` | `session-manager.ts:1732-1739` | **Model simplification.** Two obsolete clients in fixed scan order, one owner held. Actual clients may have one credential with different workspace roots. |
| `ReleaseOwner`, `requested` | `session-manager.ts:1727-1729,2095,5210` | **Code behavior.** A release during a pending pass sets `githubRetirementRequested`, rather than merely returning the running promise. |
| `Scan` | `session-manager.ts:1732-1754` | **Code behavior.** A busy first client is skipped; a second unowned client enters asynchronous teardown. |
| `StopCompletes` | `session-manager.ts:1740-1768` | **Model simplification.** Warm detach, stop and possible force-stop become one successfully settling cleanup; failure and handle restoration are outside this model. |
| `FinishPass` | `session-manager.ts:1771-1777` | **Code behavior.** Clear the repeat request at scan start; run another pass when it was set while awaiting. |
| `LiveSpec`, `Prop_ReleasedClientsDrain` | same loop | **Model simplification.** Weak fairness on scan, successful cleanup and pass completion; owner release is never forced. |
| `FaultLostRequest`, `W_NoReleaseDuringStop` | `github-credential-lifecycle.test.js:560-590` | **Rule to evaluate.** Lost-request comparison and overlap witness. The regression gates another handle's teardown while the first operation owner releases. |

The comparison reaches: skip held client A; release A; finish B; end the pass
without a repeat; idle forever with A still live. The overlap witness also
reaches release while awaiting B. The fixed case drains under the stated
fairness; it does not promise cleanup if RPCs never settle.

## Startup/reset implementation model

| `StartupOwnership` action | Source anchor | Classification and correspondence |
|---|---|---|
| `Init`, `Scenario`, `WorkflowHolder` | `session-manager.ts:4939,5193-5207` | **Model simplification.** Epoch reset, cold workflow reopening with a retained old key, or an actually workflow-owned warm handle. |
| `Acquire` | `session-manager.ts:2725-2748` | **Code behavior.** A changed key is refused only for an existing warm workflow-owned handle. Cold setup reserves its new key even though its newly opening workflow holder already exists. |
| `Reset` | `session-manager.ts:2004-2022,2043-2058,3487,3546,3560` | **Code behavior.** Internal setup passes `preserveClientKey=true`; admission remains discoverable throughout SDK-registration and store deletion awaits. Public reset keeps the default false and is separately regression-tested. |
| `Begin` | `session-manager.ts:1641-1647`; `managed-session.ts:4529` | **Model simplification.** Successful setup followed by execution. Actual lifetime rejection after setup is covered by the lifecycle model and regression suite, not this small model. |
| `Rotate`, `StopOld` | `github-credentials.ts:35-45`; `session-manager.ts:1733-1754` | **Code behavior**, abstracting pool lookup through the binding. Losing the key makes the actual held session lock invisible to retirement; preserving it prevents premature stop. |
| `Inv_StartupReserved`, `Inv_ActiveUsesLive` | `github-credential-lifecycle.test.js:275-350` | **Rule to evaluate.** Pre-fix comparisons lose the key, then can stop the admitted process after rotation. All three reset-path regressions fail without preservation, including inside the awaited reset. |
| `Inv_WarmOwnerRefused`, `Prop_ExpectedOutcome` | `github-credential-lifecycle.test.js:370-443` | **Rule to evaluate.** Cold share reopening succeeds; an existing warm workflow owner remains protected. The pre-fix cold-holder case rejects the first setup; later retries are not modelled. |
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
