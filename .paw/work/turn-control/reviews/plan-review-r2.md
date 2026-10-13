Verdict: NEEDS-REVISION

# Session Turn Control - Plan Review r2

Reviewed revision: `38887ca2ad1923bdfdb4fa552c98f1e0d3348bdf`.

Scope: re-review of the 12 findings in `turn-control-PlanReview.md`, originally against `847d90b46adcf550a60e8a69137f5c3c429ec700`. This review does not open a new review scope. All revised-plan citations below refer to `.paw/work/turn-control/ImplementationPlan.md` at `38887ca2`. The spec and design remain unchanged between the two revisions.

## Finding dispositions

| Original finding | Original severity | Disposition | Revised-plan evidence |
|---|---|---|---|
| F1 - Public capability view | BLOCKING | Resolved | C1 explicitly supplies nullable turn fields and a boolean through direct/web detail reads (`:420-425`); C3 refreshes and explicitly clears eligibility (`:456,475`); UX-21 covers it (`:555`). |
| F2 - Loss of carried input before model execution | BLOCKING | Partly resolved; still blocking | P12 and the result carrier replace the unsafe predicate (`:64,187`). A4 and B2 name retention, consumption, and the relevant tests (`:290,295,379,386`). However, P12 also makes a new, explicitly unconfirmed stopped-carried policy the default. See the remaining finding below. |
| F3 - Pre-PR deployment route | BLOCKING | Resolved at plan level | Parent-owned U0 establishes an authorized immutable-candidate route, records source/images and restoration, and blocks U1 until available (`:521-523`). U1 depends on U0 (`:529`). This is planned work, not evidence that the route already exists. |
| F4 - Ambiguous-request ID lifetime | BLOCKING | Resolved | P14 retains immutable request data and limits fallback (`:66`); transports preserve options (`:424`); controller work and lost-response tests are explicit (`:425,456,475`); UX-20 covers the visible retry (`:554`). |
| F5 - Failing UX acceptance can complete | BLOCKING | Resolved | U1 requires mandatory scenarios to pass on the final candidate, correction and affected re-runs, retained failure evidence, both latency thresholds, and source/image identity (`:557-561`). Not-covered evidence is not a pass. |
| F6 - Incomplete A1 types/writeback semantics | IMPROVE | Resolved | A1 types look inputs, end kinds, actor, new options, carriers, signatures and exports (`:185-202`). P15 and A4 preserve `true / false / undefined` and test failed writeback (`:67,288,295`). |
| F7 - Shared manifest/helper ownership | IMPROVE | Resolved | Manifest belongs to the parent; existing helpers and the selected measurement script belong to A (`:92-94`). Integration applies proposed manifest entries (`:507`). |
| F8 - Visible-state selector gaps | IMPROVE | Resolved for the inventory; P12-dependent behavior remains subject to F2 | The expanded inventory includes refusals, ambiguity/retry, fallback failure and product states, with all-value tests (`:460-475`). UX-19..21 cover race, retry and refresh (`:553-555`). The new `carried_then_stopped` value is part of the unconfirmed policy in F2. |
| F9 - Confirmation-latency source | IMPROVE | Resolved | P13 supplies the correlated worker confirmation trace and control acceptance timestamp (`:65`); A1 includes `createdAt` in the control contract (`:185`); A4 emits the trace (`:291`); UX-18 specifies nearest-rank p95 and test parameters (`:552`). Implementing A2 must satisfy that A1 timestamp contract without restoring duplicate CMS user messages. |
| F10 - Traceability/rollout/connection budget | IMPROVE | Resolved | FR and SC mappings are explicit (`:115-144`). A5 identifies the budget calculation (`:320`); parent integration owns rollout/rollback documentation and the test-environment budget (`:512-513`). |
| F11 - Test integrity | IMPROVE | Resolved | Shared restrictions preserve zero retries, parallelism, default-model behavior, assertions and initial/final reports; correction and qualification are distinguished (`:108-113`). |
| F12 - Replay/migration compatibility precision | NOTE | Addressed | Old descriptors include omitted/null fields, affinity, epoch and workspace routing (`:202`); the session-read overload preserves existing parameters/columns (`:229`); the frozen self-version remains literal and B2 uses deterministic helpers (`:386,399`); P11 distinguishes Steer fallback from Stop (`:63`); P16 prevents promotion of aliases (`:68`). |

## Remaining finding

1. **BLOCKING - F2 is not fully closed while the new carried-steer Stop policy is an unapproved default.**

   **Plan location:** P12 (`:64`); A4 result evidence and tests (`:290,295`); B2 clearing/tests (`:379,386`); C3 derived history label and selector (`:456,470`).

   **Evidence:** The technical fix is sound at plan level: the activity reports consumption and B no longer copies `pastGates`. But P12 adds a separate behavior: a Stop at the next turn's start discards previously carried input without a model run, leaves its durable outcome as `carried`, and adds a derived "Carried, then stopped" label. P12 itself calls this an extension of D2, says the owner must confirm it, and then says "until then it is the default."

   The unchanged binding spec says carried steers run with the next turn (Spec FR-013, `Spec.md:151`; SC-005, `:182`). Its D2 examples concern steers of the stopped turn (`Spec.md:37-38`). The unchanged design describes carrying into the next prompt and its existing clearing rule (design 4.9, `docs/proposals/session-turn-control.md:888-899`), and the turn-end table defines durable outcomes for controls of that turn (design 5.2, `:954-964`). Neither artifact resolves this newly identified cross-turn Stop policy or defines the derived label. The supplied revision contains no approval for it.

   **Impact:** A4, B2 and C3 are instructed to implement a behavior whose own stated owner confirmation is outstanding. The reviewer cannot treat that default as a settled spec-aligned disposition of carried input. This is a residual of F2, not a new independent finding.

   **Concrete proposed edit:** Replace "until then it is the default" with an explicit parent-owned decision gate before implementing the P12-dependent portions of A4, B2 and C3. Record the owner's decision and align the binding spec/design and the plan's consumption, stopping, history and acceptance rules with it. If the owner approves the proposed extension, state clearly that `carriedSteersConsumed` also represents an authorized stopped disposition, not proof of delivery, and include an acceptance scenario for a carried steer stopped before its next model call, before and after reload. If the owner does not approve it, revise those same plan items to the selected policy rather than guessing one. The existing consumption/retention fix and pre-model-error tests should remain.

## Conclusion

The original technical gaps in the public client view, transport retry, deployment feasibility, UX passing gate, typed handoff, ownership, measurement method, traceability and test integrity are addressed by the revised plan. The carried-input fix also addresses the original loss mechanism, but its additional behavior decision is not yet settled.

**Upstream status:** FAIL. Revise only the remaining F2 decision/gate and associated binding semantics, then provide the next immutable revision for a finding-scoped re-review. This review supplies no runtime or deployment execution result.

**Open finding counts:** BLOCKING: 1; IMPROVE: 0; NOTE: 0.

**Original findings:** 11 resolved/addressed; F2 partly resolved.
