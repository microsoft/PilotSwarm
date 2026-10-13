Verdict: NEEDS-REVISION

# Session Turn Control - Specification Review

Reviewed `.paw/work/turn-control/Spec.md` against the binding design `docs/proposals/session-turn-control.md` revision 5 and the supplied WorkflowContext. All three documents were read from commit `3bae744b83017fabf6be4a98be080e13d68b3aea`, not from HEAD, the index, or working files.

The approved R1-R7 and D1-D5 decisions remain unchanged. API-level names and architecture constraints already required by the binding design are not treated as unnecessary implementation detail. This review covers the umbrella feature specification even though WorkflowContext assigns implementation workstream A to this branch.

**Findings:** 7 must-fix, 2 should-fix, 0 nits.

## Findings

1. **must-fix - Restore the exact stopped/error/completed outcome precedence.**

   **Spec location:** FR-009, line 116; Stop acceptance scenario 2, line 35.

   **Design reference:** 5.2, lines 954-964; 4.2 outcome precedence, lines 611-617; 3.11, lines 463-472.

   **Issue:** FR-009 unconditionally labels steers at or below the saved cursor "delivered", then applies the stopped-turn exception only to later steers. The design labels *every* steer of a stopped turn "not_delivered", including one previously confirmed in its now-discarded conversation. The spec also does not explicitly require a returned-error turn with an open Stop to return "stopped" and suppress automatic retry.

   **Proposed edit:** Replace the compressed FR-009 rule with the design's four-row, three-column outcome table, preserving stopped-turn precedence over the cursor. State that an open Stop on a returned-error turn changes the returned result to "stopped" and prevents automatic retry. Add acceptance coverage for a confirmed steer followed by Stop, and for a returned error with an open Stop, as well as every other table cell. Do not change D2 or D5.

2. **must-fix - Qualify recovery guarantees for late Stops and sessions without a store.**

   **Spec location:** Overview line 14; Stop acceptance scenario 5, line 38; Crash safety narrative and scenarios, lines 72-79; FR-012, line 119; SC-004, line 148. Relevant exceptions are already listed at lines 101, 157-161.

   **Design reference:** 1.3 R5-R6, lines 70-71; 1.4 D4 boundary, lines 80-81; 3.4, lines 301-303; 3.7, lines 371-379; 4.7 already-committed path, lines 798-810; 5.1-5.2, lines 940-961; D4-D5, lines 1117-1118.

   **Issue:** FR-012 says any retried turn that finds an accepted Stop ends "stopped". SC-004 likewise requires every accepted Stop in its entire crash matrix to end "stopped". A Stop can be accepted after final settlement but before the running mark is cleared, followed by a save and a crash before outcomes. Recovery must adopt that saved result, not run the model or replace the result; the late Stop then ends "too_late". The unconditional crash-safety prose also promises steer crash guarantees to sessions without a store, which D4 explicitly excludes.

   **Proposed edit:** Distinguish an unsaved retry with an actionable Stop from already-saved recovery and an existing durable stopped outcome. For unsaved recovery, apply the Stop without a model run. For saved recovery, reuse the saved result/cursor and apply the outcome table, allowing "too_late". Scope steer crash guarantees to sessions with a session store. Update the broad narratives and SC-004 to assert each case's expected outcome rather than universally "stopped"; retain the accepted stale-worker residual risk. Add a saved-result recovery scenario containing a late Stop.

3. **must-fix - Separate periodic-query cost from notification-triggered reads.**

   **Spec location:** FR-005, line 112; SC-006 and SC-007, lines 150-151; Cross-Cutting constraints, lines 138-139.

   **Design reference:** R7, line 72; 2.3, lines 156-158; 3.1, lines 188-209; 4.4, lines 695-718.

   **Issue:** SC-007 permits "at most one look query every 5 s" per busy worker without distinguishing periodic queries from notification-triggered queries. The design immediately looks when notified and separately performs one batched fallback look every five seconds. The spec's unconditional cap would prevent prompt reads for two controls arriving within five seconds. SC-006 also refers to all database round trips, whereas the no-controls guarantee concerns the existing turn-path CMS calls, not the new worker-wide fallback query.

   **Proposed edit:** Define the cost criterion as unchanged *turn-path CMS round trips* for a turn without controls, plus one additional notification connection per worker and one batched *periodic* look per busy worker every five seconds. Explicitly permit notification-triggered reads and require no periodic look while the worker has no running turns. Keep the normal-path latency target and five-second lost-notification fallback distinct.

