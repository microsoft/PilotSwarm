Verdict: NEEDS-REVISION

# Session Turn Control - Plan Review

Input revision: `847d90b46adcf550a60e8a69137f5c3c429ec700`.

Reviewed `.paw/work/turn-control/ImplementationPlan.md` against Spec r3, design revision 5, CodeResearch, WorkflowContext, repository instructions, and immutable source at that revision. All source citations below refer to `847d90b4`. This is a plan review, not execution evidence.

## Findings

1. **BLOCKING - The public session view cannot supply the control-capability predicate.**

   **Plan location:** P5, A1 (`ImplementationPlan.md:57,144,152`), C1 (`:370-374`), C3 (`:405,416`).

   **Evidence:** `PilotSwarmSessionView` is declared in `packages/sdk/src/management-client.ts:392-442`, not `types.ts`. It exposes neither `activeTurnIndex` nor `turnHigh`. The detailed view is explicitly constructed at `management-client.ts:1315-1357` and drops both fields. The list mapper at `:355-386` also constructs its own shape. Adding `SessionRow.turnHigh` does not make it available to the public client, portal, or TUI. The controller's merge skips undefined values (`packages/app/ui/core/src/controller.js:452-462`), so an omitted cleared value can also retain stale eligibility.

   **Impact:** C3 cannot implement `acceptsTurnControl` or reliable button visibility from the supported client surface as planned. This affects FR-016, FR-017, FR-019 and SC-008.

   **Proposed edit:** Add a C1 contract item for the public detailed-session view: expose nullable `activeTurnIndex` and `turnHigh`, or an explicit derived `acceptsControls` boolean, through direct/web reads and UI detail refresh. State how list rows behave without these fields and how eligibility becomes explicitly false when a turn ends, waits, or changes version. Add direct/web shape and controller-refresh assertions. C owns `management-client.ts`; A owns catalog/procedure changes, so this does not require overlapping ownership.

2. **BLOCKING - Copying the current `pastGates` predicate can discard an undelivered carried steer.**

   **Plan location:** A1 result contract (`:140-143`), A4 (`:239-246`), B2 (`:330,337`).

   **Evidence:** B2 says to clear carried steers at the same place as `budgetStash`. That predicate is `!budgetRefusal && (!state.config.workspace || result.workspaceAttached === true)` (`packages/sdk/src/orchestration/turn.ts:1301-1320`). Provider-admission exceptions return `{type:"error"}` before the workspace gate, turn start, or model run (`packages/sdk/src/session-proxy.ts:1773-1785`). For a session without a workspace, that returned error satisfies `pastGates`. Design sections 4.7 and 4.9 require gates before delivery and carrying into an error retry; Spec FR-013 and SC-005 prohibit losing carried steers.

   **Impact:** A carried steer can be removed from orchestration state although the activity never used it. Its original request already has a carried outcome; reading open controls for the new turn does not recover that text.

   **Proposed edit:** Make A1 define an explicit activity-result contract proving consumption of carried input, and make A4 produce that evidence only when the carried text was actually used, including the already-committed path. B2 must retain carried text on gate waits and pre-model returned errors, and clear it only on consumption or an explicitly terminating disposition. Add tests for admission failure without a workspace, workspace refusal, returned-error retry, thrown-error retry, and successful consumption. Keep the frozen versions' existing predicate unchanged.

3. **BLOCKING - The planned pre-PR deployment has no executable route in the existing workflow.**

   **Plan location:** U1 (`:468`), dependency order (`:97`).

   **Evidence:** `.github/workflows/deploy-azure.yml:4-12` accepts a published release tag, not a candidate SHA or PR. Its job requires `refs/heads/main` (`:21`); release selection requires a published version tag in main history (`:40-49`). `.github/DEPLOYMENT.md:26-36,59-66` distinguishes main/release deployment from pre-merge testing. The repository's instructions likewise restrict managed deployment to Actions (`.github/copilot-instructions.md:594-611`).

   **Impact:** The parent cannot deploy `waldemort/turn-control` as U1 requires before opening F1 using the stated existing path.

   **Proposed edit:** Add a parent-owned prerequisite before U1 that establishes an approved, immutable-candidate deployment route or approved test host for the integration commit. Specify its workflow/target, authorization, source-identity evidence, and restoration obligations. Assign any workflow changes exclusively to the parent. Do not substitute a local managed-environment mutation, a release publication, or an early merge to main. U1 remains pending until that route is available.

