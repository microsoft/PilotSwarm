Summary: 2 must-fix, 3 should-fix, 2 consider.

# Planning Documents Review: Session Turn Control

**Reviewer:** gpt-6.1-sol  
**Work ID:** turn-control  
**Source revision:** `ec71607b0b5bff07d365eed0d77d9d91286186a0`  
**Bundle:** Spec r5, ImplementationPlan r4, CodeResearch, binding design revision 5, and repository instructions.

This is one independent review for the parent-led multi-model synthesis. Findings are not applied, and this report is not an implementation-ready verdict. All citations below refer to immutable objects at `ec71607b`. No repository changes, builds, tests, dependency commands, or repository programs were executed.

## Findings

### 1. D6 needs a durable link from a carried steer to its stopped consuming turn

**Severity:** must-fix  
**Affected artifact:** plan  
**Criteria:** traceability, assumption consistency, completeness; A1 sufficiency for A/B/C.

**Issue:** The Spec requires the derived label "Carried, then stopped", and the plan assigns its production and rendering to separate workstreams. The contract supplies only `{seq, text}` and a result-level consumption boolean. The stopped event retains only the turn index and ordinary client-message IDs. It does not identify which carried controls this stopped turn consumed. C therefore has no defined durable evidence for the label after reload. Inferring the consumer as the original turn plus one is not valid given the retry behavior in the source.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec | `.paw/work/turn-control/Spec.md:152` requires carry through error retries and requires "Carried, then stopped"; `:211` fixes D6: no replay and the durable outcome remains `carried`. |
| Plan contract | `.paw/work/turn-control/ImplementationPlan.md:73` promises every cross-workstream type and hook in A1. `:189` defines `LateSteer {seq,text}` and `carriedSteersConsumed?: true`, but no persistent consumer association. |
| Plan producers | `.paw/work/turn-control/ImplementationPlan.md:292` sets consumption even for Stop at turn start. `:380-381` retains the stopped event with turn index/client-message IDs and clears the carried array on consumption. |
| Plan consumer/evidence | `.paw/work/turn-control/ImplementationPlan.md:65,458` derives the label "from the next turn's Stop", including bulk/live/reload; `:557` makes this UX-22's acceptance assertion. |
| Research | `.paw/work/turn-control/CodeResearch.md:302-330` documents that returned errors advance the turn index, while thrown errors do not. The plan itself preserves carried steers through pre-model returned errors (`ImplementationPlan.md:64,381,388`). |
| Source | `packages/sdk/src/orchestration/turn.ts:650-651` advances the index for a non-gate-refused result. `:1585-1592` writes `session.turn_stopped` without carried-control sequences. `packages/sdk/src/session-proxy.ts:4018-4025` writes `session.turn_started` with only `iteration`. Research describes client-message-ID, not steer-sequence, reconciliation in `.paw/work/turn-control/CodeResearch.md:1012-1018`. |

For example, a steer carried from turn n can survive a pre-model error at n+1 and be stopped at the start of n+2. Conversely, a successfully consumed carried steer must not be relabelled by an unrelated later Stop. Adjacency or an arbitrary later stopped event cannot establish the relationship. Stop at start also cannot rely on the normal model-start event.

**Suggested resolution:** Add a durable, explicit association to the shared contract before B/C begin. One compatible direction is to enrich the existing `session.turn_stopped` event with the carried-control sequence IDs disposed by that turn, including Stop at start, captured before the carried state is cleared. Specify A1's payload/type, A4/B2's producer responsibility, and C3's bulk/live consumer. Keep D6 and immutable control outcomes unchanged. Add positive cases through pre-model errors, waits, thrown retries, and continue-as-new, plus a negative case in which an unrelated later Stop must not change the label.

### 2. A1 omits the trusted caller contract required by C1's flag check and attribution

**Severity:** must-fix  
**Affected artifact:** plan  
**Criteria:** assumption consistency, feasibility, cross-workstream contract completeness.