4. **must-fix - Bound settlement and specify steer send/confirmation failure behavior.**

   **Spec location:** Steer acceptance scenarios, lines 45-49; FR-007 and FR-008, lines 114-115; Edge Cases, lines 90-102.

   **Design reference:** 4.5-4.6, lines 744-788; 7.2, lines 1030-1036.

   **Issue:** FR-008 requires waiting until an unconfirmed steer is confirmed and answered, but omits the existing turn-timeout bound. It can therefore be read as an indefinite wait. The spec also does not state that a failed steer send fails the turn and is recovered from the saved conversation, rather than silently discarding guidance. It lacks acceptance scenarios for confirmation arriving before send completion and for final idle arriving with an outstanding send.

   **Proposed edit:** Require settlement to remain bounded by the existing turn timeout; do not invent a new timeout. State that a send failure fails the turn and leaves recovery to the saved-conversation/open-control rules. Add observable scenarios proving that early confirmation is recognized, an outstanding send delays settlement through confirmation and the following idle, no steer starts a separate run after settlement/abort, and a failed send neither disappears nor becomes a false delivery. This is behavioral coverage, not a requirement to choose a particular class or data structure.

5. **must-fix - Capture the coordinated rollout and safe rollback constraint.**

   **Spec location:** Safe rollout story, lines 81-88; FR-016 and FR-017, lines 123-124; SC-008 and SC-009, lines 152-153; Scope and Dependencies, lines 169-189.

   **Design reference:** 6, lines 982-998.

   **Issue:** The spec covers flag gating, legacy sessions, capable-worker routing and the draft migration collision. It omits the requirement to deploy capable workers and portal/Web API together and the rollback requirement to retain workers able to run 1.0.81 until those sessions drain. Merely turning off Steer does not restore the old Stop race for new-version sessions. A rollback that removes all capable workers can strand those sessions.

   **Proposed edit:** Add an operator rollout/rollback requirement and acceptance scenario: additive migration remains compatible with old workers; workers and portal/Web API are rolled out together; rollback keeps capable workers until new-version sessions drain unless a separately authorized coordinated database/code rollback is selected. State explicitly that flag-off alone is not an orchestration-version rollback. This specification must not imply authorization for a database reset.

6. **must-fix - Limit idempotence to recorded controls and preserve the transport/fallback protocol.**

   **Spec location:** Visible-once acceptance scenarios, lines 67-68; Steer acceptance scenario 4, line 48; FR-003 and FR-004, lines 110-111; Edge Case line 94.

   **Design reference:** 4.2, lines 550-564; 4.3 client contract, line 681; 5.3, line 974.

   **Issue:** FR-004 promises the first answer for any request retried with the same id, including definite refusals. The design deduplicates recorded accepted controls, not refusal responses. After "no_turn", there is no recorded control; retrying that id when a later turn starts can create a new control. The spec says to fall back to an ordinary message but omits the crucial restriction that the refused control request must never also be retried.

   **Proposed edit:** Scope FR-004 and the changed-text/kind refusal to an already-recorded accepted control. Require retrying Stop/Steer with the same request id only after transport failure. After a definite no-turn refusal, require a new ordinary-message id for the fallback and prohibit retrying the refused control id. Add scenarios for an accepted control retried after its turn ends, and for a no-turn refusal followed by a new running turn, proving fallback and control retry cannot both deliver the text.

7. **must-fix - Preserve the existing write-access boundary on the new operation.**

   **Spec location:** FR-002 and FR-018, lines 109 and 125; Dependencies, lines 184-189.

   **Design reference:** 4.3, lines 653-655 and 677.

   **Issue:** The design explicitly assigns the Steer endpoint the same `session:write` access as ordinary message sending. The spec says all surfaces expose Steer but gives no authorization constraint. Request ids and actor recording do not substitute for access control.

   **Proposed edit:** Add a functional requirement that Steer uses the same write-access policy as sending a message and cannot mutate a session available only for reading. Require the management operation to be available through both direct and Web API modes, with MCP/CLI/UI using that operation rather than bypassing it. Add an authorized-write and unauthorized/read-only acceptance pair, asserting refusal produces no control event or model delivery. Preserve existing Stop authorization.

