Verdict: NEEDS-REVISION

**Counts.** First-cycle findings (25): 24 resolved, 1 partly resolved (M3), 0 not resolved. New findings: 0 must-fix, 6 should-fix, 2 consider.

# Planning Docs Re-review, cycle 2: turn-control (reviewer: claude-opus-5-5)

Bundle at `0387490194d7fd8549e82655a9eb5464781c8dc7`: `.paw/work/turn-control/Spec.md` (r6), `ImplementationPlan.md` (r5), `CodeResearch.md`, design `docs/proposals/session-turn-control.md` rev 5, the first-cycle reviews and `REVIEW-SYNTHESIS.md`. Every quote and code check used explicit-SHA `git show` and `git grep` at that commit. Line numbers refer to the files at that commit. D1-D6, R1-R7 and P1-P23 are not reopened, except where a finding shows a conflict with the code, the design or the spec.

Summary: the revision fixes almost every first-cycle finding. The new mechanisms (P17-P23) are sound. However, the revision left some old "next turn" wording that contradicts P17. It also introduced gaps:
- the closing event is filtered out of the transcript fetch;
- a consumed carried steer is lost on a retried error;
- the `hold` hook is process-wide;
- three existing orchestration tests have no owner;
- revived sessions reuse old turn-indexed events.

---

## 1. First-cycle findings

| ID | Status | Evidence at 0387490 |
|---|---|---|
| M1 `turn_high` vs restart | Resolved | P19 `ImplementationPlan.md:72`; A2 lifetime reset `:250`, tests `:255`; A5 restart check `:354`; Spec FR-015 `Spec.md:165`, approved delta `:12`. Archive deletes `session_events` (`cms-migrations.ts:5565-5566`), so the system-restart path is clean. The non-system revive path has a remaining gap: see N6. |
| M2 Stop tests across workstreams | Resolved | Split and owners `ImplementationPlan.md:107-110`, A1 split `:221`; dependency graph `:117`; A5 uses `catalog.turnControlAdd` and excludes `stop-turn-live.test.js` `:353`; B1 repoints the legacy import `:385`; C1 owns the live update `:463`. Three other harness tests that encode the race have no owner: see N5. |
| M3 D6 durable link | Partly resolved | The mechanism is in place: P17 `:70`, A1 payload `:207`, B2 record `:409`, C3 history `:490`, Spec FR-013 `Spec.md:163`, US-3.5 `:78`. Still open: the D6 row `ImplementationPlan.md:65` and the C3 controller bullet `:489` still derive the label "from the next turn's Stop". Spec D6 `Spec.md:222` still says "next turn". The closing event is not fetched on reload. See N1 and N2. |
| S1 terminal writes outside the orchestration | Resolved | P20 `:73`; A2 `cms_update_session` `:249`; tests `:255`; `client.ts` row "none needed" (ownership table). |
| S2 carried steers dropped on give-up | Resolved | P17 `gave_up`/`terminal` `:70`; Spec US-3.4 `Spec.md:77`, FR-013 `:163`, SC-005 `:194`; badge `carried_not_run` `ImplementationPlan.md:503`; B2 test `:415`. |
| S3 late-steer window vs design 4.6 | Resolved | Spec US-3 narrative and US-3.1 `Spec.md:71,74`; UX-05 "delivered in the same turn" `ImplementationPlan.md:576`; UX-06 is a window scenario. |
| S4 deterministic window hook | Resolved | P23 `:76`; A1 `:220`, `:231`; A4 hold points `:317`; A5 window cases `:343`; U1 window kind `:568`. Its process-wide scope is a new problem: see N4. |
| S5 T3 → initial send window | Resolved | P21 `:74`; A3 `:281`, test `:287`; A4 `turnStart` throws `:312`; A5 `:343`. |
| S6 user-overridable steering flag | Resolved | P7 `:59`; A1 flag `:218`; C1 caller tests `:464`; Spec FR-017 `Spec.md:167`, dependency `:252`. |
| S7 `created_at` delta | Resolved | A2 deliberate delta `ImplementationPlan.md:247`; test `:255`. Neither delta list mentions it: see N8. |
| S8 deviations vs "design wins" | Resolved | Spec approved-deltas list `Spec.md:6-17`; I1 design revision 6 `ImplementationPlan.md:550`. |
| S9 HorizonDB LISTEN | Resolved | LISTEN-refused degradation `:283`, hub test `:288`; A3 HorizonDB run `:295`; A5 `:347`; I1 per-file decision `:549`. |
| S10 CI connection headroom | Resolved | `run-tests.sh` owned by the parent `:105`; I1 measurement `:548`. |
| S11 legacy Stop setup and selectors | Resolved | UX-15 base→candidate route `:586`; `control-stop-legacy` P22 `:75` and the testid table. |
| S12 1.0.81 visible Stop record | Resolved | P22 `:75`; B2 `:410`; live test owner `:110`, C1 criterion `:463`; UX-08 `:579`. |
| C1 stale references | Resolved | `:5`, `:615` cite r6; UX table ordered. |
| C2 CLI scope | Resolved | `Spec.md:238`. |
| C3 Stop wait vs backoff | Resolved | `timeout` keeps `controlSeq` `ImplementationPlan.md:208`; `stop_pending_retry` and pending item `:505`, `:508`. |
| C4 confirmation latency signal | Resolved | P13 durable `session.steer_confirmed` `:66`; A3 `:282`, test `:287`. The cross-reference is stale: see N8. |
| C5 storeless sessions | Resolved | A4 storeless test and Docs.md note `:320`. |
| C6 `turnStart` failure policy | Resolved | P21 `:74`, A4 `:312`, test `:320`. |
| C7 UX-12 unreachable | Resolved | UX-12/UX-13 route-hold drivers `:583-584`. |
| C8 mixed-version evidence | Resolved | A2 mixed-version tests `:255`. |
| C9 Steer disabled state | Resolved | `data-state="disabled"` `:499`. |
| C10 event payload types | Resolved | A1 payload interfaces `:207`. |

