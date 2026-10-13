Verdict: NEEDS-REVISION

Counts: **1 must-fix, 3 should-fix, 1 consider** (5 open issues: 1 residual first-cycle issue and 4 newly identified gaps). First-cycle findings: **6 Resolved, 1 Partly resolved, 0 Not resolved**.

# Planning Documents Re-review: Session Turn Control

**Reviewer:** gpt-6.1-sol  
**Work ID:** turn-control  
**Cycle:** 2  
**Source revision:** `0387490194d7fd8549e82655a9eb5464781c8dc7`  
**Bundle:** Spec r6, ImplementationPlan r5, CodeResearch, binding design revision 5, first-cycle reviews and synthesis.

Every file:line citation below refers to this exact source revision. This is a planning-document verdict, not an implementation verdict. Source inspection used immutable Git objects in the assigned workspace. No repository code, builds or tests ran; no source files changed. The parent supplied the multi-model configuration and resolution context; this worker performed only its assigned independent re-review.

## First-cycle findings F1-F7

| Finding | Status | Evidence and assessment at `0387490` |
|---|---|---|
| F1: D6 needs a durable link to its consuming turn | **Partly resolved** | `ImplementationPlan.md:70,207,209` defines `session.carried_steers_closed { seqs, turnIndex, reason }`; `:316` supplies the consumption marker, `:406,409,419` assigns B2 production and later-index/unrelated-Stop cases, and `:490,503` assigns C3 derived labels. This is the missing sequence-based association. However, `:65,489` still directs derivation from the next turn's Stop, contradicting P17. `Spec.md:78` still equates the carrying turn with the next gate-passed turn. Residual issue R2-1 below. The new event also needs the persistence and paging guarantees in R2-2/R2-3. |
| F2: A1 lacks trusted caller propagation | **Resolved** | `ImplementationPlan.md:71,206` defines optional `TurnControlCaller { sender?, viewer? }` on both option types and explicitly defines cluster-scope/null-actor direct-mode defaults. `:59,452,454` assigns caller-specific flag resolution and authenticated Web API overwrite; `:464` requires owner/collaborator, forged-sender, parity and flag-off Stop attribution cases. `Spec.md:167-169` retains caller-specific gating and access parity. |
| F3: Trace-only confirmation conflicts with durable observability | **Resolved** | `ImplementationPlan.md:66,207,209,282,287` defines and produces non-transcript `session.steer_confirmed { seq, turn, messageId }`, accessible through existing event/tuner reads; `:590` measures acceptance-to-confirmation using its database timestamp. `:490` excludes it from transcript rendering. `Spec.md:16,186,191` authorizes the durable diagnostic and preserves the confirmation measurement. This remains best-effort diagnostic evidence; a missing measurement must not count as a pass (`ImplementationPlan.md:601`). The stale UX identifier in P13 is R2-5, not a missing observability mechanism. |
| F4: Selectors omit initial and legacy Stop states | **Resolved** | `ImplementationPlan.md:500` adds `pending` to the unnormalized turn states; `:504` gives legacy Stop its own sequence-free selector and `stopped`/`stop_forced` vocabulary; `:75,490,508-509` assigns the legacy line and exhaustive component coverage. `:586` defines legacy-session setup through U0, and `:463` assigns the retained live legacy case. New controls still use their real sequence IDs. |
| F5: Idle/read-only browser scenarios lack an entry path | **Resolved** | `ImplementationPlan.md:568` defines route hold/drop. `:583-584` starts with a visible running-turn action and holds admission until idle. `:585` separates hidden read-only controls, authenticated API refusal, and the visible-control permission-revocation race. `:592` covers a lost response without ordinary-message fallback. No idle/read-only buttons are added. |
| F6: Mobile/MoA targeting absent | **Resolved** | `ImplementationPlan.md:508` scopes controls to session containers; `:509` assigns the maintained mobile test extension with 320 x 400 sizing, 44 x 44 targets, focus/draft retention and focused-session routing. `:595` adds the desktop/mobile, Zen/two-panel MoA and light/dark matrix with the other panel unchanged. |
| F7: Plan references Spec r3 | **Resolved** | `ImplementationPlan.md:5,615` now consistently identifies Spec r6, matching `Spec.md:3`. The historical decision entry at `ImplementationPlan.md:182` describes the earlier r5/r4 checkpoint rather than claiming it is the present review input. |