**Issue:** A1 defines the actor type and requires an actor argument at the catalog, while P7 requires the management operation to resolve steering for the caller. Its public Stop/Steer option types contain no actor, principal, viewer, or trusted-context hook. C1 is told to forward options unchanged. The current direct management client is not bound to one caller, and the existing feature operations take an explicit `FeatureViewer`. Thus the sealed contract does not tell C how to supply authenticated attribution and caller-specific flag resolution without returning to A-owned shared types or inventing a different policy.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec | `.paw/work/turn-control/Spec.md:156-158` requires flag enforcement, message-equivalent write access, and direct/Web API parity; `:165` defines a control with its actor; `:186` requires refusal for a read-only caller. |
| Design | `docs/proposals/session-turn-control.md:504-505` includes actor on both request events. `:659-667` passes `actor` to `turnControlAdd`, but the illustrated options do not establish where it comes from. |
| Plan | `.paw/work/turn-control/ImplementationPlan.md:59` says resolve the flag "for the caller"; `:190` chooses normalized `MessageSender`; `:191` defines options containing only text/reason/timeout/request ID; `:201` requires `actor: MessageSender | null` at the catalog; `:202` permits user flag overrides. C1 (`:424-427`) repeats the caller-specific flag check and directs transport forwarding without defining trusted context. |
| Research | `.paw/work/turn-control/CodeResearch.md:794-796` says permitted user preference changes the effective flag. `:812-820` identifies explicit management feature reads and says bootstrap does not supply effective steering policy. |
| Source | `packages/sdk/src/management-client.ts:669-714` defines a direct client configuration with no current caller. `:4921-4929` passes explicit `FeatureViewer` to feature operations. `packages/sdk/src/feature-flags.ts:66-70` makes a user override material to the result. |
| Existing secure pattern | `packages/app/web/runtime.js:660-674` derives owner/role from the authenticated context and authorizes the call. `:1105-1108` overwrites client-supplied message sender; `:1546-1563` stamps identity from that context. `packages/sdk/src/message-sender.ts:7-13` expressly distinguishes server-stamped attribution from authorization. |

Checking the session owner's flag is not equivalent to checking a collaborator's flag. Taking a sender supplied by an HTTP body is not equivalent to authenticated attribution. A nullable catalog actor alone resolves neither problem.

**Suggested resolution:** Complete A1 with the exact trusted caller/actor propagation interface C1 will consume, using the existing principal/viewer and normalized sender patterns. Define how trusted direct-mode callers supply context and what an explicitly unauthenticated trusted caller means. At the Web API boundary, derive and overwrite identity from validated auth, not request-body fields. Keep authorization at the existing gate, flag resolution on the caller, and event attribution consistent. Add owner-versus-collaborator flag-override tests, forged-actor rejection/overwrite tests, direct/web parity, and Stop attribution with steering disabled.

### 3. P13's trace-only confirmation signal conflicts with durable tuner observability

**Severity:** should-fix  
**Affected artifact:** plan  
**Criteria:** assumption consistency, feasibility of acceptance evidence.

**Issue:** The plan deliberately measures SC-002 with a new worker trace diagnostic and excludes a durable session event. The binding design says the signals are session events reachable through existing event APIs/tuner tools, and repository instructions require any useful new diagnostic to be persisted and tool-accessible. An outcome timestamp also cannot substitute for the confirmation timestamp: outcomes are settled later. The new trace is useful, but by itself does not satisfy those cross-artifact requirements.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec | `.paw/work/turn-control/Spec.md:175` requires existing event/tuner access without metric tables; `:180` measures acceptance to model confirmation; `:199` requires the real-model UI latency evidence. |
| Design | `docs/proposals/session-turn-control.md:918-921` says "All signals are session events" accessible through existing event reads and tuner event tools; `:1089-1091` distinguishes Stop and Steer latency. |
| Plan | `.paw/work/turn-control/ImplementationPlan.md:66` specifies `steer-confirmed` with `acceptedAt` and `confirmedAt`, explicitly "No new session event"; `:293` implements that trace; `:554` uses it as UX-18's measurement source. |
| Repository rules | `.github/copilot-instructions.md:445-458` requires useful new diagnostics to be durable and exposed through the management client; `:459-470` requires tuner-tool reachability and coverage. |

**Suggested resolution:** Preserve the measurement endpoints and the existing SDK `user.message` transcript filtering, but supplement the trace with a durable, non-transcript confirmation diagnostic containing the control sequence and confirmation timestamp. Route it through existing session-event management/tuner reads, with the needed typed contract and coverage. Do not settle the control outcome early, add a metric table, or expose duplicate user messages. Update A1/A4 and UX-18 to name the durable evidence source. P13 needs this amendment because of the explicit design/repository conflict, not because another logging format is preferred.

### 4. The selector contract excludes real initial and legacy Stop states

**Severity:** should-fix  
**Affected artifact:** plan  
**Criteria:** completeness, compatibility, coverage of every visible Stop/Steer state.