8. **should-fix - Repair the dangling cost story and success-criterion links.**

   **Spec location:** FR-019, line 126; SC-006 and SC-007, lines 150-151; User Stories, lines 29-88.

   **Design reference:** R7, line 72; 7.3 worker-stop case, line 1052; 7.8, lines 1103-1106.

   **Issue:** FR-019 maps to "Cost", but no Cost user story exists. SC-006 links to FR-009, which specifies outcomes, not the no-controls round-trip budget. The cross-cutting cost constraints have no corresponding story-linked FR. This leaves the requested FR-to-story-to-success-criterion chain incomplete.

   **Proposed edit:** Either add an independently testable P3 resource-cost/lifecycle story or explicitly extend Safe rollout with those acceptance cases. Give the R7 cost limits their own functional/non-functional requirement identifiers and link SC-006/SC-007 to them. Link listener shutdown to that real story and an acceptance scenario. Stable short story identifiers would also remove ambiguity between the two P1 and three P2 stories without changing their priorities.

9. **should-fix - Complete the acceptance evidence matrix for providers, load and the local path.**

   **Spec location:** Acceptance Scenarios, lines 33-88; SC-001 through SC-009, lines 145-153; Assumptions and Risks, lines 162-164 and 194-195; In Scope, line 174.

   **Design reference:** 4.12 local verification, lines 925-929; 7.1 concurrent ordering, lines 1021-1022; 7.4-7.5, lines 1056-1081; 7.7-7.8, lines 1094-1106; open checks, lines 1124-1126.

   **Issue:** Several tests are only implied by broad stories, a generic test-scope bullet, or risk references. There is no acceptance/evidence criterion for the model-provider cells on GitHub Copilot and Anthropic alongside the existing Azure AI Foundry evidence; look-query cost at 1, 10 and 50 turns; deployment connection-budget fit; or the local PostgreSQL flow. Concurrent admission/end-write ordering and stale-worker cancellation also lack their own explicit expected observations. Existing assumptions correctly disclose unfinished provider checks, but they do not define what evidence completes those checks.

   **Proposed edit:** Add a compact acceptance/evidence matrix mapping design 7.1-7.8 to stories, FRs and SCs. Include both orders of admission versus end-of-turn write, cancellation of a stale delivery with winner-result adoption, the provider immediate-send/final-message/after-idle/abort cells, missing-credential disclosure, stock PostgreSQL and HorizonDB listener coverage, local-instance Stop/Steer parity, and the 1/10/50-turn query-time/database-CPU measurements plus connection-budget check. Require measured results and explicit uncovered cells rather than inventing a new performance threshold or declaring untested providers compatible.

## Quality checklist result

**15 of 21 applicable criteria pass; 6 need revision.** The two research-integration criteria are not assessed: no SpecResearch.md was supplied for this assignment.

| Checklist area | Passing criteria | Criteria needing revision |
|---|---|---|
| Content quality | User value; no unnecessary code artifacts under the agreed platform-feature interpretation; clear story priorities; independently testable stories; at least one Given/When/Then scenario per story | Complete edge/error-mode coverage (findings 1, 2, 4, 6, 9) |
| Narrative quality | Four-paragraph overview; behavioral objectives; user perspective; measurable language; no verbatim narrative duplication | None |
| Requirement completeness | Measurable success criteria; documented assumptions | Internally consistent observable FRs (1-7); complete FR-to-story links (8); accurate SC-to-FR links (8); complete external constraints (5, 7, 9) |
| Ambiguity control | No unresolved questions or clarification markers in the spec body | Precise, consistent rules for outcome precedence, recovery and query budget (1-3, 6) |
| Scope and risk | Explicit in/out boundaries including all design non-goals; known risks and mitigations present | None |

No change to the approved design decisions is requested. The specification should be revised before planning uses it as the behavioral authority.