Paths abbreviated in this table and the findings: `Spec.md`, `ImplementationPlan.md` and `CodeResearch.md` are under `.paw/work/turn-control/`.

## Open findings

### R2-1. The obsolete next-turn rule remains alongside the new consumption contract

**Severity:** should-fix  
**Affected artifact:** both (spec and plan)  
**Origin:** residual F1; cross-artifact consistency and completeness.

**Issue:** P17 fixes correlation by carried-control sequence, but the D6 decision row and C3 controller instructions still require the badge to come from the next turn's Stop. The revised US-3.5 parenthesis also identifies the carrying turn by passing gates rather than by the explicit consumption/stopped-disposition marker. These are competing instructions for B/C and the acceptance author.

**Evidence:**

| Artifact | Evidence |
|---|---|
| Spec | `Spec.md:10` distinguishes actual use from gate passage. `:78` nevertheless defines the carrying turn as "the next turn that gets past its gates". `:163,194` requires preservation before model use and gives the authorized non-run exceptions. |
| Plan | `ImplementationPlan.md:64,316` keeps carried inputs through throws and pre-model failures and separately treats Stop-at-start as an authorized consumed disposition. `:70` says labels derive **only** from the explicit closing event, but `:65,489` still says "from the next turn's Stop". |
| Research/source | `CodeResearch.md:302-330` and `packages/sdk/src/orchestration/turn.ts:650-651` confirm that returned errors advance the index, while thrown retries do not. `packages/sdk/src/orchestration/turn.ts:1585-1592` identifies the ordinary stopped turn but not carried-control sequences. |

**Suggested resolution:** Retain D6. Replace the old derivation instructions with sequence-based P17 lookup only. Define the consuming/disposal turn by `carriedSteersConsumed === true`, including D6 Stop-at-start, not by adjacency or gate passage. Align US-3.5 and its acceptance wording with FR-013/SC-005. Use the already-required later-index and unrelated-Stop cases to assert that interpretation.

### R2-2. The new required closing record has no reliable, idempotent write contract

**Severity:** must-fix  
**Affected artifact:** plan (A1/A2 shared contract and B2 producer)  
**Origin:** new; feasibility and completeness.

**Issue:** The Spec now requires one closing record per carried steer, and P17 makes that record the only durable source of its final derived label. A1 provides the payload but no guaranteed recording operation. The available orchestration event-recording operation is explicitly best-effort and reports successful completion after a failed insert. B2 can therefore clear carried state after losing the only closing record. A consumed or stopped steer in an idle session would remain "Will run next" after reload. The terminal-state fallback does not repair that case, or a give-up that leaves the session in `error`.

Simply switching the writer to critical retries is insufficient for the "one closing record" promise: the existing insertion operation is append-only and has no logical deduplication key.

**Evidence:**

| Artifact | Evidence |
|---|---|
| Spec | `Spec.md:11` requires "one closing record"; `:163,194` requires clients to distinguish ran, stopped and not-run dispositions. |
| Plan | `ImplementationPlan.md:70` requires recording before every clear and permits fallback only for terminal session state. `:207` defines the payload; `:211-215` defines scheduling hooks but no critical/idempotent closing writer. `:409,430` assigns B2 the write-before-clear obligation. P13's explicitly best-effort diagnostic (`:66,282`) is a different kind of evidence and must not determine P17's reliability. |
| Existing source contract | `packages/sdk/src/session-proxy.ts:1107-1108` schedules `recordSessionEvent`; `:5790-5804` explicitly treats it as best-effort because orchestration does not read the events back. `packages/sdk/src/cms-retry.ts:100-105,135-145` swallows exhausted recording failures and returns `undefined`. `packages/sdk/src/cms-migrations.ts:3253-3267` inserts every supplied event without logical deduplication; `packages/sdk/src/cms.ts:2276-2282` forwards the insert. |