4. **BLOCKING - Client request-ID lifetime across transport ambiguity is not planned or tested.**

   **Plan location:** A1 (`:142`), C1 (`:371-374`), C3 (`:405,422`).

   **Evidence:** Spec FR-004 and design 4.3 require same-ID retry only after transport failure, distinct from a definite refusal followed by an ordinary message with a new ID. The existing controller creates no Stop request ID and clears its in-flight state after any exception (`packages/app/ui/core/src/controller.js:10728-10745`). The native transport reconstructs Stop options (`packages/app/tui/src/node-sdk-transport.js:1559-1563`), so it must explicitly forward a new request ID. C1's deduplication tests prove server behavior, not client preservation after an accepted request's response is lost.

   **Impact:** A second client attempt can create a second control or target a later turn after an ambiguous first attempt. A premature message fallback can duplicate accepted steering.

   **Proposed edit:** Add C1/C3 work and success criteria for request IDs retained with immutable kind/text across an ambiguous attempt, passed intact through every transport, and reused only for that retry. Specify that definite refusals do not trigger control retry, and only `no_turn`/the chosen legacy refusal produce the new-ID ordinary-message fallback. Add controller and direct/web tests in which the server accepts, the response is lost, the turn ends, and a same-ID retry returns the original answer with one request and one transcript item.

5. **BLOCKING - U1 can complete with failing acceptance scenarios.**

   **Plan location:** U1 success criteria (`:493-495`), F1 (`:499-501`).

   **Evidence:** U1 requires only that each scenario have a recorded pass/fail result and that failures be filed. Its latency criterion requires reporting percentiles, not meeting the specified thresholds. Spec SC-001 and SC-002 require p95 at most 2 s; SC-003 requires correct once-only rendering; SC-005 requires carried-steer delivery. Design 7.6 is an acceptance pass, not just a failure inventory.

   **Impact:** The dependency gate permits F1 after incorrect UX or missed latency targets without a correction round.

   **Proposed edit:** Require every covered mandatory scenario to pass before U1 completes. Route failures back to their owners, then rerun the affected scenario against the corrected integration commit. Require both latency thresholds under the specified conditions, with the documented abort-ignoring CLI exclusion. Keep explicitly unavailable evidence labeled not covered with its reason; do not count it as a pass or silently waive a failed scenario. Preserve initial failure evidence and bind the final report to the actual candidate.

6. **IMPROVE - The A1 interface handoff is not fully typed.**

   **Plan location:** A1 (`:141-154`), A3 (`:209-210`), A4 (`:242`).

   **Evidence:** `turnLook(turns)` has no explicit input shape, although design 4.2 requires `[{session, turn, after}]` (`docs/proposals/session-turn-control.md:592-598`). `turnEnd(..., result)` needs the discriminator `"stopped" | "error" | "other"` (`:601-604`), not an unconstrained result. A1 says `StopTurnOptions` "gains" a field, but the existing method uses an inline options type (`packages/sdk/src/management-client.ts:2498-2501`). Existing best-effort writes produce `undefined` on failure (`packages/sdk/src/cms-retry.ts:135-145`); design 4.7 distinguishes that from a successful `false` (`docs/proposals/session-turn-control.md:820-829`).

   **Proposed edit:** Enumerate and type the look input, end-kind discriminator, actor shape, new Stop options type, helper input, and all public exports in A1. Include the consumption evidence from finding 2. State explicitly that `hasControls === false` alone skips turn end; a write failure must not become false. Add contract assertions for the method signatures and the failed-writeback path. This makes A1 a complete handoff rather than requiring B/C to settle type decisions after branching.

