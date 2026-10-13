# Planning Docs Review — turn-control (reviewer: claude-opus-5-5)

**Summary: 3 must-fix, 12 should-fix, 10 consider.**

Bundle at `ec71607b0b5bff07d365eed0d77d9d91286186a0`: `.paw/work/turn-control/Spec.md` (r5), `ImplementationPlan.md` (r4), `CodeResearch.md`; binding design `docs/proposals/session-turn-control.md` rev 5; `.github/copilot-instructions.md`. Code claims were checked with explicit-SHA `git show`/`git grep` at the same commit. D1-D6, R1-R7 and P1-P16 were not reopened, except where noted that they conflict with the design or the code.

Verdict: the bundle is close. Traceability FR→phase→test is complete in form. But one design invariant conflicts with existing code (retained-session restart). The cross-workstream dependency and ownership graph breaks on the existing Stop tests. And the D6 label cannot be derived from what the contract records. Fix these before A1 merges.

---

## Must-fix

### M1. `turn_high` never goes down, but a retained session id restarts its orchestration at iteration 0
- **Issue:** The design's stale-start guard rejects any `turn < turn_high`. The code restarts orchestrations for an existing CMS row with `iteration: 0`. After a system-session "Complete & Restart" or "Terminate & Restart", every `cms_turn_start` returns `stale`. Every turn throws, retries run out, and the restarted system agent can never run a turn. Also, controls are keyed only by `(session, turn index)`, so a new lifetime would reuse the old turn indexes.
- **Evidence:**
  - Design `design.md:502` ("It never goes down"); `cms_turn_start` `design.md:581-583` (`IF p_turn < v_high THEN RETURN '{"stale":true}'`).
  - Code: `system-agents.ts:212-218` (the retained-session callback exists because "the fresh lifetime counts turns from zero again"); `management-client.ts:2669-2690` (restart = `_disposeSystemSession` and then `startSystemAgents` with the same session id); `cms-migrations.ts:5536-5588` (`cms_archive_system_session_for_restart` resets `current_iteration = 0`, soft-deletes, and does not touch `active_turn_index`); `cms-migrations.ts:8155-8206` (`cms_create_session` revives the soft-deleted row with `ON CONFLICT … current_iteration = 0`, which keeps every unlisted column). `client.ts:867` also starts orchestrations with `iteration: 0`. The provider ledger needed `bumpLedgerBase` (`provider-store.ts:413`) for the same reason.
  - Spec FR-015 `Spec.md:154`; Plan A2 `ImplementationPlan.md:225-238` change only writeback, update_session and get_session. Neither the research nor the plan mentions the restart path.
- **Affected:** both (and the design).
- **Resolution:** In migration 0082, reset `turn_high = -1` and `active_turn_index = NULL` in `cms_archive_system_session_for_restart` and in the `cms_create_session` revive branch (DROP/CREATE or CREATE OR REPLACE, with deltas in `0082_diff.md`). Audit any other path that reuses a session id with a fresh orchestration. Add A2 procedure tests: archive/revive resets both columns. Add a live test: a system session that ran 1.0.81 turns, then restarts, runs turn 0 normally. Add one sentence to Spec FR-015 that scopes `turn_high` to one orchestration lifetime. Ask the parent to note this in the design.

### M2. Existing Stop tests break across workstream boundaries, and the dependency graph does not show it
- **Issue:**
  - (a) `stop-turn.test.js` is A-owned. It imports `normalizeRacedTurnValue` from B-owned `orchestration/turn.ts`, which B2 removes from the current version with the race. Its management harness fakes `_catalog` with only `getSession`, so C1's new `stopSessionTurn`, which calls `turnControlAdd` first, breaks it.
  - (b) `stop-turn-live.test.js` is A-owned. It creates a new session (1.0.81 after B1/B2) and calls `mgmt.stopSessionTurn`. Without C1, the old client enqueues on `stopTurn.<n>`, which 1.0.81 never dequeues, so the test times out.
  - (c) B2 and A5 list `stop-turn-live.test.js` in their automated criteria. Their stated dependencies are A1/A4 and A4/B2 only, not C1.