Checked and consistent (no finding):
- The renumbered UX table against the traceability table (`:131-160` vs `:572-595`). The only stale reference is P13 (N8).
- `session.steer_confirmed` across A1 (`:207`, `:209`), A3 (`:282`, `:287`), C3 (excluded from the transcript, `:490`) and U1 UX-19.
- P21 against design 4.5. `LiveTurn` starts with `sent = cursor = start` (`design.md:739`), so the look that registration triggers does not resend folded steers.

---

## 2. New findings

### Should-fix

#### N1. The old "next turn" derivation and definition of D6 is still in both artifacts and contradicts P17 and P12
- **Affected:** plan and spec.
- **Evidence:**
  - Plan D6 row `ImplementationPlan.md:65`: "clients derive the label "Carried, then stopped" from the next turn's Stop".
  - C3 controller bullet `:489`: "… rendered "Carried, then stopped" … derived from the next turn's Stop, bulk and live".
  - These contradict P17 `:70` ("Clients derive the label of a `carried` steer only from this event") and the C3 history bullet `:490`. A C implementer has two derivations to choose from, and the wrong one is the one M3 showed to be unsound.
  - P12 tail `:64` and Spec D6 `Spec.md:222` still say "whose next turn ends "stopped"".
  - Spec US-3.5 `Spec.md:78` defines the carrying turn as "the next turn that gets past its gates". This contradicts the approved delta `Spec.md:10` ("only when a turn actually used them, not merely when it passed its gates") and P12/A4 `ImplementationPlan.md:64`, `:316`. Under those rules, a turn that passes its gates and then throws (or whose `turnStart` throws, P21) keeps the steers.
  - SC-005 `Spec.md:194` ("always runs with the turn that carries it") is close to circular, so it cannot be tested.
- **Resolution:**
  - Plan D6 and the C3 controller bullet: derive from `session.carried_steers_closed` only (P17).
  - P12 tail and Spec D6: say "the turn that consumes it (P12)".
  - US-3.5: define the carrying turn as "the first later turn that reaches the model run with it, or that ends "stopped" after taking it (P12)".
  - Reword SC-005 so it can be measured: "each late steer runs once in the first later turn that consumes it (P12), including after an error retry and with an answer to a question; it is not run only when that turn ends stopped (D6) or the session gives up or ends, and every client shows which".

#### N2. `session.carried_steers_closed` is filtered out of the transcript fetch, so P17 labels do not survive a reload
- **Affected:** plan (C3).
- **Evidence:**
  - `packages/app/ui/core/src/history.js:18-55`: `CHAT_HISTORY_EVENT_TYPES` is "Passed as the server-side filter when paging backward for chat history". `controller.js:10281`, `:10326-10345` pass it to `getSessionEventsBefore`.
  - C3 `ImplementationPlan.md:490` adds only `user.steer`, `user.stop` and `session.control_outcome`. It "read[s] `session.carried_steers_closed`", but does not add it to the filter.
  - After a reload, every carried steer in a paged-back transcript has no closing event. It shows "Will run next" (or "Carried, not run" only for a terminal session).
  - This breaks UX-06/UX-23 "before and after reload" (`:577`, `:594`), Spec US-3.5 "before and after a reload" and SC-003.
  - The closing event is written later than the steer, so a page boundary can also separate the two.
- **Resolution:**
  - Add `session.carried_steers_closed` to `CHAT_HISTORY_EVENT_TYPES` as a label input that is not rendered.
  - Derive labels by seq across all loaded pages, bulk and live. Apply the same rule to `session.control_outcome`.
  - Add a C3 history test with a page boundary between a steer, its outcome and its closing event.

