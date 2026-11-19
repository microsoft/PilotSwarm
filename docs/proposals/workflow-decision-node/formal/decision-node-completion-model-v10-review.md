# Decision effect completion — base-pinned design review

- Date: 2026-11-19
- Evidence type: **BASE_PINNED_DESIGN_EVIDENCE**, not TLC or final-head proof
- Design source pin: `b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`
- Reviewed implementation head (pre-P1 repair): `359282aebced27df48a5a9019dbceab1a76b6a69`
- Design: `workflow-decision-node-design-v10.md`
- Verdict: **No blocking edge case found in the finite mirror.**
- TLC: **NOT_RUN** — `java: command not found`
- Live Microsoft qualification: **NOT_RUN** — no live Foundry endpoint or RBAC probe was run

## Scope

This base-pinned model checks only the simplified v10 effect policy:

1. at most two provider calls;
2. a third entry that records an unavailable activity result with no provider call;
3. Duroxide activity history before the pending-only node CAS;
4. timeout and cancellation races;
5. routing from stored outcome and next-node input from stored output/error.

At the design source pin, the two-call cap was proposed and `enterScript` did not contain it. At reviewed implementation head `359282aebced27df48a5a9019dbceab1a76b6a69`, `runDecision` enforces the cap after the attempt enters: a third entry returns `unavailable` without a provider call. That hash is a pre-P1-repair comparison head, not the final PR head, and this review does not qualify the future repaired implementation.

## Finite evidence

The checked-in JavaScript mirror, labeled as base-pinned design evidence, was rerun and exactly reproduced the saved report: **164 distinct states**, with witnesses for:

- one model result;
- recovery call;
- third-entry refusal;
- timeout;
- cancellation;
- route plus next input from the stored payload.

All mirrored invariants passed. This is not TLC, proof, or final-head implementation evidence.

## Invariants

- provider calls do not exceed two;
- effect entries do not exceed three;
- terminal commits do not exceed one;
- runtime errors use `failure` routing and stored error payload;
- business results use their outcome and stored output;
- pending nodes are never routed;
- a business winner has the Duroxide result that produced its output;
- completed nodes have business output or runtime error, never both.

## Review consequence

The model supports the simplification: reuse Duroxide effect history and the existing `completeNode` CAS. It gives no reason for a Decision receipt/kernel or stable-identity protocol. The unresolved-effect collector must cover Decision effects too. The implementation comparison confirms the reviewed cap location but does not replace a fresh clean review after P1 repairs.

After P1 repairs, run the new final-head review before changing the proposal Status or Approval checkpoint. Run SANY and TLC in a Java-capable, pinned environment before any formal PASS claim. Keep live Microsoft qualification `NOT_RUN` until a live endpoint/RBAC probe actually runs.