**Suggested resolution:** Seal a P17-specific critical, idempotent write path in A1 and implement it within A2's additive migration/provider boundary. B2 must await a persisted closing disposition before clearing the corresponding carried inputs; failure must leave the inputs/disposition recoverable rather than complete successfully. Define identity and deduplication by carried sequence, with safe retry after an uncertain commit and no contradictory closing reason. Keep historical/frozen event recording unchanged. Add failed-insert, committed-but-response-lost, replay/retry, stopped-at-start and give-up tests proving one durable disposition and correct reload labels. No new table or index is required by this suggestion.

### R2-3. C3 requires the closing event but omits it from the history fetch allowlist

**Severity:** should-fix  
**Affected artifact:** plan (C3)  
**Origin:** new; feasibility and completeness.

**Issue:** C3 tells `history.js` to add three control event types to its allowlist and separately to read `session.carried_steers_closed`. In this codebase the allowlist is also a server-side backward-page filter. Reading an event in the reducer is not enough if history paging never fetches it. This leaves P17 labels dependent on whether the closure happened to be present in the initially loaded/live event window.

**Evidence:**

| Artifact | Evidence |
|---|---|
| Spec/plan | `Spec.md:78,163` requires correct carried labels before and after reload. `ImplementationPlan.md:70` makes the closing event authoritative. `:490` enumerates allowlist additions as `user.steer`, `user.stop`, `session.control_outcome`, then separately requires reading the closing event. `:509` promises bulk/live/reload coverage. |
| Research | `CodeResearch.md:1012-1018` identifies the shared allowlist and bulk/live history paths. |
| Source | `packages/app/ui/core/src/history.js:18-22` documents the server-side backward filter. `packages/app/ui/core/src/controller.js:10274-10281` passes `CHAT_HISTORY_EVENT_TYPES` when fetching earlier transcript pages. |

**Suggested resolution:** Explicitly include `session.carried_steers_closed` in the history-fetch allowlist as reconciliation metadata, without creating a separate chat item. Keep `session.steer_confirmed` excluded from transcript fetching/rendering. Require a noisy-history test in which both the steer and closing event are outside the initial page, then page backward after reload and check each derived label, including an unrelated later Stop.

### R2-4. Observational window UX coverage weakens the binding real-model requirement without an approved delta

**Severity:** should-fix  
**Affected artifact:** both (spec and plan; parent-owned design follow-up)  
**Origin:** new; scope coherence and acceptance completeness.

**Issue:** P23 supplies a useful deterministic test mechanism. The revised U1 policy, however, makes carried, carried-with-answer, too-late and carried-then-stopped browser cases optional observations: missing the window is not failure, and SDK tests plus fake-transport rendering substitute for the real-model browser/TUI flow. That is not the complete real-model outcome-label evidence still promised by the binding design and Spec. This is an acceptance change, not merely a test-driver improvement.

**Evidence:**

| Artifact | Evidence |
|---|---|
| Design | `docs/proposals/session-turn-control.md:1083-1092` requires the real-model browser/TUI pass, each outcome label and reload, plus latency. |
| Spec | `Spec.md:6-17` makes design rev 5 binding except its listed approved deltas; no reduced real-model window coverage appears in that list. `:192` requires every FR-009 cell and once-only rendering before/after reload; `:210` requires browser and terminal flows with a real model and outcome labels. |
| Plan | `ImplementationPlan.md:343` assigns deterministic real-CLI window tests to A5. `:568,577-578,582,594,600` allows U1 to miss all window scenarios and substitutes A5 plus fake C3 tests. `:587` reloads only the mandatory outcomes. `:550` lists the design changes to publish but omits this coverage relaxation. |

**Suggested resolution:** Preserve P23 and use an explicitly approved test-only hold configuration to make the required window browser/TUI outcomes reproducible, with reload evidence on the exact candidate. Alternatively, have the parent explicitly obtain and record an acceptance/design delta, update the Spec evidence matrix and SC-003's coverage wording accordingly, and report missing real-model browser/TUI cells as not covered, not as equivalent passes. Do not demand probabilistic repeat-until-window testing.

