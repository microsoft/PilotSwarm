# Planning Documents Review Synthesis

**Date**: 2026-10-13
**Reviewers**: azure-openai:gpt-6.1-sol, anthropic-wif:claude-opus-5-5 (independent, read-only, both at `ec71607b`)
**Artifacts Reviewed**: Spec.md (r5), ImplementationPlan.md (r4), CodeResearch.md, design revision 5, repository instructions
**Mode**: multi-model, Planning Review Interactive = false (must-fix and should-fix auto-applied; consider findings applied when they pass the quick-win test)
**Result revision**: Spec r6 and plan r5 (commit recorded in the state fact and the commit log)

## Consensus Issues (Both Models)

| Finding | gpt-6.1-sol | claude-opus-5-5 | Severity | Disposition |
|---|---|---|---|---|
| D6 label has no durable link to the consuming turn (a returned error advances the index) | F1 | M3 | must-fix | Applied: P17 `session.carried_steers_closed { seqs, turnIndex, reason }` in A1, written by B2, read by C3; Spec FR-013, US-3.5 wording "the turn that carries it" |
| Steer confirmation signal is trace-only, not durable/tuner-reachable | F3 | C4 | should-fix | Applied: P13 `session.steer_confirmed` non-transcript event; latency uses database-clock `createdAt` on both ends (no skew) |
| Legacy Stop and initial `pending` state lack selectors | F4 | S11 | should-fix | Applied: `control-stop-legacy`, `stop_forced`, `pending` turn state; U1 legacy setup through U0 |
| UX scenarios without a browser driver (idle Stop, idle Steer fallback, read-only refusal) | F5 | C7 | should-fix | Applied: Playwright route hold / route drop drivers; read-only split into hidden control, API refusal, and revocation race |
| Plan cites Spec r3 | F7 | C1 | consider (quick win) | Applied |

## Partial / Single-Model Findings

| Finding | Source | Severity | Disposition |
|---|---|---|---|
| A1 lacks trusted caller (sender, viewer) for flag resolution and attribution | gpt F2 | must-fix | Applied: P18 `TurnControlCaller`; Web API overwrites it from auth like `sendMessage`; C1 caller tests |
| `turn_high` never goes down, but restarted system sessions start at iteration 0 | opus M1 | must-fix | Verified in source (`system-agents.ts:212-218`, archive and revive procedures). Applied: P19 reset in 0082; FR-015 lifetime scope; A2 and A5 tests |
| Existing Stop tests break across workstreams | opus M2 | must-fix | Verified (`stop-turn.test.js:7`, fake catalog). Applied: A1 splits the file into A/B/C-owned parts; `stop-turn-live.test.js` owned by C, run after A4+B2; B2/A5 use `catalog.turnControlAdd` directly |
| Terminal states outside the orchestration leave controls pending | opus S1 | should-fix | Applied: P20 closing in `cms_update_session` for completed/failed/cancelled |
| Carried steers dropped on give-up while labelled "Will run next" | opus S2 | should-fix | Applied: P17 reason `gave_up`/`terminal` → "Carried, not run"; Spec US-3.4, SC-005 |
| Late-steer window contradicts design 4.6 | opus S3 | should-fix | Applied: Spec US-3 reworded; UX-05 now "delivered in the same turn"; carried window cases moved to A5 |
| Window outcomes cannot be produced deterministically | opus S4 | should-fix | Applied: P23 `hold` fault action (A-owned `fault-injection.ts`); window UX rows observational in U1, mandatory in A5/C3 |
| Controls between turn start and the initial send undefined | opus S5 | should-fix | Applied: P21 (gate opens after initial send; held Stop prevents the send; register triggers a look; `turnStart` throws) |
| Steering flag user-overridable without the operator | opus S6 | should-fix | Applied: P7 `defaultAllowUserOverride: false`; Spec FR-017 |
| `created_at` missing from the procedure "exactly as design 4.2" | opus S7 | should-fix | Applied: A2 deliberate delta in `0082_diff.md` |
| P12/D6 deviate from the design while the spec says the design wins | opus S8 | should-fix | Applied: Spec "Approved design deltas" list; parent publishes design revision 6 in I1 |
| HorizonDB LISTEN never tested; new files default into HDB | opus S9 | should-fix | Applied: hub degrades without LISTEN; A3 runs the hub test on HDB when configured; I1 per-file coverage decision |
| CI connection headroom with a listener per worker | opus S10 | should-fix | Applied: I1 measures peak connections; `run-tests.sh` parent-owned; no parallelism reduction |
| 1.0.81 visible Stop record duplicate or missing | opus S12 | should-fix | Applied: P22 (no system message on 1.0.81) |
| Mobile and MoA coverage | gpt F6 | consider | Applied (quick win): C3 extends the mobile e2e test; UX-24 layout matrix; scoped selectors |
| CLI scope wording | opus C2 | consider | Applied: Spec out of scope |
| Stop wait shorter than thrown-error backoff | opus C3 | consider | Applied: `timeout` keeps `controlSeq`; notice `stop_pending_retry`, control stays pending |
| Storeless sessions and D2 labels | opus C5 | consider | Applied: A4 storeless test and Docs.md note |
| `turnStart` failure policy | opus C6 | consider | Applied in P21 (throws) |
| Mixed-version evidence | opus C8 | consider | Applied: A2 test with 0081-era calls |
| Steer disabled state selector | opus C9 | consider | Applied: `data-state="disabled"` |
| Event payload types | opus C10 | consider | Applied: A1 exports payload interfaces |