- **Evidence:**
  - Plan `ImplementationPlan.md:97` (A owns `stop-turn*.test.js`); `:375` (B2 consumes A1, A4); `:315` (A5 consumes A4, B2); `:398` and `:329` (`stop-turn-live.test.js` in the B2 and A5 criteria); C1 criteria run `stop-turn.test.js` (`:433`).
  - Code: `stop-turn.test.js:7` (`import { normalizeRacedTurnValue } from "../../src/orchestration/turn.js"`); `:255-266` (fake catalog `getSession` only); `stop-turn-live.test.js:62-79` (new session plus `mgmt.stopSessionTurn`); `orchestration/turn.ts:493-506,683` (race and normalizer).
- **Affected:** plan.
- **Resolution:** Add C1 as a dependency of the B2 live tests and of A5, or require those tests to call `catalog.turnControlAdd` directly. Name who edits each of `stop-turn.test.js` and `stop-turn-live.test.js`, and when. One option: move them to a shared "parent applies after C1+B2" list, the same way `provider-test-coverage.json` is handled. Decide whether `normalizeRacedTurnValue` stays exported from current `orchestration/turn.ts` or the test imports it from `orchestration_1_0_80/turn.js`.

### M3. The "Carried, then stopped" label (D6) has no durable signal, and "the next turn" is not always the consuming turn
- **Issue:** C3 derives `carried_then_stopped` "from the next turn's Stop". The durable record cannot tell a client which turn consumed a carried steer:
  - The `carried` outcome is written for turn *n* only.
  - P12 keeps carried steers across a pre-model returned error. That error increments the turn index, so consumption can happen at *n+2* or later.
  - A carried steer delivered in *n+1* must not be relabelled when *n+2* stops.
  - B2 records `session.turn_stopped` with only the turn index and client message ids.
  A1 defines no field that links carried steer seqs to the stopped turn. So the contract is not sufficient for C, and UX-22/SC-003 cannot be met reliably after reload.
- **Evidence:** Spec US-3.5 `Spec.md:67`, FR-013 `:152`, D6 `:211`. Plan D6 `ImplementationPlan.md:65` ("clients derive … from the next turn's Stop"), P12 `:64`, B2 `:380-381`, C3 `:458`, badge `:472`, UX-22 `:557`. Research Q3: a returned error increments the index (`CodeResearch.md` Q3, `turn.ts:650-651`). Code `orchestration/turn.ts:1586-1594` (current `session.turn_stopped` payload).
- **Affected:** plan (A1 contract, B2, C3); spec wording "next turn".
- **Resolution:** Make the signal explicit in A1. For example, `session.turn_stopped.data.carriedSteerSeqs: number[]`, written by B2 from `state.carriedSteers` when the stopped result has `carriedSteersConsumed`. Or have the activity record it in the stopped turn's events. C3 derives the badge only from that field. Spec D6/FR-013: replace "next turn" with "the turn that carried it". Add a B2 test for the pre-model-error → later stop sequence and a C3 history test for a stop that does not consume (stop at *n+2* after delivery at *n+1*).

---

## Should-fix

### S1. FR-014 terminal states written outside the orchestration leave controls open forever
- **Issue:** B2 adds `closeControls` only to the orchestration's give-up and terminal `updateCmsState` calls. Terminal CMS writes also happen in:
  - the `cancelSession` activity (a child cancelled by its parent; duroxide cancels the child without running its terminal code);
  - management delete, status sync and stale-row recovery;
  - `client.ts` status sync.
  Open controls there stay "Pending" forever. `client.ts` is not in the ownership table.