### R2-5. Renumbered UX references still identify the wrong latency and outcome scenarios

**Severity:** consider  
**Affected artifact:** plan  
**Origin:** new; traceability clarity.

**Issue:** The acceptance table is correctly renumbered, but two earlier references retain the old IDs. This does not remove the actual tests; it makes their requirement mapping inaccurate.

**Evidence:**

| Location | Conflict |
|---|---|
| `ImplementationPlan.md:66` | P13 says "SC-002/UX-18" for Steer confirmation latency. The revised table makes UX-18 **Stop** latency (`:589`) and UX-19 **Steer** latency (`:590`). The SC traceability row correctly lists both (`:151`). |
| `ImplementationPlan.md:139` | FR-009/FR-010 cites UX-09/UX-10. Those are now pending-steer Stop and delivered-steer Stop (`:580-581`); the too-late/D5 row is UX-11 (`:582`). Other earlier evidence still covers the outcome table, but this reference no longer identifies its late-Stop case. |

**Suggested resolution:** Change P13 to UX-19 and include UX-11 in the FR-009/FR-010 evidence row. Audit the remaining numbered references against the revised table. This is a small documentation correction, not an additional acceptance scenario.

## Requested focused checks

| Area | Result |
|---|---|
| P17-P23 and approved deltas | P17's payload, B2 assignment and labels are present; R2-1/R2-2/R2-3 remain. P18 has a complete trusted-caller interface. P19 names the actual retained-ID restart paths and tests. P20 closes open controls regardless of terminal writer. P21 defines pre-send holding and failing turn start. P22 preserves legacy Stop while making the new path once-only. P23 establishes bounded deterministic holds, but its U1 coverage change is not in the approved-delta list (R2-4). A2 separately records its deliberate `created_at` procedure delta (`ImplementationPlan.md:247,253,255`); include that mechanical delta when publishing design rev 6. |
| Stop-test split and ownership | Coherent. `ImplementationPlan.md:107-110,221` partitions abort, legacy-race, management and live tests. B1 retargets the normalizer import (`:385`), C1 owns the fake-catalog updates and current/legacy live expectations (`:456,462-464`), and A5/B2 use `catalog.turnControlAdd` without a C1 dependency (`:353,420`). The order diagram makes the C live dependency on A4+B2 explicit (`:117`). Preserve the existing queue-name and SDK-abort tests (`packages/sdk/test/local/stop-turn.test.js:355-381`) during the no-behavior-change split. |
| `session.steer_confirmed` across A1/A3/A4/C3 | Shared payload/event constant in A1; A3 owns confirmation production and once-per-confirmation coverage; A4 integrates the live run; C3 does not render the diagnostic. No competing B2 confirmation producer is needed. F3 is resolved. |
| `session.carried_steers_closed` across A1/A4/B2/C3 | Shared payload/event constant and consumption marker are specified. B2 owns closure, not the live worker. C3 owns derived labels. Reliability and history-fetch contracts still need R2-2/R2-3. |
| FR-013, SC-005, US-3 | FR-013/SC-005 now explicitly preserve carried inputs before model use and explain stopped/give-up/terminal exceptions. US-3 narrative correctly distinguishes a steer before final idle from one after final idle (`Spec.md:71-74`). US-3.5's gate-passed parenthesis and the remaining next-Stop derivation are R2-1. |
| Renumbered UX matrix | Running Stop, pending/delivered-steer Stop, idle races, read-only split, legacy, lost response and layout cases are present. P13 and the FR-009/FR-010 row need R2-5. Window reload/real-model obligations need R2-4. |

## Completion

Independent cycle-2 review is complete. No findings were applied, skipped or discussed by this worker. The remaining findings are for the parent to resolve or disposition at the two-cycle limit; they do not authorize another automatic review loop or source changes.

D1-D6 and R1-R7 remain intact. No new behavioral choice is proposed for Stop or Steer. The bundle is **not yet ready for an unconditional implementation-ready planning verdict** because the required carried-steer evidence can still be lost or omitted, and the acceptance documents disagree about required real-model coverage.
