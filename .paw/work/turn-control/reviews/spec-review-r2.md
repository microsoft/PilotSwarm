Verdict: NEEDS-REVISION

# Session Turn Control - Specification Re-review (r2)

**Input:** `.paw/work/turn-control/Spec.md` at immutable commit `47f64cf859f3b7e476a38980d4538a01fbb41c2c`.

**Baseline:** the nine findings in `turn-control-SpecReview.md`, issued against `3bae744b83017fabf6be4a98be080e13d68b3aea`, using binding design revision 5. This is a focused re-review of those findings, not a new review of unrelated requirements. Approved R1-R7 and D1-D5 decisions remain unchanged.

**Closure:** 8 findings resolved; F2 partially resolved. **Remaining findings:** 1 must-fix, 0 should-fix, 0 nits.

## Remaining finding

1. **must-fix - F2: Make the saved-recovery scenario and crash criterion agree with the revised outcome table and D4.**

   **Spec location:** US-5 acceptance scenario 3, line 85; US-5 acceptance scenario 8, line 90; SC-004, line 181. Relevant corrected rules: FR-009, lines 142-147; FR-011, line 149; D4, line 208.

   **Design reference:** 3.4, lines 301-303; 3.7, lines 371-379; 5.1 no-store case, line 948; 5.2, lines 958-961; D4-D5, lines 1117-1118, at the original binding design commit.

   **Issue:** FR-009 and FR-011 now correctly govern saved-result recovery. However, US-5 scenario 3 still states that later steers are "carried" and that a late Stop is "too late" without distinguishing whether a Stop is open. In the case containing that late Stop, steers after the cursor must be "not delivered", not "carried". SC-004 requires outcomes "as stated in US-5", making the contradictory scenario an explicit acceptance requirement.

   SC-004 also requires every accepted, not-stopped steer in the US-5 crash matrix to reach the surviving conversation exactly once. US-5 now explicitly contains a no-store case in scenario 8. That case must check the unchanged crash behavior and absence of a steer crash guarantee; it must not be subject to the exactly-once recovery requirement.

   **Proposed edit:** In US-5 scenario 3, distinguish saved recovery with no open Stop (later steers are carried) from saved recovery with a late open Stop (Stop is too late; steers after the cursor are not delivered). Keep steers at or below the saved cursor delivered in both completed-turn cases. Explicitly limit SC-004's steer recovery guarantee to the store-backed cases, while retaining the no-store case as a D4 compatibility observation. No change to the design or implementation is requested.

## Original finding disposition

| Finding | Status | Revised-spec evidence |
|---|---|---|
| F1: Outcome precedence and returned-error Stop | Resolved | FR-009 reproduces the full outcome table; stopped precedence and retry suppression are explicit. US-1 scenarios 3-4 and SC-003 cover the cases. |
| F2: Recovery guarantees and no-store exception | Partially resolved | Overview, FR-011 and FR-012 distinguish store-backed and already-saved recovery. US-5 scenario 3 and SC-004 still contain the two inconsistencies detailed above. |
| F3: Periodic versus notification-triggered query cost | Resolved | FR-021/FR-022 and SC-006/SC-007 distinguish unchanged turn-path calls from batched fallback looks, permit immediate notification looks and forbid idle periodic looks. |
| F4: Bounded settlement and send/confirmation failure | Resolved | FR-007/FR-008 and US-2 scenarios 4-6 state early-confirmation handling, the existing turn-timeout bound, same-turn settlement and send-failure recovery. |
| F5: Coordinated rollout and safe rollback | Resolved | FR-020 and US-6 scenarios 4-5 preserve older-worker compatibility and capable-worker availability through session drain. Flag-off is explicitly not orchestration rollback; reset authorization is excluded. |
| F6: Accepted-control idempotence and fallback protocol | Resolved | FR-004 scopes deduplication to recorded controls, discloses that refusals are not deduplicated and preserves transport-failure-only retry and new-message-id fallback. US-2 scenario 7 and US-4 scenarios 2-4 cover it. |
| F7: Write access and public operation layering | Resolved | FR-018/FR-019 preserve message-send write access and direct/Web API management operations; US-2 scenario 9 asserts no mutation or delivery for a read-only caller. |
| F8: Cost story and criterion traceability | Resolved | Stable US-1 through US-7 identifiers, US-7, FR-021/FR-022 and corrected SC links close the missing story/requirement chain. |
| F9: Provider/load/local acceptance evidence | Resolved | The evidence matrix and SC-010 cover design 7.1-7.8 plus the local path, named provider cells, missing credentials, listener providers, 1/10/50-turn measurements and deployment connection-budget fit. |

All eight resolved findings remain closed. Only the two corrections within original finding F2 are required for this focused re-review to pass.