- **Evidence:** Spec FR-014 `Spec.md:153`, US-3.4 `:66`. Plan B2 `:383`, manual check `:402` (only against the research Q17 orchestration call list). Code `session-proxy.ts:5676-5690` (`state: "cancelled"`), `management-client.ts:907-913,1271-1301`, `client.ts:1092-1126`.
- **Affected:** plan.
- **Resolution:** Simplest fix: in 0082's `cms_update_session`, close the open controls whenever `state` moves to `completed|failed|cancelled` (keep `closeControls` for the `error` give-up). No caller changes are needed, and every path is covered. Add A2 tests for each terminal state.

### S2. Carried steers are dropped silently on give-up or terminal, while labelled "Will run next"
- **Issue:** After `cms_turn_end`, a carried steer is closed ("carried"). `closeControls` closes only open controls. B2 then clears `state.carriedSteers` on give-up/terminal paths. The steer never runs, and every client keeps showing "Will run next". This contradicts SC-005 ("always runs with the next turn"). The spec does not define this case, and D6 covers only a stopped next turn.
- **Evidence:** Spec US-3.4 `Spec.md:66`, SC-005 `:183`. Plan B2 `:381,383`. Design 5.2 `design.md:954-964` (give-up labels open steers only).
- **Affected:** both.
- **Resolution:** Record the dropped carried seqs on the give-up/terminal event, using the same mechanism as M3. Add a derived label such as "Carried, not run", with a badge value in the testid table. Or state in the spec that carried steers ride into the next user turn even after an error state. Add B2 and C3 tests.

### S3. The late-steer window in the spec and UX-05 contradicts design 4.6
- **Issue:** The spec narrative says a steer sent "just as the model writes its final answer" is carried. Design 4.6 says a send before the run's final idle is answered in the same run, so it is "delivered". A steer becomes "carried" only after the gate closes at `session.idle` and before the end-of-turn write. UX-05 follows the spec, so with a real model it will usually observe "delivered".
- **Evidence:** Spec `Spec.md:60`, `:63`. Design `design.md:782-785`, gate `:750`. Plan UX-05 `ImplementationPlan.md:541`.
- **Affected:** both.
- **Resolution:** Reword US-3 and UX-05: carried = accepted after the run's final idle (send gate closed) and before the end-of-turn write. Add a UX row for "steer during the final answer → delivered in the same turn".

### S4. Window-dependent outcomes have no deterministic way to produce them
- **Issue:** "carried" (S3), "too_late" (US-1.5/UX-10) and the add-versus-end race (UX-19) need a control to land between `session.idle` and the T6 writeback. That gap is about 100 ms (quiesce plus the event barrier). A5's real-CLI tests and U1's real-model UX pass give no way to hit it. `faultPoint` supports only `exit` and `throw`, with no hold or pause. Without a hook these rows are flaky or untestable, and committing them invites sleeps, which the test-integrity rules forbid.
- **Evidence:** Plan A5 `ImplementationPlan.md:318-319`, UX-05/10/19 `:541,546,555`, P10 `:62`. Code `fault-injection.ts:24-41` (actions `exit`/`throw` only). Research Q1 steps 21-23 (100 ms quiesce, then writeback).
- **Affected:** plan.
- **Resolution:** Add a deterministic test hook. One option is a `hold` fault action that blocks at a named point (for example `turn.control.before-writeback`) until the test releases it. Assign its owner (`fault-injection.ts` is not in the ownership table). Use it in A5, and in U1 through a test-environment configuration, or mark these UX rows as covered by A5 only.

### S5. Controls that arrive between turn start (T3) and the initial prompt send are not defined
- **Issue:** `LiveTurnControl` is registered right before the model run. The hub does not look when a turn registers. The plan does not define when the per-turn send gate opens. A steer applied before ManagedSession's initial `send` could start the CLI run before the prompt. A Stop applied before the turn is active (or before the initial send) makes `abortWarmSessionTurn` return `no_active_turn`, or aborts nothing. The turn then runs to completion and the Stop is labelled "too_late". The window includes attachment resolution and the runTurn setup.
- **Evidence:** Design `design.md:804-816` (T3, then register), `:712` (register has no look), `:750`. Plan A3 `ImplementationPlan.md:260`, A4 `:289`. Research Q1 steps 14-17 (`session-proxy.ts:3996-4198`), Q4 (`session-manager.ts:1731-1738` returns `no_active_turn` when there is no active turn). Code `managed-session.ts:894`.
- **Affected:** plan.
- **Resolution:** In A3/A4, specify that the gate opens only after the initial `send` is accepted. Specify that controls received earlier are held and applied when the gate opens: a Stop before the send prevents the send and ends "stopped". Specify that `register` triggers one look. Add A3/A4 tests for a Stop and a Steer in this window.