## Priority Actions

All must-fix (5 distinct) and should-fix (13 distinct) findings are applied; all consider findings passed the quick-win test and are applied. No finding was skipped. Decisions D1-D6, R1-R7 and P1-P16 are unchanged except where the reviewers showed a conflict with the code or the design (P7 default, P13 durability), now recorded as P17-P23 and the approved-delta list.

## Re-review

One finding-scoped re-review cycle on the revised bundle follows (cycle limit 2).

---

# Cycle 2 (re-review of Spec r6 / plan r5 at `03874901`)

**Reviewers**: azure-openai:gpt-6.1-sol (`REVIEW-gpt-6.1-sol-r2.md`), anthropic-wif:claude-opus-5-5 (`REVIEW-claude-opus-5-5-r2.md`)
**First-cycle findings**: gpt F2-F7 resolved, F1 partly; opus 24 of 25 resolved, M3 partly. Both partial items are the same residual (old "next turn" derivation), fixed below.

| Finding | Source | Severity | Disposition (Spec r7 / plan r6) |
|---|---|---|---|
| Old "next turn" derivation and gate-based carrying-turn definition remain | gpt R2-1, opus N1 (consensus) | should-fix | Applied: D6 row, P12, C3 and Spec D6/US-3.5 use the consuming turn (P12) and the P17 record only; SC-005 reworded to be measurable |
| Closing record has no reliable, idempotent write | gpt R2-2 | must-fix | Applied: P17 `closeCarriedSteers` activity (critical retry) and A2 procedure `cms_close_carried_steers` (row lock, dedup by seq, first reason wins); B2 awaits it before clearing; failure keeps the steers |
| Closing event not fetched by history paging | gpt R2-3, opus N2 (consensus) | should-fix | Applied: added to `CHAT_HISTORY_EVENT_TYPES` as a label input; page-boundary test |
| Window UX coverage reduced to observation without a delta | gpt R2-4 | should-fix | Applied without a delta: U1b runs window scenarios mandatorily on a local instance of the exact candidate with a real model and session-scoped holds; Spec evidence row 7.6 updated |
| Stale UX references | gpt R2-5, opus N8 | consider | Applied (P13 → UX-19; FR-009 row adds UX-11) |
| Retried error drops a consumed carried steer | opus N3 | should-fix | Applied: carried steers follow their prompt; a retryable `error` keeps them and records nothing; `ran` only for non-error, non-stopped results; B2 test for a carried-only turn that errors and retries |
| `hold` is process-wide | opus N4 | should-fix | Applied: P23 session-scoped hold, per-(point, session) counts, `armFaultHold` for in-process tests |
| Three race-harness tests unowned | opus N5 | should-fix | Applied: owned by B, in B2's criteria |
| Revive keeps old turn-indexed events | opus N6 | should-fix | Applied: P19 `turn_base_seq` lifetime base; procedures ignore earlier events; A2 soft-delete/revive test |
| `closeControls` on terminal writes; "one closing record"; session-ending result with late steers | opus N7 | consider | Applied: terminal writes rely on P20; Spec says "at most one"; session-ending result closes as `terminal` |
| Delta lists omit `created_at` and the register look | opus N8 | consider | Applied to Spec deltas and the I1 design revision 6 list |

**Cycle limit reached (2).** All cycle-2 findings are applied in Spec r7 / plan r6. Per the skill, no third automated review cycle runs; the revision goes to the parent and owner with the plan-ready report.