**Issue:** C3 declares its selector/attribute list exhaustive and says product turn states pass through unnormalized. It omits the actual `pending` session state. It also requires a `data-control-seq` on every Stop line, yet the retained legacy Stop path produces no new control event/sequence and can return `stop_forced`, which the exhaustive outcome vocabulary does not represent. UX-14/15 promise legacy operation and reload coverage without resolving this representation.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec | `.paw/work/turn-control/Spec.md:155,158,181,186` requires legacy Stop, client parity, once-only rendering, and outcomes surviving reload. |
| Design | `docs/proposals/session-turn-control.md:668-678` retains the legacy fallback and removes separate `stop_forced` reporting only on the new path; `:1080-1081` retains the legacy test. |
| Plan | `.paw/work/turn-control/ImplementationPlan.md:469` omits `pending` while specifying unnormalized product states; `:471-472` requires Stop sequence/outcome attributes; `:476-477` declares all visible states covered and requires exhaustive e2e assertions. `:550-551` requires legacy Stop and reload. C1 retains today's event path (`:424`). |
| Source | `packages/sdk/src/types.ts:692-701` includes `pending`. `:1727-1731` includes legacy `stop_forced`. `packages/sdk/src/management-client.ts:2536-2540` returns the legacy result and turn index, not a control sequence. `packages/sdk/src/orchestration/turn.ts:744-755` records legacy `session.turn_stopped` plus `system.message`, not `user.stop`/`session.control_outcome`. |
| Research | `.paw/work/turn-control/CodeResearch.md:1012-1023` identifies the existing legacy stopped-event/system-message rendering and reconciliation. |

**Suggested resolution:** Add `pending` with controls unavailable. Define how a legacy Stop is selected and correlated without fabricating a new control sequence: for example, an explicit legacy marker and existing stopped-event identity. Specify whether `stop_forced` maps visibly to `stopped` or retains a distinct notice, and cover that choice in bulk/live/reload tests. The public legacy behavior may stay unchanged.

### 5. Three parent UX scenarios lack a defined browser entry path

**Severity:** should-fix  
**Affected artifact:** plan  
**Criteria:** feasibility, completeness of the parent UX test pass.

**Issue:** U1 says every test agent drives the portal and asserts the C3 selectors, but UX-11/12 require invoking controls when their buttons are not offered, while UX-13 expects an API refusal to become a browser notice although the read-only composer is hidden. A direct HTTP call can prove authorization without causing the UI controller to display that notice. The plan does not distinguish that evidence from a browser-driven state-change race.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec | `.paw/work/turn-control/Spec.md:131-134` distinguishes acceptance/refusal/fallback; `:157` requires no event or delivery for an unauthorized caller; `:199` requires real-model browser/TUI evidence. |
| Design | `docs/proposals/session-turn-control.md:903-904,1087` offers Steer only for an eligible running turn; `:1083-1092` requires browser and TUI flows. |
| Plan | `.paw/work/turn-control/ImplementationPlan.md:458,468` gates Steer on eligibility. `:531` says agents drive the portal; `:547-549` expects browser notices for idle Stop, idle Steer fallback, and a read-only API refusal. No driver is specified for those calls. |
| Source | `packages/app/ui/react/src/web-app.js:6996-7007` replaces the read-only composer rather than offering controls. `:9529,9874-9883` offers Stop only while running or while its request is pending. `packages/app/ui/core/src/controller.js:10715-10736` can process a no-active-turn response if invoked, but an HTTP call outside that controller does not execute its notice handling. |
| Research | `.paw/work/turn-control/CodeResearch.md:1000-1003` distinguishes controller, running-only selector, composer, and TUI shortcut entry points. |

**Suggested resolution:** Make each scenario reproducible without adding idle/read-only buttons. For browser fallback/no-active-turn notice assertions, specify a controlled race: begin from an eligible visible control, end the turn before server admission while the client has not refreshed, then assert the refusal/fallback and once-only transcript behavior. For read-only access, assert hidden controls plus a separately authenticated API refusal and no event/delivery; require a browser `forbidden` notice only in a defined revocation/stale-permission race initiated through the UI. Keep real-model outcome evidence distinct from C3's fake-transport notice coverage.

### 6. Parent UX coverage should identify mobile and multi-panel target contexts

**Severity:** consider  
**Affected artifact:** plan  
**Criteria:** completeness, shared product UX consistency.