### S6. The steering flag lets users override it, but the spec says the operator enables it
- **Issue:** A1 defines `sessions.steering` with user override allowed. With no cluster setting, `resolveFeatureDefinition` returns the user's own preference. So any user can turn on Steer without the operator.
- **Evidence:** Spec `Spec.md:16`, `:95`. Plan A1 `ImplementationPlan.md:202`. Code `feature-flags.ts:66-71`.
- **Affected:** both.
- **Resolution:** Set `defaultAllowUserOverride: false` (the operator enables it, then may allow users), or reword the spec. Add a test for the chosen resolution.

### S7. The `createdAt` that P13 needs is not in the procedures A2 implements "exactly as design 4.2"
- **Issue:** P13 and the A1 `TurnControl.createdAt` need the control's `createdAt` from `cms_turn_look`/`cms_turn_start`. Design 4.2's `cms_turn_open_controls` returns only `(seq, kind, text)`, and A2 says "exactly as design 4.2". Plan review r2 recorded this as a requirement for the implementer, but the plan text still conflicts.
- **Evidence:** Plan P13 `ImplementationPlan.md:66`, A1 `:185`, A2 `:228`. Design `design.md:522-534`.
- **Affected:** plan.
- **Resolution:** In A2, state the deliberate delta: `cms_turn_open_controls` also returns `created_at`. Show it in `0082_diff.md`.

