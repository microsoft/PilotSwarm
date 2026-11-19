# Decision environment runtime-proof review

## Scope

This change closes `NEW-04` and `NEW-05` for the Decision 1.1 private test environment.

- Branch: `waldemort/workflow-decision-node-env-runtime-proof`
- Base: `359282aebced27df48a5a9019dbceab1a76b6a69`
- Execution: unit runners only; no Azure, Kubernetes, credential, or deployment access

## Findings and implementation

### `NEW-05` (P1): prove running workloads

The read-only verifier now reads Deployments, ReplicaSets, and Pods from both reviewed Kubernetes contexts. For portal, worker, origin proxy, and relay, it:

- requires the exact reviewed digest-pinned image in the Deployment and active ReplicaSet templates;
- requires an observed, fully updated, ready, and available Deployment rollout with no unavailable or terminating replicas;
- requires exactly one active ReplicaSet and proves its controller owner UID, name, and API version match the reviewed Deployment;
- associates every selected Pod with that ReplicaSet through controller UID and exact owner identity;
- fails inactive ReplicaSets that still own Pods, Pods outside the Deployment selector, stalled rollouts, unready Pods, terminating Pods, sidecar-like unreviewed containers, and mixed old-image rollouts;
- requires every running application container to be ready and reports the Pod, ReplicaSet, and Deployment IDs, resource versions, node, rollout counts, runtime container ID, complete `imageID`, and digest;
- compares the runtime `imageID` digest with the reviewed 64-hex receipt digest.

The emitted `runtimeProof` evidence is independent of the desired Deployment template check.

### `NEW-04` (P2): fence access-closure scaling

Teardown no longer calls `kubectl scale` by Deployment name. Access-closure Deployments may be included in the reviewed exact-asset list as `action: scale-zero`; otherwise the driver snapshots their live UID and resourceVersion at execution time. Every closure scale is one atomic JSON Patch on the `scale` subresource with `test` operations for both the UID and resourceVersion before `spec.replicas` is changed to zero.

The exact-asset identity is resource-qualified when a Service and Deployment share a name. Kubernetes deletes retain UID and resourceVersion delete preconditions. Azure assets still stop at precheck and emit an operator-only atomic-ARM deletion requirement.

External bindings, reviewed receipts, no-credential material, privacy, expiry, closure timing, and read-only verification behavior remain in force.

## Tests

- `node --test deploy/scripts/test/decision11-environment.test.mjs`: 28 passed.
- `env -u SUBSCRIPTION_ID -u AZURE_SUBSCRIPTION_ID npm run test:deploy-scripts`: 429 passed.
- `node --check` passed for the driver and focused test.
- `git diff --check` passed.

Coverage includes real-shaped Deployment, ReplicaSet, Pod, rollout, readiness, owner-reference, runtime `imageID`, old-runtime, mixed-rollout, exact-asset, UID precondition, and replacement-race cases.

## Blockers and next action

No blockers were found. The branch is ready for parent integration and final repository validation.