#### N3. A consumed carried steer is cleared and labelled `ran` when its turn returns a retryable error, but the retry does not carry it
- **Affected:** plan (B2, A4) against Spec US-3.3, FR-013 and SC-005.
- **Evidence:**
  - P12/A4 `ImplementationPlan.md:64`, `:316`: `carriedSteersConsumed` is set when the folded text "reached the model run". The only exclusions are pre-model returned errors and throws.
  - B2 `:406`, `:409`: steers are cleared on `carriedSteersConsumed`, and `ran` is recorded when the result "is not stopped". That includes a retryable `error`.
  - Code: a returned-error retry continues-as-new with `prompt: rc.sourcePrompt` only (`orchestration/turn.ts:196-204`, `:1645-1660`, `:274-317`).
  - When the carried steers were the only work, `sourcePrompt` is `CARRIED_STEERS_WAKE_PROMPT` (P4 `:56`, B2 `:407`). A4 replaces that constant only when carried steers are present (`:312`). So the retry sends the internal wake constant to the model, or runs without the steer text.
  - Meanwhile every client shows "Carried, ran next".
  - This contradicts Spec US-3.3 `Spec.md:76` ("the retry includes it; a retry never drops it"), FR-013 `:163` ("with an error retry") and SC-005.
  - B2's test "kept on … a returned error" (`ImplementationPlan.md:415`) does not say whether it means pre-model or post-model, so this case is untested.
- **Resolution:** Make carried steers follow the prompt they were folded into:
  - For a returned `error` result that will be retried, keep `state.carriedSteers` and record nothing. The retry re-folds them, the same way it re-sends `sourcePrompt`.
  - Record `ran` only on a non-error, non-stopped result. Record `gave_up` if retries run out.
  - Alternatively, keep the current rule but define the wake-constant fallback, and accept "dropped on retry" explicitly in the spec.
  - Add the B2 case "carried-only turn consumes, returns a retryable error, retry runs". Assert that the steer text reaches the model and that the wake constant never does.

#### N4. The P23 `hold` is process-wide, so the A5 window tests either block concurrent tests or force serialization
- **Affected:** plan (A1, A5).
- **Evidence:**
  - `packages/sdk/src/fault-injection.ts` at 0387490: arming reads `process.env.PILOTSWARM_FAULT_INJECT`. Hit counts are one process-wide `Map` keyed by point name. Existing users set the variable around single in-process tests (`turn-lifecycle.test.js:339-344`), or fork a worker (`kill-harness.js:63`).
  - P23 `ImplementationPlan.md:76` releases on `$PILOTSWARM_FAULT_RELEASE_DIR/<point>`, which is per point and not per session.
  - A5 puts the window cases in `turn-control.test.js` (`:342-343`) with real-CLI tests that run in the same process.
  - While a hold is armed, every turn in that process that reaches `turn.control.before-writeback` or `turn.control.before-send` blocks. If nothing releases it, it throws after 120 s. `afterHits` counts hits from other tests too.
  - The alternative is to serialize the file, which the test-integrity rules forbid without owner consent (`:124`).
- **Resolution:**
  - Scope a hold to one session. For example, arm `<point>@<sessionId>` and release the file `<point>.<sessionId>`, through a test-only arming call or an environment entry that names the session.
  - Or run the window cases in a forked worker through the kill harness, which is process-isolated.
  - State which option is used in A1/A5, and add a scoping case to A1's `hold` unit test.

#### N5. Three existing orchestration-harness tests encode the Stop race, have no owner and are not in B2's criteria
- **Affected:** plan (ownership table, B2).
- **Evidence:** All three drive the current `orchestration/` generator with a fake `ctx` built around `race(runTurn, dequeueEvent(stopTurn.<n>))`:
  - `child-update-batching.test.js:105-128`: the driver resumes every `runTurn` stop with the race envelope `input = { index: 0, value: firstTurnResult }` (`:358-363`).
  - `child-wake-diet.test.js:117-140`: same pattern.
  - `model-selection.test.js:450-456`: `race(left) { return { index: 0, value: left } }`.
  - B2 removes the race (`ImplementationPlan.md:405`). The 1.0.81 generator would then receive the envelope as the turn result.
  - None of these files is in the ownership table. The rule for test files is "the workstream that creates them" (`:106`), and nobody creates these.
  - They are not in B2's criteria (`:426`), so the failure would first appear in I1's full suites. M2 aimed to prevent exactly this.
- **Resolution:** Assign the three files to B. In B2, make their drivers resume a direct `runTurn` with the turn result (keeping any legacy-version cases on `orchestration_1_0_80`). Add them to B2's targeted Vitest list.

