# Decision teardown quiescence P1-03 report

- **Verdict:** implemented
- **Branch:** `waldemort/workflow-decision-node-quiescence3`
- **Base:** `8b82177cfda0cae3741f791af9df4870b4d38646`
- **Scope:** final-review P1-03 only

## Repair

Teardown still fences every access-closure scale patch with JSON Patch `test` operations on the exact Deployment UID and resourceVersion. After all four patches, teardown now:

1. Re-reads every reviewed Deployment by exact name, context, and namespace.
2. Requires the prechecked UID, a live resourceVersion, zero desired replicas, an observed generation, and zero replica status fields.
3. Lists ReplicaSets and Pods in each reviewed workload namespace.
4. Requires each exact Deployment-owned ReplicaSet to have zero desired and status replicas.
5. Requires zero selected, owned, running, or terminating Pods for every closure workload.
6. Polls with an injected clock at 1-second intervals for at most 60 seconds and never later than the frozen closure instant.
7. Emits `accessClosed: true` and permits UID-precondition deletion only after a complete quiescence proof.

If any Pod remains or a read cannot prove quiescence, teardown writes failure evidence with `accessClosed: false`, records the last exact workload state and Pod identities, and performs no Kubernetes or Azure deletion. The Azure operator stop remains in place after successful quiescence.

The exact-asset receipt schema, atomic scale and delete preconditions, private binding receipt behavior, and runtime image proof are unchanged. Tests use fake runners and deterministic clocks. No live Azure or Kubernetes resource was contacted.

## Files

- `deploy/environments/pse-decision11-test/decision11.mjs`
- `deploy/scripts/test/decision11-environment.test.mjs`
- `deploy/environments/pse-decision11-test/README.md`
- `decision-teardown-quiescence3-report.md`

## Regression evidence

The fake-runner cases prove:

- successful scale patches with a running and terminating selected/owned Pod on repeated reads fail at the bound with evidence and zero deletes;
- a read that reaches the frozen closure deadline stops at that instant with `accessClosed: false`;
- a Pod that disappears on the third read succeeds;
- every quiescence read occurs after the final scale patch;
- the first deletion occurs after the final successful quiescence read;
- existing atomic UID/resourceVersion patch and delete races remain intact.

## Validation

- Focused Decision environment suite: 31/31 passed.
- Full deploy-script suite: 432/432 passed.
- Repository privacy: 0 findings.
- JavaScript syntax and `git diff --check`: passed.

The full deploy suite requires `SUBSCRIPTION_ID` to be unset in this execution environment because the loader intentionally allows that ambient variable to override local test fixtures.

## Blockers and next action

- **Blockers:** none.
- **Next action:** include this commit in the whole-change repair review, then rerun the final sealed verification as a unit with the P1-01 and P1-02 repairs.