7. **IMPROVE - One shared file violates the claimed disjoint ownership.**

   **Plan location:** Ownership (`:67,87-89`), A4 (`:246`), A5 (`:271`), I1 (`:454`).

   **Evidence:** The plan states that every file has one owner but assigns `scripts/provider-test-coverage.json` to all three writers. It also extends the existing `test/helpers/run-turn-activity-harness.mjs` without naming that helper's owner. A5 leaves its measurement location as `perf/` or a new script, rather than selecting an artifact path. Actual SDK test discovery already covers `test/local/**/*.test.js`; the plan correctly does not invent the obsolete `SUITES` list. C2 correctly owns the app's explicit `test:mcp` registration.

   **Proposed edit:** Make the coverage manifest parent-owned and accept per-workstream proposed entries, applied once during integration. Explicitly assign the existing activity helper to A and specify its V4-selection extension. Choose the measurement script path. Preserve B's ownership of routing/freeze tests and C's app/package-list ownership. Running another owner's tests is not an ownership conflict.

8. **IMPROVE - The selector contract omits visible refusal and failure states.**

   **Plan location:** Desired state (`:36`), C3 selector table (`:409-422`), UX scenarios (`:474-489`).

   **Evidence:** A1 includes `not_found` and `request_id_reused` refusals (`:141`), but `control-notice.data-reason` includes neither. Transport failures and failed sends are also visible client states, and finding 4 adds an ambiguous-attempt state. `session-turn-state` lists only running/idle/waiting/error although question flows are an explicit scenario. The owner's requirement is a stable selector for every user-visible Stop/Steer state.

   **Proposed edit:** Define a complete visible-state inventory and map every state to a selector/attribute value, including all API refusals, transport ambiguity/failure, timeout, fallback failure, and question/terminal behavior. Document intentional normalization of product statuses rather than silently omitting them. Add C-owned fake-transport assertions for all rows, and parent UX coverage for normal-message fallback during an actual end-of-turn race, ambiguous response retry, and refreshed eligibility. Preserve the existing real-model scenarios, which already cover the main delivered/carried/stopped flows.

9. **IMPROVE - UX-18 lacks a source for its confirmation timestamp.**

   **Plan location:** I1 measurements (`:457`), UX-18 (`:491,495`).

   **Evidence:** SC-002 measures model-run confirmation; design 7.6 identifies the SDK `user.message` event (`docs/proposals/session-turn-control.md:1089-1091`). The current activity filters SDK `user.message` out of durable CMS events to avoid duplicates (`packages/sdk/src/session-proxy.ts:3803-3810`). The durable ordinary-message event is not proof that a steer was confirmed, and the final control outcome is a different endpoint.

   **Proposed edit:** Specify correlated capture of the actual SDK confirmation/message ID and timestamp through the control watch or an approved diagnostic evidence channel, together with the accepted request sequence/timestamp. Do not measure against the initial ordinary-message record or final outcome, and do not re-enable duplicate transcript messages. Define the 30-run percentile calculation and record model/provider, turn workload, duration, and between-tool condition.

10. **IMPROVE - Add explicit requirement traceability, rollout responsibility, and the deployment connection-budget check.**

    **Plan location:** Phase requirement summaries, A5 (`:271-284`), C4, I1 (`:451-462`).

    **Evidence:** The plan broadly cites all FRs in A1, but has no requirement-to-phase/test mapping. Spec FR-020 requires coordinated capable-worker/API rollout and retaining 1.0.81-capable workers during rollback until sessions drain. Design section 6 gives that rule (`docs/proposals/session-turn-control.md:980-995`). Spec evidence row 7.8 requires the deployment's `max_connections` budget (`Spec.md:200`). A5 measures one extra connection and query/CPU costs but does not assess the total deployment budget.

    **Proposed edit:** Add a compact FR-001..FR-022 and SC-001..SC-010 mapping to implementation owner, test/evidence, and success criterion. Assign FR-020's rollout/rollback procedure to a parent-owned integration item and canonical documentation, explicitly without a reset. Extend evidence 7.8 to compare configured worker count, existing pools, and one listener per worker with the database connection budget and reserved headroom. Record stock PostgreSQL and HorizonDB listener coverage or the permitted not-covered reason. Keep query-cost measurements observational; invent no new threshold.