**Issue:** C3 adds another action next to Stop, and U1 uses selectors that can repeat across MoA session panels. The plan does not name a narrow viewport, Zen/MoA variants, selector scope, or an inactive-session assertion. Existing source already treats Stop reachability and focused-session targeting in those contexts as maintained behavior.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Spec/design | `.paw/work/turn-control/Spec.md:158,199` and `docs/proposals/session-turn-control.md:908-910,1083-1092` require shared portal/TUI behavior and browser evidence. |
| Plan | `.paw/work/turn-control/ImplementationPlan.md:460,467-468` places Steer beside Stop; `:531-558` supplies selectors/scenarios without viewport or panel scope. |
| Repository rules | `.github/copilot-instructions.md:760-770` requires non-overlapping action icons, dashboard-scoped interaction, and Stop visible for the focused running session. |
| Source/research | `packages/app/web/test/e2e/mobile-header-status.spec.mjs:8-9` covers Zen/MoA and themes; `:108-130` asserts 320 x 400 reachability, 44 x 44 Stop target size, focused-session routing, draft/focus preservation, and pending disablement. `.paw/work/turn-control/CodeResearch.md:1023,1035` identifies this maintained Stop coverage. |

**Suggested resolution:** Add a compact U1 viewport/panel matrix, scope selectors by the active session's composer/transcript, and assert the other panel receives no control. Extend the existing narrow-mobile Stop test with flag-on Steer beside Stop and Send, preserving touch targets, draft/focus, and pending states. Do not change keybindings or dashboard behavior.

### 7. Plan provenance still names Spec r3 although its dependencies are r5

**Severity:** consider  
**Affected artifact:** plan  
**Criteria:** cross-artifact consistency, review provenance.

**Issue:** The plan's overview and reference list identify Spec r3 even though its body incorporates D6 and this sealed review bundle contains Spec r5. This is not evidence of an implementation omission, but it makes the plan's approved input revision ambiguous.

**Evidence:**

| Artifact | Evidence at `ec71607b` |
|---|---|
| Plan | `.paw/work/turn-control/ImplementationPlan.md:5,577` says Spec r3; `:65` incorporates D6 and `:557` tests it. |
| Spec | `.paw/work/turn-control/Spec.md:3` identifies revision r5; `:152,211` contains the D6 requirement and final owner decision used by the plan. |

**Suggested resolution:** Update both references to the actual Spec r5 and preserve the reviewed commit identity in the review record. No decision or requirement change is needed.

## Requested special checks

| Check | Result |
|---|---|
| FR/SC phase traceability | The plan maps FR-001 through FR-022 and SC-001 through SC-010 (`ImplementationPlan.md:120-145`). No wholly unmapped FR/SC was found. Findings concern contract/evidence completeness, not a missing phase row. |
| File-ownership disjointness against source | The production A/B/C partition is workable as written (`ImplementationPlan.md:73-98`). No demonstrated existing-file double edit was found. A1 running `agent-handoff-routing.test.mjs` is not A ownership of its edits; B1 explicitly owns its pin update (`:360`). Findings 1 and 2 must be closed in A1 so the stated no-cross-owner-edit guarantee can hold. |
| A1 sufficiency for B/C | Incomplete for durable D6 correlation and trusted caller propagation; findings 1 and 2. The wake prompt, control cursor, consumption marker, close-controls hook, detailed-view eligibility, and V4 routing are otherwise explicitly assigned. |
| Parent UX versus Spec/design 7.6 | Core running-turn, carry, Stop, reload, flag, legacy, latency, and TUI scenarios are present. Findings 3 and 5 concern the evidence source and executable drivers; finding 6 concerns maintained viewport/panel coverage. |
| Every visible Stop/Steer state has selectors | C3 provides broad pending/request/outcome/refusal/retry coverage, but its exhaustiveness claim does not cover initial `pending` or define the retained legacy Stop representation; finding 4. |
| Scope coherence | No unrelated feature expansion or contradictory out-of-scope work was found. One additive migration, no new table/index, provider-neutral core behavior, and rollback without an implied reset remain intact. |

## Decisions left intact

D1-D6, R1-R7, and the plan decisions are not reconsidered for preference. Findings 1 and 2 complete implementation contracts without changing semantics. Finding 3 identifies P13's explicit conflict with the binding design and repository observability rules. P12's consumption marker remains necessary; the existing `pastGates` heuristic is not a valid substitute. P16 already prevents release/deployment/main merge of A1's temporary V4 aliases, so that temporary integration mechanism is not reported as a rollout defect. Source confirms filesystem test discovery rather than the stale prose's `SUITES` list; no artificial registration edit is requested.

**Disposition:** Independent review complete; synthesis and resolution pending. Two must-fix planning contracts remain before the bundle can support implementation without cross-stream assumptions.