#### N6. P19 resets `turn_high` on revive, but a revived non-system session keeps its old turn-indexed control events
- **Affected:** plan (A2, P19).
- **Evidence:**
  - `cms_soft_delete_session` (`cms-migrations.ts:3173-3194`) keeps `session_events`.
  - The `cms_create_session` revive branch (`:8155-8206`) sets `current_iteration = 0` and also keeps them. Only the system archive deletes them (`:5565-5566`).
  - The design procedures select controls and outcomes by `(data->>'turn')::int` (`design.md:521-534`, `:579-588`, `:603-630`).
  - After P19's revive reset (`ImplementationPlan.md:72`, `:250`), turn *k* of the new lifetime matches the old lifetime's turn *k*:
    - `cms_turn_start` returns `stopped` from an old `stopped` outcome, so the new turn ends "stopped" without a model run;
    - `cms_turn_open_controls` returns old controls that a soft delete never closed (P20 closes only through `cms_update_session`);
    - the `late` query of `cms_turn_end` returns old `carried` steers, so they run again.
  - The comment at `:8150-8153` says the 0026 overload stays callable for older writers. P19 names only "the revive branch".
- **Resolution:** Extend A2's planned audit to turn-indexed events, not only columns. Options:
  - Add a lifetime base, for example `sessions.turn_base_seq BIGINT` set on archive and revive, and have the five procedures ignore events with `seq <= turn_base_seq`. Record it in `0082_diff.md` and in the approved-deltas list.
  - Or prove in `0082_diff.md` that a non-system revive cannot start an orchestration that reaches `runTurnV4`.
  - Cover every revivable `cms_create_session` overload. Add an A2 test: soft delete, revive, then turn 0 with an old `stopped` outcome at turn 0.

### Consider

| # | Title | Issue and evidence | Affected | Suggested resolution |
|---|---|---|---|---|
| N7 | P20/P17 statements versus B2 and the spec delta | (a) P20 `ImplementationPlan.md:73` says terminal closing is in SQL and `closeControls` "stays for the `error` give-up write". B2 still adds `closeControls` to terminal writes in `agents.ts`/`runtime.ts` (`:413`), and its test asserts that "give-up and terminal writes carry `closeControls`" (`:415`). (b) The Spec delta `Spec.md:11` says "Each carried steer gets one closing record", but P17's own fallback (`:70`, a child cancelled by its parent) writes none. (c) B2 `:407` schedules a next turn after "any other result" with late steers, and P17 closes steers as `terminal` on terminal paths. The plan does not say which applies when the turn's own result ends the session, for example a completing sub-agent. | plan, spec | (a) Keep one mechanism for terminal states and align the B2 test. (b) Say "one closing record, or the terminal-state fallback". (c) State the rule for late steers of a session-ending result (close as `terminal`, or run first) and add a B2 test. |
| N8 | Stale cross-reference and incomplete delta lists | P13 `ImplementationPlan.md:66` still says "SC-002/UX-18 latency". After renumbering, steer latency is UX-19 (`:590`) and UX-18 is Stop latency. The Spec approved-deltas list (`Spec.md:8-17`) and I1's design revision 6 list (`ImplementationPlan.md:550`) omit two deltas: the A2 `created_at` column of `cms_turn_open_controls` (`:247`, design `:523` returns three columns), and P21's look on `register` (design `:712` "register … live.set" without a look). | plan, spec | Change "UX-18" to "UX-19" in P13. Add the two deltas to both lists, plus N6's lifetime base if adopted. |

---

## 3. Requested focus checks

| Focus | Result |
|---|---|
| P17-P23 | P17 (N1, N2, N3, N7), P19 (N6), P20 (N7), P23 (N4). P18, P21 and P22 are consistent. |
| Approved-design-deltas list | Matches I1 `:550` item for item. Both omit the `created_at` and register-look deltas (N8). The wording "one closing record" is too strong (N7). |
| Stop test split and ownership | `stop-turn*.test.js` is now clean. Unowned race-encoding harness tests remain (N5). |
| UX table vs traceability | Consistent. Only P13's reference is stale (N8). |
| `carried_steers_closed` / `steer_confirmed` across A1, A3/A4, B2, C3 | `steer_confirmed` is consistent. `carried_steers_closed` is not fetched (N2), its `ran` reason is wrong on a retried error (N3), and the C3 controller derivation is stale (N1). |
| P19 restart reset | Correct for the system archive. The revive path collides with old events (N6). |
| P20 vs `closeControls` give-up | Redundant terminal `closeControls` remains in B2 and its test (N7a). |
| P23 hold hook | Process-wide scope (N4). |
| FR-013, SC-005, US-3 wording | US-3.5's definition and SC-005's circular wording (N1). US-3.3 is not met on a post-model retried error (N3). |