### S8. P12 and D6 deviate from the binding design, but the spec says the design wins
- **Issue:** The spec says that where it differs from the design, the design wins. Design 4.9 says carried steers follow `budgetStash` "exactly" and are cleared once a turn gets past the gates. P12 deliberately does not copy `pastGates`, which is correct given the code. Design 8.1 has no D6. By the precedence clause as written, these approved changes are void.
- **Evidence:** Spec `Spec.md:6`, D6 `:211`. Design `design.md:888-893`, `:1110-1118`. Plan P12/D6 `ImplementationPlan.md:64-65`. Code `orchestration/turn.ts:1318-1321`.
- **Affected:** both (plus a parent action on the design).
- **Resolution:** The parent publishes design rev 6 with D6 and the P12 consumption rule. Or the spec adds an "approved design deltas" list (D6, P12, M1's restart reset) that overrides the precedence clause.

### S9. HorizonDB: new turn-control tests run in the HDB phase by default, but LISTEN on HDB has never been tested
- **Issue:** New SDK test files go into HDB coverage by default. Both existing LISTEN suites (`live-plane`, `canvas-plane`) are `baselineOnly`, so CI has never exercised LISTEN on HDB. The plan treats HDB as an optional "covered/not covered" measurement. If LISTEN fails on HDB, release qualification (which needs real HDB coverage) fails on the new suites.
- **Evidence:** Code `scripts/provider-test-coverage.json:2` (description), `:20`, `:58` (`baselineOnly`). Plan `ImplementationPlan.md:29`, `:93`, `:323`, `:509`. Spec `Spec.md:200`.
- **Affected:** plan.
- **Resolution:** Before I1, run `turn-control-hub.test.js` against HDB. Then decide per file: HDB with a passing hub, or `baselineOnly` with the reason. Also define the hub's behaviour when `LISTEN` is refused (degrade to the 5 s look without failing the worker start) and test it.

### S10. CI connection headroom: every test worker now holds a listener
- **Issue:** The hub opens one dedicated connection at every worker start, whether or not turns run. The SDK suite already runs close to its connection ceiling (8 parallel files, restart-heavy suites, a guard at 1,500 PG and 40 × workers on HDB). A5 measures only the production budget. `scripts/run-tests.sh` is not in the ownership table.
- **Evidence:** Code `scripts/run-tests.sh:1029-1045`. Plan A5 `ImplementationPlan.md:322`, I1 `:516`.
- **Affected:** plan.
- **Resolution:** In I1, measure the peak connections of the full suite with and without the hub. Adjust the guard thresholds if needed, and never by lowering parallelism. Assign `run-tests.sh` to the parent.

### S11. UX-14 (legacy session) cannot be produced through U0 as written, and the testid contract has no legacy Stop states
- **Issue:** A 1.0.80 session continues as new into 1.0.81 quickly. To test a legacy Stop, a turn must be in flight on 1.0.80 when Stop is pressed. That needs the base build deployed first, a session started with a long tool, then the U0 upgrade. U0 describes only deploying the candidate. The legacy outcome is shown as the `system.message` "Turn stopped by user." and the `stop_forced` result. Neither has a selector, so UX-14 has nothing to assert.
- **Evidence:** Plan U0 `ImplementationPlan.md:525`, UX-14 `:550`, testid table `:462-476`. Code `orchestration/turn.ts:744-756`, `types.ts:1727-1731`.
- **Affected:** plan.
- **Resolution:** Extend U0/U1: deploy base → start the legacy session with a blocking tool → upgrade to the candidate → Stop. Add selectors such as `control-legacy-stop` and `data-reason="stop_forced"`, or state the existing element UX-14 asserts.

### S12. The visible stop record in 1.0.81 is undefined: duplicate or missing
- **Issue:** 1.0.81 keeps only the "stopped" result branch, which records `session.turn_stopped` but not the `system.message` "Turn stopped by user." that the race path writes. C3 adds a `control-stop` line. The plan does not say whether 1.0.81 keeps the system message (a duplicate of `control-stop`, against FR-019 "once") or drops it, which breaks the `stop-turn-live.test.js` assertion.
- **Evidence:** Code `orchestration/turn.ts:1577-1597` vs `:744-756`; `stop-turn-live.test.js:97-100`; `history.js:30,39` (both events are rendered). Plan B2 `ImplementationPlan.md:380`, C3 `:459`. Spec FR-019 `Spec.md:158`.
- **Affected:** plan.
- **Resolution:** In B2, state "no `system.message` on the 1.0.81 path; the `user.stop` line is the visible record". Update `stop-turn-live.test.js` (see M2) and add a C3 history test: one visible stop item per Stop.

---

## Consider

| # | Title | Issue and evidence | Affected | Suggested resolution |
|---|---|---|---|---|
| C1 | Stale cross-references | The plan cites "Spec.md (r3)" (`ImplementationPlan.md:5`, `:577`), but the bundle is r5. UX-22 is listed before UX-21 (`:557`). | plan | Update the references and the order. |
| C2 | CLI scope wording | The spec lists CLI support in scope and in FR-019 (`Spec.md:23`, `:158`, `:223`). The plan excludes a CLI subcommand (`ImplementationPlan.md:44`), which matches design 4.3. The spec's out-of-scope list does not say so (`Spec.md:226-233`). | spec | Add "no separate CLI subcommand; the CLI is the TUI" to the spec's out-of-scope list. |
| C3 | Stop wait shorter than thrown-error backoff | A Stop accepted during a thrown-error backoff (15/30/60 s, `turn.ts:300`) is applied only when the retry starts. P6 waits 30 s (`ImplementationPlan.md:58`), so the client shows "timeout" for a Stop that will still be applied. | plan | Return "accepted, pending" (or show the control item as Pending) instead of a timeout notice; test it in C1/C3. |
| C4 | P13 latency signal | `acceptedAt` is the database clock and `confirmedAt` is the worker clock (skew). The signal exists only in worker logs, so the tuner cannot reach it (repository observability rule, `.github/copilot-instructions.md` "Observability Surface"). U1 must also read worker logs. | plan | Put `confirmedAt` in the `delivered` outcome event data (no new table), or record the skew; say how U1 gets the logs. |
| C5 | Storeless sessions and D2 | A stopped turn's conversation is discarded only through the snapshot sentinel. A storeless session keeps the live conversation, so a delivered steer stays in the model context but is labelled "not delivered" (`Spec.md:38`). No storeless control test is planned. | both | Add a D4 note: labels follow the outcome table, not conversation content. Add one A4 storeless test. |
| C6 | `turnStart` failure policy | The step it replaces is best-effort (`session-proxy.ts:3996-4013`). Design `design.md:804` implies it throws. The plan does not say. | plan | State in A4 that it throws (the turn retries) and test it. |
| C7 | UX-12 not reachable through the UI | The Steer button is absent without `canSteer`, and the TUI Ctrl+T refuses with a status line (P9). "Steer with no running turn" happens only as the UX-19 race. | plan | Merge UX-12 into UX-19, or define a stale-view method. |
| C8 | Mixed-version evidence for US-6.4 | Only "migration applies on a fresh and a 0081 database" is planned (`ImplementationPlan.md:243`). | plan | Add a test that runs the 0081-era catalog calls (VOID-ignoring writeback, getSession with an extra column, update without `closeControls`) against 0082. |
| C9 | Testid coverage: Steer disabled | `turn-steer-button` has `data-state` `ready|sending` only (`ImplementationPlan.md:468`). The empty-composer or in-flight disabled state is not distinguished. | plan | Add `data-state="disabled"` or document that the button is never disabled. |
| C10 | Event payload types | A1 exports the event type names (`ImplementationPlan.md:193`) but not the data shapes `{turn,text,requestId,actor}` and `{seq,turn,outcome}` that C parses. | plan | Export the payload interfaces in A1 so that C does not need to edit A-owned `types.ts`. |

---

## Checks requested by the parent

| Check | Result |
|---|---|
| Spec ↔ plan traceability | All FR-001..022 and SC-001..010 are mapped (`ImplementationPlan.md:118-146`). Gaps: FR-014 coverage of terminal paths outside the orchestration (S1); carried-steer give-up (S2); storeless evidence (C5); mixed-version evidence (C8). |
| Assumptions vs research | Holds, except: `turn_high` monotonicity vs retained-session restart (M1); P12 vs design 4.9 (S8); HDB LISTEN (S9). |
| Scope coherence | Consistent, except the CLI wording (C2). |
| Feasibility | Approach supported by research; window-dependent tests lack a mechanism (S4); the T3→send window is undefined (S5). |
| File-ownership disjointness | Disjoint for production code, but broken by the existing tests `stop-turn.test.js` / `stop-turn-live.test.js` (M2). Unowned files that will need changes: `packages/sdk/src/client.ts` (S1 unless solved in SQL), `fault-injection.ts` (S4), `scripts/run-tests.sh` (S10). A B routing test can use raw `Runtime` tag filters as `test/local/agent-handoff-routing.test.js:44-58` does, so no edit to `worker.ts` is needed. |
| Contract A1 sufficiency | Sufficient for B's scheduling, carry and close. Not sufficient for C on the D6/give-up labels (M3, S2), the `createdAt` source (S7) and the event payload types (C10). |
| UX pass vs Spec and design 7.6 | 7.6 items are covered (flag/turn visibility UX-01/21, labels+reload UX-15, latency UX-17/18, TUI UX-16). Problems: UX-05 (S3), UX-05/10/19 determinism (S4), UX-14 setup (S11), UX-12 (C7). Spec US-1.4, US-2.4-2.6, US-3.3/3.4 and US-5 are covered only below the UX layer. This is acceptable, but list it. |
| `data-testid` coverage | Complete for the new path. Missing: legacy Stop states (S11), a "carried, not run" state if S2 is adopted, and the Steer disabled state (C9). |