11. **IMPROVE - State the test-integrity restrictions for all workstreams and the UX pass.**

    **Plan location:** Phase verification lists, I1 (`:455,461`), U1 (`:494`).

    **Evidence:** I1 explicitly preserves parallelism and references the repository qualification rule. The existing browser runner is fully parallel with `retries: 0` (`packages/app/web/playwright.config.mjs:7-11`). Repository instructions permit exactly one limited sequential verification after complete initial release coverage and require preserved initial results (`.github/copilot-instructions.md:621-624`); the subsequent Test Integrity Rules prohibit hidden retries and assertion weakening.

    **Proposed edit:** Add one shared invariant: no test retry configuration, repeat-until-green loops, weakened assertions, compensating custom prompts, arbitrary sleeps, or reduced committed parallelism. Distinguish a correction followed by targeted verification on a new candidate from qualification on unchanged source. Retain the exact repository qualification limits and both initial/final reports. There is no demonstrated current parallelism violation; this closes an underspecified acceptance rule.

12. **NOTE - Preserve the sound replay and migration approach, with precise compatibility assertions.**

    **Plan location:** P2/P3/P11, A1, A2, B1/B2.

    **Evidence:** All current `createSessionProxy` callers are in B-owned orchestration modules: lifecycle (`packages/sdk/src/orchestration/lifecycle.ts:207,344,1036`), runtime (`runtime.ts:146,174`), and turn (`turn.ts:386,1137`). A owns the shared proxy. Its old optional payload serialization is at `packages/sdk/src/session-proxy.ts:709-751`; `updateCmsState` has property-presence semantics at `:1085-1092,5723-5737`. The freeze-test pattern self-identifies frozen versions and keeps them registered (`packages/sdk/test/unit/orchestration-freeze-1-0-71.test.mjs:34-105`). The writeback procedure currently has 23 parameters and returns VOID (`packages/sdk/src/cms-migrations.ts:7235-7259`); A2 correctly requires DROP/CREATE, a new migration, and its companion diff. P11 correctly reflects state changes clearing the active turn (`cms-migrations.ts:13007-13040`).

    **Proposed edit:** Retain those choices. Make old-proxy assertions cover omitted/null optional fields, epoch/workspace routing, activity names, inputs, affinity, and tags for both legacy contracts. Require frozen 1.0.80's self-version to remain literal and deterministic time/GUID/timer helpers in B2. For the changed session-read procedure, preserve the actual placement-aware read path and existing fields; determine the exact overload from the implementation, not just an older one-argument definition. Clarify P11's message fallback as a Steer behavior, not sending a Stop reason as an ordinary user message. Explicitly prohibit promoting the A1 V4 alias until A4 is complete.

## Assessment

| Criterion | Assessment |
|---|---|
| Spec coverage | Broad runtime, crash, routing, outcome, UI, and provider coverage is present. FR-004 client ambiguity behavior, FR-013 pre-model retention, FR-020 rollout responsibility, and evidence 7.8 need the edits above. |
| Feasibility and dependencies | Contract-first branching and A4-dependent live tests are sensible. U1's deployment route is infeasible as written; its completion gate is too weak. |
| Disjoint ownership | Source ownership is workable after completing A1/C1. The manifest exception and helper ownership need resolution; no other mandatory cross-owner source edit was demonstrated. |
| Research integration | Existing proxy, gate, budget-carry, routing, test discovery, and documentation patterns are used. The existing carry predicate must not be copied without stronger delivery evidence. |
| Documentation and strategy | Documentation phases, Docs.md, canonical docs, templates, samples, exclusions, and architectural decisions are present. A5's measurement path and the requirement mapping need specificity. |
| UX acceptance | The 18 scenarios cover the main design 7.6 flows and preserve C's own tests. Full visible-state selectors, ambiguous retries, confirmation evidence, and passing gates remain incomplete. |
| Replay and migrations | The additive migration and frozen-version approach are appropriate. Preserve historical proxy descriptors and released migrations; do not change old orchestration behavior. |
| Test integrity | Existing parallel/zero-retry settings and I1's parallelism rule are sound. Make their preservation explicit for the new tests and parent UX pass. |

**Recommendation:** Revise the plan before implementation. Re-review the numbered findings against the revised immutable plan; no repository implementation or test execution is requested from this read-only activity.

**Finding counts:** BLOCKING: 5; IMPROVE: 6; NOTE: 1.
