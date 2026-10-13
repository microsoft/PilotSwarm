# Session Turn Control (Stop and Steer) Implementation Plan

## Overview

Build Stop and Steer through the CMS, as designed in `docs/proposals/session-turn-control.md` (revision 5) and specified in `Spec.md` (r3). A client writes a control as a session event through one stored procedure that also checks that a turn is running and sends a notification. The worker that runs the turn listens, reads the turn's new controls and applies them to the live model run: Stop aborts it, Steer is sent with the CLI's "immediate" mode. The turn saves a cursor with its result and, after the save, gives every open control exactly one outcome. The orchestration keeps running one `runTurn` per turn. A new orchestration version, 1.0.81, drops today's Stop race and carries late steers into the next turn.

The work is split into three workstreams with disjoint file ownership, a contract phase that lands first, and parent-owned integration, UX test pass and final PR phases:

| Workstream | Branch (proposed) | Owner | Scope |
|---|---|---|---|
| A Runtime | `waldemort/turn-control-runtime` | PAW lead (this plan's author) | contract, CMS migration and procedures, worker control loop, `runTurnV4`, crash tests |
| B Orchestration | `waldemort/turn-control-orchestration` | B coordinator | freeze 1.0.80, version 1.0.81, carried steers, closing controls |
| C Surfaces | `waldemort/turn-control-surfaces` | C coordinator | management client, Web API, MCP, portal, TUI, docs, samples |
| Integration | `waldemort/turn-control` | parent | merges, full suites, measurements, UX test pass, final PR to `main` |

## Current State Analysis

From `CodeResearch.md` (refreshed at `8ffed787`):

- **Stop today** is an orchestration event on `stopTurn.<n>` raced against `runTurn` (`orchestration/turn.ts:493-499`), followed by an `abortTurn` activity on the same worker (`turn.ts:707-780`, `session-manager.ts:1713-1781`). The client reads `active_turn_index` and polls KV (`management-client.ts:2498-2553`).
- **runTurn** (`session-proxy.ts:1397-4647`): preamble (`:1632`) with an already-committed return (`:1634-1647`); budget and workspace gates (`:1700-1950`); `state=running` then `setActiveTurnIndex` (`:3996-4013`); model run (`:4183`); `completeTurnWriteback` (`:4405-4446`, clears `active_turn_index`); snapshot commit (`:4513-4575`), skipped for a stopped result (`session-lifecycle.ts:372-385`). The cooperative cancel poll runs every 2 s (`:3774-3782`).
- **ManagedSession** settles on the first non-child `session.idle` (`managed-session.ts:3553-3562`); it sends the initial prompt without a `mode` and keeps no message id (`:3641-3655`). No send into a running turn exists.
- **Routing**: `activity-routing.ts` (51 lines) defines `runTurnV3`/`runTurnEpochV3` with tag `pilotswarm.agent-handoff.v2`, and `pilotswarm.workspaces.v1`; one task carries one tag. Workers declare `workerTagFilter: { defaultAnd: [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY] }` (`worker.ts:854`). `createSessionProxy` is shared by frozen orchestration versions, so its existing behaviour for contract `agent-handoff-v2` must not change.
- **CMS**: latest migration `0081`; `cms_complete_turn_writeback` (0024) and `cms_update_session` (0059) return `VOID`; `SessionCatalog` (`cms.ts:952-1437`) has one implementation, `PgSessionCatalog`, also used for HorizonDB. Test doubles are partial JS objects. `cms_get_session` returns `active_turn_index`; list procedures do not.
- **Feature flags** are code-owned in `feature-flags.ts`; a migration publishes each definition row (pattern: `migrations/model-event-logging-flag-0081.ts`).
- **LISTEN** exists only in the portal (`live-plane.js`, `canvas-plane.js`); `buildSessionCatalogPgClientConfig` (`pg-pool-factory.ts:218-233`) builds a client config. The worker has no listener.
- **Orchestration**: latest `1.0.80` in `orchestration/`; frozen directories `orchestration_1_0_52` to `_79`; registry `orchestration-registry.ts:40-78`. `budgetStash` is the carry pattern to copy (`types.ts:1047`, `state.ts:125-136,473`, `turn.ts:464-469,1319-1320`, `lifecycle.ts:590`, `session-proxy.ts:1964-1979`).
- **Surfaces**: HTTP operations are generated from `packages/sdk/api/src/protocol.js` (Stop at `:105`); the portal composer Stop button is `ui/react/src/web-app.js:9874-9885`; TUI Stop is Ctrl+X / Ctrl+Esc (`tui/src/app.js:272-279`); the shared transcript allowlist is `ui/core/src/history.js:22-55`. There is no CLI Stop subcommand: the CLI is the TUI. The MCP Stop tool is `stop_turn` (`packages/app/mcp/src/tools/turn-control.ts:22-42`). No portal element uses `data-testid` yet.
- **Tests**: Vitest discovers `packages/sdk/test/local/**/*.test.js`; Node test runs `test/unit/*.test.mjs`; no registration list must be edited. HorizonDB coverage includes new SDK files by default (`scripts/provider-test-coverage.json`). Fault points use `PILOTSWARM_FAULT_INJECT` (`fault-injection.ts`) with the kill harness (`test/helpers/kill-harness.js`).
- **Open runtime questions** (research O1-O5) are verification items in A3, A5 and the integration phase, not plan blockers: CLI send typings and other providers, live cancellation through duroxide-node 0.2.1, duroxide-pg fencing, effective grace settings, HorizonDB LISTEN.

## Desired End State

- A Stop on a 1.0.81 turn ends it "stopped" within 2 s at the 95th percentile; a Steer reaches the model at its next model call; late steers run with the next turn; every control has exactly one outcome event; the crash matrix of Spec US-5 holds.
- Sessions on 1.0.80 and older keep today's Stop; old workers never run `runTurnV4`; Steer is visible only with `sessions.steering` on.
- Portal and TUI show each control once with its outcome, in parity; every visible Stop/Steer state has a stable `data-testid` in the portal.
- Verified by the targeted tests of each phase, the parent's full suites on the integration branch, the measurements of the Spec evidence matrix, and the parent's UX test pass.

## What We're NOT Doing

- Withdrawing or editing a steer; steering a turn that has not started; stopping a session between turns (including a returned-error backoff).
- Crash guarantees for sessions without a session store (D4).
- New tables, new indexes or new metric tables; changes to duroxide; a CMS attempt/ownership record.
- A `pilotswarm stop`/`steer` CLI subcommand (the CLI is the TUI; design 4.3 says "where the CLI exposes Stop").
- Changing the Stop path of frozen orchestration versions, or deleting the `abortTurn` activity (1.0.80 sessions still use it).
- Any database reset; compatibility with databases that ran draft PR 142's migrations 0082-0087.
- Changes to `docs/proposals/session-turn-control.md` (parent only).

## Decisions made in this plan

| ID | Decision | Rationale |
|---|---|---|
| P1 | The per-turn class is `LiveTurnControl` in new module `turn-control.ts` (with `TurnControlHub`). | `live-turn.ts` already exports `LiveTurn*` streaming types (research naming note). |
| P2 | Activity contract `"turn-control-v1"`: names `runTurnV4`/`runTurnEpochV4`, tag `pilotswarm.turn-control.v1`. A turn-control task carries only this tag; every worker that declares it also declares the handoff and workspace tags. | One task carries one tag (`withTag`); the workspace tag pattern already relies on implication. |
| P3 | A1 registers `runTurnV4`/`runTurnEpochV4` as aliases of today's handler and declares the tag; A4 replaces them with the turn-control handler. | Lets B run 1.0.81 end to end before A4 lands. The integration branch is not released before A4. |
| P4 | The carried-steer-only turn uses an internal wake prompt constant `CARRIED_STEERS_WAKE_PROMPT` (A1); the worker replaces it with the carried text and records no `user.message` (A4). | Same as the budget wake prompt and `stashedPrompts` fold (`session-proxy.ts:1964-1979`). |
| P5 | `cms_get_session` also returns `turn_high`; `SessionRow.turnHigh` is added. Clients derive "accepts controls" as `activeTurnIndex != null && turnHigh === activeTurnIndex`. | Design 4.10 shows Steer only when the running turn listens for controls. List procedures stay unchanged (0024 note). |
| P6 | The management client waits for a Stop outcome by polling `getSessionEvents(sessionId, seq, …, ["session.control_outcome"])` every 250 ms, up to 30 s by default. | Existing read API; no new procedure; 250 ms keeps the 2 s target. |
| P7 | Flag gating: `steerSessionTurn` resolves `sessions.steering` for the caller and returns refusal `steering_disabled` when off. Stop is never gated. | FR-017. |
| P8 | MCP tool name `steer_session_turn` (design 4.3), next to the existing `stop_turn`. | Binding design. |
| P9 | TUI Steer is Ctrl+T in the prompt pane: it sends the prompt text as a steer when the active session's turn accepts controls and the flag is on; otherwise the status line shows why. Portal: a Steer button next to Stop. | Ctrl+T is unused (research Q18); Ctrl+S is XOFF in many terminals. |
| P10 | New fault points: `turn.control.after-start` (T3), `turn.control.after-writeback` (T6), `turn.control.after-commit` (T7), `turn.control.after-end` (T8). | Design 7.4. |
| P11 | Mid-turn `state=waiting`/`input_required` clears `active_turn_index` today (`cms_update_session`). A control after that point is refused as "no turn running": a Steer then falls back to an ordinary message (FR-004); a Stop answers "nothing to stop" and its reason is never sent as a message. Kept as is. | Design 4.1: cleared by any state change away from running. Documented in A6. |
| P12 | Carried steers leave orchestration state only on proof of consumption: the activity result carries `carriedSteersConsumed: true` only when the carried text was folded into a prompt that reached the model run, or when the already-committed path returns a saved turn (its earlier attempt ran with the same input). Gate waits, pre-model returned errors (for example a provider-admission error, `session-proxy.ts:1773-1785`), thrown errors and a stale start keep them. The disposition of carried steers whose next turn ends "stopped" is decision D6 below; until D6 is recorded, A4, B2 and C3 implement and test only the consumption/retention rules and leave the D6-dependent cases out. | FR-013, SC-005; plan review finding 2. The existing `pastGates` predicate (`turn.ts:1301-1320`) is not copied. |
| D6 | **Owner decision gate (parent-owned, required before the D6-dependent parts of A4, B2 and C3).** A carried steer rides into the next turn, and that turn ends "stopped" (a Stop applied at its start, or during it). Option A (recommended): the stopped turn counts as consumption; the steer is not run again; its durable outcome stays "carried" (outcomes are written once, design 2.3.4) and clients derive the label "Carried, then stopped" from the next turn's Stop; `carriedSteersConsumed` then also marks this authorized stopped disposition, not proof of delivery. Option B: a Stop does not cancel carried guidance; the orchestration keeps the steers and they ride with the next turn the user starts (no turn starts by itself after a Stop). The parent relays the owner's choice; the spec (assumption D6 and US-3 scenario 5) and this plan's A4, B2, C3 and UX-22 rows are then aligned to it in one revision. | Design 4.9 clears carried steers once a turn passes its gates, which implies Option A, but neither the design nor the spec states the cross-turn Stop case; plan review r2. |
| P13 | Steer confirmation latency (SC-002, UX-18) is measured from a structured worker trace line written when `LiveTurnControl` sees the confirmation: `[turn-control] steer-confirmed session=<id> turn=<n> seq=<seq> messageId=<id> acceptedAt=<ISO> confirmedAt=<ISO>` (`acceptedAt` is the control event's `createdAt`, returned with the control by `cms_turn_look`/`cms_turn_start`). No new session event; SDK `user.message` stays filtered from CMS (`session-proxy.ts:3803-3810`). | Plan review finding 9; design 4.11 (no new metric tables). |
| P14 | Client request ids: each user Stop/Steer action creates one request id kept with its immutable kind and text until a definite answer. A transport failure (no answer) shows an "unconfirmed" state with a Retry action that reuses the same id; it never falls back to a message. Only a definite `no_turn` or `legacy_turn` refusal of a Steer triggers the ordinary-message fallback, with a new client message id; the refused request id is never retried. Every transport forwards `requestId` unchanged. | FR-004, design 4.3 client contract; plan review finding 4. |
| P15 | Writeback result is three-valued: `true` (open controls), `false` (none), `undefined` (the best-effort write failed, `cms-retry.ts:135-145`). Only `false` skips turn end; `undefined` runs turn end. | Design 4.7; plan review finding 6. |
| P16 | The A1 aliases of `runTurnV4`/`runTurnEpochV4` (P3) exist only on the integration branch. Nothing is released, deployed or merged to `main` before A4 replaces them. | Plan review finding 12. |

## Shared files and ownership

Every file belongs to exactly one workstream. Another workstream that needs a change asks the owner through the parent. The contract (A1) contains every cross-workstream type and hook, so B and C should need no changes in A's files.

| File or folder | Owner | Notes |
|---|---|---|
| `packages/sdk/src/types.ts` | A | A1 adds all shared types, including the orchestration input field `carriedSteers` |
| `packages/sdk/src/index.ts` | A | A1 exports every new public type and constant |
| `packages/sdk/src/activity-routing.ts` | A | A1 |
| `packages/sdk/src/turn-control-contract.ts` (new) | A | A1: event types, channel, limits, wake prompt |
| `packages/sdk/src/session-proxy.ts` | A | includes the scheduling proxy that B calls (A1) |
| `packages/sdk/src/cms.ts`, `cms-migrations.ts`, `migrations/**` | A | |
| `packages/sdk/src/feature-flags.ts` | A | A1 code definition; A2 publishes the catalog row |
| `packages/sdk/src/worker.ts`, `managed-session.ts`, `session-manager.ts`, `session-lifecycle.ts`, `snapshot-protocol.ts`, `turn-control.ts` (new) | A | |
| `packages/sdk/src/orchestration/**`, `orchestration_1_0_80/**` (new), `orchestration-registry.ts`, `orchestration-version.ts`, `orchestration.ts` | B | |
| `packages/sdk/src/management-client.ts`, `packages/sdk/src/web/**`, `packages/sdk/api/**` | C | |
| `packages/app/**` (web, ui/core, ui/react, tui, mcp) | C | |
| `.github/skills/pilotswarm-tui/SKILL.md`, `templates/builder-agents/**`, `examples/**`, `CHANGELOG.md` | C | |
| `docs/architecture/internals/cms-schema.md`, `docs/architecture/system-reference.md` | A | |
| `docs/architecture/orchestration/design.md` | B | |
| all other `docs/**` except the design | C | |
| `docs/proposals/session-turn-control.md` | parent | |
| `scripts/provider-test-coverage.json` | parent | workstreams propose entries for their own new test files in their PR description; the parent applies them once during integration |
| `packages/sdk/test/helpers/run-turn-activity-harness.mjs`, `test/helpers/kill-harness.js` | A | A4 extends the activity harness with the new catalog methods and a V4 selector; A5 extends the kill harness only if needed |
| `packages/sdk/test/perf/turn-control-look-cost.mjs` (new) | A | A5 measurement script |
| `.github/workflows/**`, `.github/DEPLOYMENT.md` | parent | U0 only |
| Test files | the workstream that creates them | B owns `test/unit/agent-handoff-routing.test.mjs` and the orchestration freeze/upgrade tests; A owns `stop-turn*.test.js` changes; C owns `packages/app/**/test/**` |
| `.paw/work/turn-control/**` | A | umbrella Spec, CodeResearch, this plan, reviews. B and C keep their own PAW work folders `.paw/work/turn-control-b/` and `.paw/work/turn-control-c/` |

## Dependencies and order

```
A1 (contract) ──► merged into waldemort/turn-control ──► B1, B2, C1, C2, C3 start; A2, A3 continue
A2 + A3 ──► A4 ──► merged ──► A5 (needs B2 merged), B2 live tests, C1 live tests
A6, B3, C4 (docs) after their code phases
I1 integration (parent) ──► U0 deployment route (parent) ──► U1 UX test pass (parent) ──► F1 final PR to main (parent)
```

## Test integrity (all workstreams and the parent)

- No retry configuration in tests (Vitest `retry`, Playwright `retries` stay 0), no repeat-until-green loops, no weakened assertions, no custom system prompts to compensate for product behaviour, no arbitrary sleeps as synchronisation, and no reduction of committed parallelism (`describe.concurrent`, pool and worker caps, Playwright `fullyParallel`).
- New tests use the default model unless they are about models (provider cells in I1).
- A correction followed by a re-run on a new candidate is ordinary development. Release qualification on unchanged source follows the repository rule exactly: after complete initial coverage, 1-5 failed cases may be verified once sequentially; 6 or more fail the run. Both the initial and the final reports are kept.
- Each workstream runs targeted test files in the dev pod on a committed, clean SHA; full suites run only on the integration branch (parent).

## Requirement traceability

| Requirement | Implementation | Evidence |
|---|---|---|
| FR-001, FR-002 | A2 (`cms_turn_control_add`), C1 | `turn-control-cms.test.js`; `turn-control-management.test.js` |
| FR-003 | A2, C1 (`steering_disabled`, size limit) | `turn-control-cms.test.js`; C1 tests |
| FR-004 | A2 (dedup), C1 + C3 (P14) | `turn-control-cms.test.js`; `turn-control-management.test.js`; `turn-control-controller.test.mjs`; UX-20 |
| FR-005 | A3 | `turn-control-hub.test.js`; `turn-control.test.js` (lost notification) |
| FR-006 | A3, A4, B2 | `turn-control-live.test.js`; `turn-control.test.js`; B2 live Stop; UX-07 |
| FR-007, FR-008 | A3 | `turn-control-live.test.js`; `turn-control.test.js`; UX-02 to UX-04 |
| FR-009, FR-010 | A2, A4 | `turn-control-cms.test.js`; `turn-control-run-turn.test.js`; UX-08 to UX-10 |
| FR-011, FR-012 | A4, A5 | `turn-control-run-turn.test.js`; `turn-control-crash.test.js` |
| FR-013 | A4 (P12 evidence), B2 | `turn-control-run-turn.test.js`; `turn-control-orchestration.test.js`; UX-05, UX-06 |
| FR-014 | A2 (`closeControls`), B2 | `turn-control-cms.test.js`; `turn-control-orchestration.test.js` |
| FR-015 | A2 (`turn_high`), A5 | `turn-control-cms.test.js`; `turn-control-multi-worker.test.js` |
| FR-016 | A1 (routing), B1, B2 | `turn-control-contract.test.mjs`; B2 routing, legacy and upgrade tests; UX-14 |
| FR-017 | A1 (flag), C1, C3 | `turn-control-management.test.js`; controller tests; UX-01 |
| FR-018 | C1 (`session:write`) | API tests; UX-13 |
| FR-019 | C1, C2, C3 | parity, MCP, history and e2e tests; UX-15, UX-16 |
| FR-020 | I1 (procedure and docs), B1 (frozen 1.0.80) | I1 documentation; `orchestration-version-upgrade.test.js` |
| FR-021 | A4 | `turn-control-run-turn.test.js` (call count, no cursor) |
| FR-022 | A3, A5 | `turn-control-hub.test.js`; `turn-control.test.js` (worker stop); A5 measurements |
| SC-001, SC-002 | A3, A4; measured in I1/U1 | UX-17, UX-18 |
| SC-003 | A2, A4, C3 | `turn-control-cms.test.js` (every FR-009 cell); history tests; UX-15 |
| SC-004 | A5 | `turn-control-crash.test.js`; `turn-control-multi-worker.test.js` |
| SC-005 | A4, B2 | P12 tests; UX-05, UX-06 |
| SC-006, SC-007 | A3, A4, A5 | `turn-control-run-turn.test.js`; `turn-control-hub.test.js`; A5 measurements |
| SC-008 | A1, B2, C1, C3 | routing, legacy, flag and access tests; UX-01, UX-13, UX-14 |
| SC-009 | B1, B2; full suites in I1 | replay, multi-worker, chaos, stop suites |
| SC-010 | A5, I1, U1 | evidence matrix with covered/not-covered labels |

## Phase Status

Workstream A (this branch):
- [ ] **Phase A1: Contract** - Shared types, constants, routing names and tag, scheduling hooks, CMS method signatures and the `sessions.steering` definition; merged before B and C start.
- [ ] **Phase A2: CMS migration 0082** - Column, procedures, flag row, `cms.ts` implementations and procedure tests.
- [ ] **Phase A3: Worker live control** - TurnControlHub, LiveTurnControl, ManagedSession send gate and settlement, worker start/stop of the listener.
- [ ] **Phase A4: runTurnV4** - Turn start, fold, live registration, cursor save and turn end in the activity; the V4 names run the new handler.
- [ ] **Phase A5: End-to-end, crash and multi-worker verification** - Real-CLI integration, fault-point crash matrix, stale worker, measurements.
- [ ] **Phase A6: Documentation (A)** - Docs.md for workstream A, CMS schema and system reference docs.

Workstream B:
- [ ] **Phase B1: Freeze 1.0.80** - Frozen copy registered, version 1.0.81 opened, no behaviour change.
- [ ] **Phase B2: Orchestration 1.0.81** - No Stop race, turn-control routing, carried steers, closing controls.
- [ ] **Phase B3: Documentation (B)** - Orchestration design doc and B's Docs.md.

Workstream C:
- [ ] **Phase C1: Management client and Web API** - Steer operation, new Stop path with legacy fallback, protocol and transports.
- [ ] **Phase C2: MCP** - `steer_session_turn` tool and Stop result update.
- [ ] **Phase C3: Portal and TUI** - Steer action, transcript outcomes, `data-testid` contract, TUI parity and keybinding surfaces.
- [ ] **Phase C4: Documentation, templates and samples (C)** - Canonical docs, builder templates, examples, CHANGELOG, C's Docs.md.

Parent:
- [ ] **Decision D6 recorded** - Owner's choice for carried steers whose next turn ends stopped; spec and plan aligned (before the D6-dependent parts of A4, B2, C3).
- [ ] **Phase I1: Integration** - Merge A, B, C; full suites; provider cells; latency; local instance; rollout and rollback procedure.
- [ ] **Phase U0: Deployment route for the integration candidate (parent)** - An approved route to put the exact integration commit in the test environment.
- [ ] **Phase U1: UX test pass (parent)** - Swarm of test agents in the test environment with a real model; organized screenshot reports.
- [ ] **Phase F1: Final PR to main (parent)** - One PR from `waldemort/turn-control` to `main`.

## Phase Candidates

<!-- none -->

---

## Phase A1: Contract

Consumes: design 4.1-4.9, 6; Spec FR-001 to FR-022. Produces the interfaces B and C build against. Must merge into `waldemort/turn-control` before B and C start.

### Changes Required:
- **`packages/sdk/src/types.ts`**:
  - `TurnControlKind = "steer" | "stop"`; `TurnControl { seq: number; kind: TurnControlKind; text: string; createdAt: string }` (`createdAt` feeds P13).
  - `TurnControlOutcome = "delivered" | "carried" | "not_delivered" | "stopped" | "too_late"`.
  - `LateSteer { seq: number; text: string }`; carriers `LateSteersCarrier { lateSteers?: LateSteer[] }`, `ControlCursorCarrier { controlCursor?: { turn: number; cursor: number } }` and `CarriedSteersConsumedCarrier { carriedSteersConsumed?: true }` (P12) intersected into `TurnResult` (pattern: `SnapshotCommitCarrier`, `types.ts:45-69`).
  - `TurnControlRefusal = "no_turn" | "legacy_turn" | "not_found" | "too_many" | "request_id_reused" | "steering_disabled"`; `TurnControlAddResult = { seq: number; turn: number; repeat?: true } | { refused: TurnControlRefusal }`; `TurnStartResult = { stale: true } | { stopped: boolean; controls: TurnControl[] }`; `TurnLookInput { sessionId: string; turn: number; after: number }` (mapped to the procedure's `{session, turn, after}`); `TurnLookRow { sessionId: string; turn: number; controls: TurnControl[] }`; `TurnEndKind = "stopped" | "error" | "other"`; `TurnEndResult { stopped: boolean; late: LateSteer[] }`. The control actor is the existing `MessageSender` (`message-sender.ts:15`), normalized.
  - `SteerTurnOptions { text: string; requestId: string }`; `SteerTurnResult = { outcome: "accepted"; steerId: number; turn: number; repeat?: true } | { outcome: TurnControlRefusal }`; new named `StopTurnOptions { reason?: string; timeoutMs?: number; requestId?: string }` (the method's inline options type today, `management-client.ts:2498-2501`, is replaced by it in C1); `StopTurnResult` gains outcome `"too_late"` and optional `controlSeq`.
  - Orchestration continue-as-new input gains `carriedSteers?: LateSteer[]` (next to `budgetStash`, `types.ts:1047`).
- **`packages/sdk/src/turn-control-contract.ts`** (new): `TURN_CONTROL_EVENT_TYPES` (`user.steer`, `user.stop`, `session.control_outcome`), `TURN_CONTROL_CHANNEL = "pilotswarm_turn_control"`, `TURN_CONTROL_MAX_OPEN = 20`, `TURN_CONTROL_LOOK_INTERVAL_MS = 5000`, `TURN_CONTROL_OUTCOME_POLL_MS = 250`, `CARRIED_STEERS_WAKE_PROMPT`, `STEERING_FEATURE_KEY = "sessions.steering"`, and `acceptsTurnControl(row)` (P5).
- **`packages/sdk/src/activity-routing.ts`**: `TURN_CONTROL_CAPABILITY`, contract `"turn-control-v1"`, `TURN_CONTROL_ACTIVITY_NAMES { runTurn: "runTurnV4", runTurn2: "runTurnEpochV4" }`, `routeTurnControlActivity(task)`, and `registerTurnControlActivity(runtime, name, handler)`. Existing exports unchanged.
- **`packages/sdk/src/session-proxy.ts`** (scheduling side and pass-through only):
  - `createSessionProxy(..., "turn-control-v1").runTurn` schedules the V4 name and tags it with `TURN_CONTROL_CAPABILITY` for every turn, workspace or not; it forwards `turnMeta.carriedSteers` into the activity input only when non-empty. Behaviour for `undefined` and `"agent-handoff-v2"` stays byte-for-byte the same (frozen versions).
  - Every other proxy method that routes with `routingContract` treats `"turn-control-v1"` like `"agent-handoff-v2"` (handoff names and tag) unless it is `runTurn`.
  - `createSessionManagerProxy().updateCmsState(sessionId, state, lastError?, waitReason?, opts?: { closeControls?: boolean })` adds `closeControls: true` to the payload only when set; the `updateCmsState` activity passes it to `catalog.updateSession`.
  - Register `runTurnV4`/`runTurnEpochV4` to today's `runTurnHandler` (P3). The handler input type gains `carriedSteers?: LateSteer[]` (ignored until A4).
- **`packages/sdk/src/worker.ts`**: add `TURN_CONTROL_CAPABILITY` to `workerTagFilter.defaultAnd`.
- **`packages/sdk/src/cms.ts`**: `SessionCatalog` gains `turnControlAdd(sessionId: string, kind: TurnControlKind, text: string, requestId: string, actor: MessageSender | null): Promise<TurnControlAddResult>`, `turnStart(sessionId: string, turn: number): Promise<TurnStartResult>`, `turnLook(turns: TurnLookInput[]): Promise<TurnLookRow[]>`, `turnEnd(sessionId: string, turn: number, cursor: number, kind: TurnEndKind): Promise<TurnEndResult>`; `completeTurnWriteback` returns `Promise<boolean>` (`PgSessionCatalog` returns `rows[0]?.<column> === true`, which is `false` against today's `VOID` procedure; the activity's best-effort wrapper turns a failed write into `undefined`, P15). `SessionRowUpdates` gains `closeControls?: boolean`; `SessionRow` gains `turnHigh?: number | null`. The four new `PgSessionCatalog` methods throw `TurnControlUnavailableError` until A2.
- **`packages/sdk/src/feature-flags.ts`**: `"sessions.steering"` (display "Steer running turns", default off, user override allowed, no required capability). Its catalog row is published by migration 0082 (A2).
- **`packages/sdk/src/index.ts`**: export the new types, constants, `acceptsTurnControl` and `TurnControlUnavailableError`.
- **Tests**: `packages/sdk/test/unit/turn-control-contract.test.mjs`: routing names and tag; the proxy with a fake `ctx` schedules V4 with the turn-control tag only under `"turn-control-v1"`, forwards `carriedSteers` only when non-empty; for `undefined` and `"agent-handoff-v2"` a snapshot of activity name, input (including omitted and null optional fields), affinity key and tag for normal, epoch-start and workspace turns is identical to today's; `updateCmsState` payload includes `closeControls` only when set (property absent otherwise); the flag definition values; `acceptsTurnControl`; the exported types compile (a `.d.ts` usage fixture under `test/types/` if that folder's pattern applies).

### Success Criteria:

#### Automated Verification:
- [ ] Build: `npm run build` (dev pod)
- [ ] `node --test packages/sdk/test/unit/turn-control-contract.test.mjs packages/sdk/test/unit/agent-handoff-routing.test.mjs packages/sdk/test/unit/cms-migrations-shape.test.mjs`
- [ ] `npm run test:unit --workspace=pilotswarm-sdk` passes (frozen-proxy behaviour unchanged)
- [ ] Targeted Vitest: `stop-turn.test.js`, `feature-flags.test.js`, `feature-store.test.js`, `session-proxy-events.test.js`
- [ ] Privacy check passes

#### Manual Verification:
- [ ] B and C coordinators confirm the contract covers their phases without edits to A's files
- [ ] No behaviour change for a 1.0.80 session (scheduled name, input and tag identical)

---

## Phase A2: CMS migration 0082

Consumes A1. Design 4.1, 4.2, 5.2, 5.3; Spec FR-001 to FR-004, FR-009, FR-010, FR-014, FR-015, FR-021. Test plan 7.1.

### Changes Required:
- **`packages/sdk/src/migrations/turn-control-0082.ts`** (new SQL builder, pattern `model-event-logging-flag-0081.ts`), registered as `{ version: "0082", name: "turn_control" }` in `cms-migrations.ts`:
  - `sessions.turn_high INTEGER NOT NULL DEFAULT -1`.
  - `cms_turn_open_controls`, `cms_turn_control_add` (with `pg_notify` on `pilotswarm_turn_control`, payload `{ schema, sessionId }`), `cms_turn_start`, `cms_turn_look`, `cms_turn_end` exactly as design 4.2, outcome table design 5.2.
  - `DROP FUNCTION` + `CREATE` of `cms_complete_turn_writeback` with the same 23 parameters returning `BOOLEAN`: after the existing row update (row lock) it returns whether the turn has open controls.
  - `CREATE OR REPLACE cms_update_session` (latest from 0059, same signature) adding `closeControls`: an outcome for every open control of the session (`stopped` for a Stop, `not_delivered` for a Steer).
  - `cms_get_session` returns `turn_high` (DROP + CREATE because the row shape changes; P5). Start from the overload that `PgSessionCatalog.getSession` actually calls today (including the placement-aware variant) and keep every existing column, parameter and default; the diff file shows it.
  - Publish the `sessions.steering` definition row, as 0081 does.
- **`packages/sdk/src/migrations/0082_diff.md`**: the delta for each changed procedure against its previous definition, the new procedures, the column and the flag row.
- **`packages/sdk/src/cms.ts`**: implement the four methods (procedure calls only), `completeTurnWriteback` boolean, `closeControls` in `updateSession`'s field map, `turnHigh` mapping in `SessionRow`; add the procedure names to the qualified-name map.
- **Tests**: `packages/sdk/test/local/turn-control-cms.test.js` (real PostgreSQL), every row of design 7.1: accepted add with event and notification (a `LISTEN` client sees `{schema, sessionId}`); refusals `no_turn`, `legacy_turn`, `not_found`, `too_many` (21st), `request_id_reused`; retry returns the first seq with `repeat`; turn start sets both columns, returns open controls in order, `stale` for an older turn, `stopped` after a stopped outcome; look filters by `after`; turn end produces every cell of the Spec FR-009 table and is idempotent; writeback boolean, and both orders of add versus writeback on two connections (`pg_sleep` inside one transaction); `closeControls`; `cms_get_session` returns `turn_high`; the call count for a no-controls turn. Extend `cms-turn-metrics.integration.test.js` for the boolean return and `cms-migrations-shape.test.mjs` if it pins return shapes.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes
- [ ] `npx vitest run test/local/turn-control-cms.test.js test/local/cms-turn-metrics.integration.test.js test/local/pg-migrator.test.js test/local/feature-store.test.js test/local/cms-event-type-filter.test.js` (dev pod, own database `tc_a_*`)
- [ ] `node --test test/unit/cms-migrations-shape.test.mjs`
- [ ] Migration applies on a fresh database and on a database at 0081 (upgrade)
- [ ] Privacy check passes

#### Manual Verification:
- [ ] `0082_diff.md` shows each procedure delta against its previous definition
- [ ] No inline SQL added to `cms.ts`; no new table or index

---

## Phase A3: Worker live control

Consumes A1, A2. Design 4.4-4.6; Spec FR-005 to FR-008, FR-022. Test plan 7.2, part of 7.3.

### Changes Required:
- **`packages/sdk/src/turn-control.ts`** (new):
  - `TurnControlHub`: one dedicated `pg.Client` from `buildSessionCatalogPgClientConfig` with keepAlive; `LISTEN pilotswarm_turn_control`; filters by schema; reconnect with backoff (pattern `live-plane.js:93-154`); on reconnect, one look for all live turns; a 5 s batched look only while it has live turns (`unref`'d timer); `register`/`unregister` by exact `session/turn` instance; `start()`/`stop()`.
  - `LiveTurnControl`: `sent`/`cursor`, an in-order apply chain, skip `seq <= sent`, stop sending when the gate is closed, Stop closes the gate before `abortWarmSessionTurn`, Steer through `ManagedSession.sendSteer` and moves `cursor` only on confirmation; an apply error fails the turn.
- **`packages/sdk/src/managed-session.ts`**: per-turn send gate; `sendSteer(text, onConfirmed)` arms a `user.message` watch before `copilotSession.send({ prompt, mode: "immediate" })`, recognises a confirmation that arrives before `send` resolves (by the returned message id); the unconfirmed set; on `session.idle` close the gate first, settle only when no steer is unconfirmed, else wait for the confirmations and the next idle, bounded by the existing turn timeout; a send failure fails the turn; `closeSteerGate()`/`steerGateOpen()`. Confirm the installed SDK `send` typing (`mode`, returned id) in the dev pod's `node_modules` (research O1) and record it in Docs.md.
- **`packages/sdk/src/session-manager.ts`**: access to the per-worker hub for the activity, and an abort entry that the live loop can call while the run-turn lock is held (reuse `abortWarmSessionTurn`, which bypasses the lock).
- **`packages/sdk/src/worker.ts`**: create the hub after the catalog (`:700-720`), `start()` it before the runtime starts, `stop()` it in `stop()` before the catalog closes; pass it to `registerActivities`.
- **Tests**:
  - `packages/sdk/test/local/turn-control-live.test.js` (fake Copilot session, pattern `stop-turn.test.js:30-66`): gate closes at idle before anything else; an unconfirmed steer delays settlement until its `user.message` and the next idle; early confirmation; Stop closes the gate before abort and a later steer is not sent; a throwing send fails the turn; duplicates skipped and order kept; settlement bounded by the turn timeout.
  - `packages/sdk/test/local/turn-control-hub.test.js` (real PostgreSQL): a notification wakes the right live turn; a killed LISTEN connection (`pg_terminate_backend`) still delivers within 5 s by the periodic look and reconnects; no look while no turn is registered; one batched look for several turns; `stop()` closes the connection.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes
- [ ] `npx vitest run test/local/turn-control-live.test.js test/local/turn-control-hub.test.js test/local/stop-turn.test.js test/local/turn-inactivity-watchdog.test.js test/local/managed-session-reasoning.test.js`
- [ ] `npm run test:unit --workspace=pilotswarm-sdk`
- [ ] Privacy check passes

#### Manual Verification:
- [ ] The installed SDK `send` signature supports `mode: "immediate"` and returns the message id (recorded in Docs.md)
- [ ] The worker holds exactly one extra connection while running (checked with `pg_stat_activity` in the hub test)

---

## Phase A4: runTurnV4

Consumes A1-A3. Design 4.7, 4.8, 5.1, 5.2; Spec FR-009 to FR-013, FR-021. Test plan 7.1 (cost), parts of 7.3 and 7.4 at the activity level.

### Changes Required:
- **`packages/sdk/src/session-proxy.ts`**: a turn-control path in the run-turn handler, selected only for `runTurnV4`/`runTurnEpochV4` (V3 path unchanged):
  - already-committed preamble result → `finishTurn` with the saved cursor (T8 only);
  - after the gates and the existing pre-turn writes: `turnStart` (T3) replaces `setActiveTurnIndex`; `stale` → throw; with controls or a stopped outcome, read the saved cursor from the turn-commit file only then; an open Stop or a stopped outcome → `finishTurn({type:"stopped"})` without a model run; else fold open steers (and `carriedSteers`, replacing `CARRIED_STEERS_WAKE_PROMPT` when it is the prompt) in front of the prompt without recording them again;
  - register a `LiveTurnControl` with the hub for the model run, unregister in `finally`;
  - T6 uses the writeback result by P15 (`false` skips T8; `true` and `undefined` run it); T7 saves `controlCursor` only when the cursor is not 0, adopts the winner's result and cursor on `alreadyCommitted`, uses cursor 0 when unpublished;
  - T8 `finishTurn`: cancellation check, `turnEnd`, retried in place on a database error then failing the activity; `stopped` → stopped result; late steers → `lateSteers` on the result; skipped when the writeback reported no controls;
  - `carriedSteersConsumed: true` on the result by P12: set when carried text was folded into a prompt that reached the model run and on the already-committed path; never on gate returns, pre-model returned errors or throws; for a Stop applied at turn start, per D6 once decided;
  - the P13 trace line when a steer is confirmed;
  - fault points P10 at T3, T6, T7, T8;
  - register `runTurnV4`/`runTurnEpochV4` to the turn-control path (replacing A1's aliases).
- **`packages/sdk/src/snapshot-protocol.ts` / `session-lifecycle.ts`**: `readTurnCommitFile(sessionDir)` and `savedControlCursor(result, turn)`; no protocol change.
- **Tests**: `packages/sdk/test/local/turn-control-run-turn.test.js` (activity harness `test/helpers/run-turn-activity-harness.mjs`, extended with the new catalog methods, fake model session): no-controls turn makes today's calls and saves no cursor; steer folded at start; Stop at start ends without a model run; cursor saved and used on already-committed; each FR-009 result kind maps to the activity result (`stopped`, `lateSteers`, error with open Stop → stopped); turn end retried in place; carried steers folded and the wake prompt replaced; gate-refused turn never calls turn start; `carriedSteersConsumed` set and not set exactly per P12 (budget wait, workspace wait, provider-admission error without a workspace, thrown error, stale start, consumption, already-committed; Stop at start per D6); writeback `undefined` still runs turn end (P15). Update `turn-lifecycle.test.js` only if helpers move.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes
- [ ] `npx vitest run test/local/turn-control-run-turn.test.js test/local/turn-lifecycle.test.js test/local/snapshot-protocol-fs.test.js test/local/session-proxy-events.test.js test/local/stop-turn.test.js test/local/turn-control-live.test.js test/local/turn-control-cms.test.js`
- [ ] `npm run test:unit --workspace=pilotswarm-sdk`
- [ ] Privacy check passes

#### Manual Verification:
- [ ] The V3 path is unchanged (diff review)
- [ ] The save happens before turn end on every path (design 5.1 reverse-order warning)

---

## Phase A5: End-to-end, crash and multi-worker verification

Consumes A4 and B2 on `waldemort/turn-control` (A merges the integration branch into its branch first). Design 3.x, 5.1, 7.3-7.5, 7.8; Spec US-1 to US-5, US-7; SC-004, SC-006, SC-007.

### Changes Required:
- **Tests**:
  - `packages/sdk/test/local/turn-control.test.js` (real CLI, default model): rows of design 7.3 — steer between tools delivered, steer during a long tool delivered after it, late steer carried and run next and shown once, Stop stopped with session idle and timers kept, Stop with pending steer, Stop too late with carried steers not delivered, no-controls turn, lost notification, worker stop closes the listener.
  - `packages/sdk/test/local/turn-control-crash.test.js` (kill harness, fault points P10): the US-5 matrix, asserting outcomes, transcript and each steer once in the restored conversation (read the restored conversation's events).
  - `packages/sdk/test/local/turn-control-multi-worker.test.js`: stale worker paused past its lock, cancelled, one save wins, both turn ends write the same outcomes (design 3.9); verifies research O2-O4 live (cancellation reaches JS within the poll).
  - `packages/sdk/test/perf/turn-control-look-cost.mjs` (run by hand in the dev pod, not part of a suite): look query time and database CPU at 1, 10 and 50 live turns; one extra connection per worker. Connection budget: compare `max_connections` minus reserved connections with workers × (CMS pool max + facts pool max + duroxide pool max + 1 listener) + portal connections, using the deployment defaults (`PILOTSWARM_CMS_PG_POOL_MAX`, `PILOTSWARM_FACTS_PG_POOL_MAX`, `DUROXIDE_PG_POOL_MAX`). Results recorded in Docs.md; no pass/fail threshold is invented.
  - HorizonDB listener check (research O5): run `turn-control-hub.test.js` with `--with-horizondb` when the dev pod has HorizonDB configuration; otherwise record "not covered" with the reason.
- **Code**: only fixes found by these tests, within A's files.

### Success Criteria:

#### Automated Verification:
- [ ] `npx vitest run test/local/turn-control.test.js test/local/turn-control-crash.test.js test/local/turn-control-multi-worker.test.js test/local/fault-injection-live.test.js test/local/stop-turn-live.test.js`
- [ ] All A test files from A1-A4 still pass
- [ ] Privacy check passes

#### Manual Verification:
- [ ] Measurements recorded in Docs.md with test parameters (turn counts, duration)
- [ ] HorizonDB listener result recorded (covered or not covered with reason)

---

## Phase A6: Documentation (A)

### Changes Required:
- **`.paw/work/turn-control/Docs.md`**: workstream A as built (load `paw-docs-guidance`): contract, procedures, hub, settlement, runTurnV4 order, fault points, measurements, SDK send typing, P11 behaviour.
- **`docs/architecture/internals/cms-schema.md`**: `turn_high`, the control events, the procedures, the channel.
- **`docs/architecture/system-reference.md`**: the turn-control hub next to the abort primitive.

### Success Criteria:
- [ ] Content matches the code at the phase SHA; links resolve
- [ ] Privacy check passes

---

## Phase B1: Freeze 1.0.80

Consumes nothing new. Orchestration versioning rules (`.github/copilot-instructions.md`).

### Changes Required:
- **`packages/sdk/src/orchestration_1_0_80/`** (new): exact copy of `orchestration/` with imports adjusted, as for `orchestration_1_0_79/`.
- **`orchestration-version.ts`**: `DURABLE_SESSION_LATEST_VERSION = "1.0.81"`; add `TURN_CONTROL_ORCHESTRATION_MIN_VERSION = "1.0.81"`.
- **`orchestration-registry.ts`**, **`orchestration.ts`**: register `1.0.80` from the frozen folder and the latest from `orchestration/`.
- **Tests**: `test/unit/orchestration-freeze-1-0-80.test.mjs` (pattern `orchestration-freeze-1-0-71.test.mjs`); update `test/unit/agent-handoff-routing.test.mjs` pins.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes; `npm run test:unit --workspace=pilotswarm-sdk`
- [ ] `npx vitest run test/local/orchestration-version-upgrade.test.js test/local/durability.test.js`

#### Manual Verification:
- [ ] The frozen folder is byte-identical to `orchestration/` at the freeze commit except imports

---

## Phase B2: Orchestration 1.0.81

Consumes A1 (contract), and A4 for its live tests. Design 4.9, 3.11, 3.12, 6; Spec FR-006, FR-013, FR-014, FR-016; US-1, US-3, US-6. Test plan 7.5.

### Changes Required:
- **`orchestration/lifecycle.ts`, `runtime.ts`, `turn.ts`**: create the session proxy with contract `"turn-control-v1"` at every call site.
- **`orchestration/turn.ts`**:
  - `processPrompt`: remove `stopTurn.<n>` dequeue, `ctx.race` and the `abortTurn` call; `yield` the turn task directly. Keep the "stopped" result handling (`:1577-1597`) as the Stop path: `session.turn_stopped` (with turn index and client message ids), idle, `retryCount = 0`, timers and cron kept, no retry.
  - Pass `state.carriedSteers` as `turnMeta.carriedSteers`. Clear it only when the result has `carriedSteersConsumed === true`, or on a give-up/terminal path (P12). Do not reuse the `budgetStash` `pastGates` predicate (`turn.ts:1301-1320`): a provider-admission error returned before the gates would satisfy it. Frozen versions keep their predicate unchanged.
  - After any result with `lateSteers`, append them to `state.carriedSteers`. Then: `input_required` → they ride with the answer (D3); a returned error → they ride with the retry; any other result → schedule the next turn at once, as if a user message had arrived when the turn ended, using `CARRIED_STEERS_WAKE_PROMPT` when no other prompt is pending.
  - Give-up paths (retries exhausted, non-retryable, auth, fatal, missing state) and terminal paths call `updateCmsState(..., { closeControls: true })`.
- **`orchestration/state.ts`**: `carriedSteers` state field, initialised from input.
- **`orchestration/lifecycle.ts`**: carry non-empty `carriedSteers` in the continue-as-new input (next to `budgetStash`, `:590`).
- **`orchestration/agents.ts`**, **`runtime.ts`**: `closeControls` on terminal state writes.
- **Tests**:
  - `packages/sdk/test/local/turn-control-orchestration.test.js`: with scripted activity results (pattern of existing orchestration tests): `lateSteers` → immediate next turn carrying them; with `input_required` → carried with the answer; with error → carried into the retry; across continue-as-new; kept on a budget wait, a workspace wait, a provider-admission error without a workspace, a returned error and a thrown error; cleared only on `carriedSteersConsumed` and on give-up/terminal paths; the stopped-next-turn case per D6; give-up and terminal writes carry `closeControls`; no `stopTurn` dequeue in 1.0.81; deterministic helpers only (`ctx.utcNow`, `ctx.newGuid`, durable timers).
  - Routing: a worker without `pilotswarm.turn-control.v1` never runs `runTurnV4` (two workers with different tag filters).
  - Legacy: a 1.0.80 session still stops through the event path; the management client's `legacy_turn` fallback is exercised by C1's tests.
  - Upgrade: a 1.0.80 session continues-as-new into 1.0.81 and its next turn routes to V4.
  - Live (after A4 merged): Stop on a 1.0.81 session ends "stopped" and the session is idle with timers kept.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes; `npm run test:unit --workspace=pilotswarm-sdk`
- [ ] `npx vitest run test/local/turn-control-orchestration.test.js test/local/orchestration-version-upgrade.test.js test/local/multi-worker.test.js test/local/durability.test.js test/local/stop-turn-live.test.js test/local/session-regen-orchestration.test.js`

#### Manual Verification:
- [ ] No nondeterminism for replayed 1.0.80 sessions (frozen code untouched; the frozen folder's own version constant stays the literal `"1.0.80"`)
- [ ] Every give-up and terminal path closes controls (diff review against the call list in research Q17)

---

## Phase B3: Documentation (B)

### Changes Required:
- **`docs/architecture/orchestration/design.md`**: 1.0.81 turn flow without the Stop race; carried steers.
- **`.paw/work/turn-control-b/Docs.md`**.

### Success Criteria:
- [ ] Content matches code; privacy check passes

---

## Phase C1: Management client and Web API

Consumes A1; live tests need A2. Design 4.3; Spec FR-001 to FR-004, FR-017 to FR-019; US-2, US-4, US-6.

### Changes Required:
- **`packages/sdk/src/management-client.ts`**:
  - Public session view (`PilotSwarmSessionView`, `management-client.ts:392-442`; detailed view built at `:1315-1357`): add `activeTurnIndex: number | null`, `turnHigh: number | null` and `acceptsTurnControl: boolean` (always present, `false` when unknown) to the detailed view in direct and Web API modes. List rows do not carry them (list procedures unchanged); clients read eligibility only from the detailed view.
  - `steerSessionTurn(sessionId, opts: SteerTurnOptions)` (flag check P7, text size limit as `sendMessage`, `turnControlAdd`, refusals mapped; `requestId` required and passed through unchanged); `stopSessionTurn(sessionId, opts?: StopTurnOptions)` new path: `turnControlAdd("stop", reason, requestId ?? new id)`; `no_turn` → `no_active_turn`; `legacy_turn` → today's event path (kept as `legacyStopSessionTurn`); accepted → wait for the outcome (P6) → `stopped` / `too_late` / `timeout`.
- **`packages/sdk/api/src/protocol.js`**: operation `steerSessionTurn`, `POST /management/sessions/:sessionId/steer`, access `session:write`; `stopSessionTurn` options accept `requestId`.
- **`packages/sdk/src/web/generated-op-methods.ts`** regenerated with `npm run generate:web-ops -w packages/sdk` (never hand-edited), **`web/web-management-client.ts`** (direct/web parity), **`packages/sdk/api/src/http-api-transport.js`**, **`packages/app/tui/src/node-sdk-transport.js`** (forward `requestId` and all Stop/Steer options unchanged; today it rebuilds Stop options, `:1559-1563`), **`packages/app/web/runtime.js`** dispatch.
- **Tests**: `packages/sdk/test/local/turn-control-management.test.js`: with a fake catalog, every refusal and the accepted path, the Stop outcome wait and timeout, the legacy fallback, flag off, the detailed-view fields (direct and web shapes identical; `acceptsTurnControl` false when the turn ends, waits or is legacy); against real PostgreSQL after A2: accepted steer recorded once; an accepted request whose response is lost, then the turn ends, then a same-id retry returns the original answer with one control event; no-turn refusal followed by a message is delivered once. API tests in `packages/sdk/api/test/` for the route and `session:write` (read-only caller refused, nothing recorded); direct/web parity test.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes; `npm run test:api --workspace=pilotswarm-sdk`
- [ ] `npx vitest run test/local/turn-control-management.test.js test/local/stop-turn.test.js test/local/management.test.js`

#### Manual Verification:
- [ ] Steer is reachable only through the management operation in both modes

---

## Phase C2: MCP

Consumes C1. Design 4.3.

### Changes Required:
- **`packages/app/mcp/src/tools/turn-control.ts`**: `steer_session_turn` (text, request id) through the management client; `stop_turn` reports `too_late` and accepts a request id.
- **`packages/app/mcp/README.md`**; MCP unit test `packages/app/mcp/test/unit/turn-control.unit.mjs`, added to the explicit `test:mcp` list in `packages/app/package.json`; extend `dispatch.unit.mjs` and `no-raw-op-calls.unit.mjs` expectations if they enumerate tools.

### Success Criteria:
- [ ] `npm run test:mcp --workspace=pilotswarm`

---

## Phase C3: Portal and TUI

Consumes C1. Design 4.10; Spec FR-018, FR-019; US-1 to US-4, US-6. Test plan 7.6 (component level).

### Changes Required:
- **`packages/app/ui/core/src/commands.js`, `controller.js`, `selectors.js`**: `STEER_TURN` command; request ids by P14 for Stop and Steer (pending `{requestId, kind, text}` kept across a transport failure, explicit Retry reuses it, no message fallback on transport failure); fallback to a normal message with a new client message id only after a definite `no_turn`/`legacy_turn` Steer refusal; `canSteer` = the detailed view's `acceptsTurnControl` and the viewer's `sessions.steering` (resolved through the existing feature read at session load and feature refresh); eligibility is refreshed from the detailed view on turn start, turn end, stop, wait and question events and set explicitly to `false` (never left undefined, since the merge skips undefined values, `controller.js:452-462`); Stop result `too_late` handled; the carried-then-stopped rendering per D6 (Option A: label "Carried, then stopped", badge `carried_then_stopped`).
- **`packages/app/ui/core/src/history.js`**: allowlist `user.steer`, `user.stop`, `session.control_outcome`; render a steer as a user message with a "steer" badge and its outcome (Delivered, Will run next, Not delivered, Stopped, Too late; "Pending" while open); render a Stop as a short system line with its outcome; bulk and live paths; survives reload.
- **`packages/app/ui/react/src/web-app.js`**: Steer button next to Stop; outcome badges; the `data-testid` contract below.
- **`packages/app/tui/src/app.js`** and TUI selectors: Ctrl+T (P9); status hints, help/startup hint surfaces; `.github/skills/pilotswarm-tui/SKILL.md`.
- **Portal `data-testid` contract** (stable; the parent's UX pass asserts and screenshots them):

  | Selector | Element | Attributes |
  |---|---|---|
  | `composer-input` | prompt input | |
  | `turn-stop-button` | Stop button | `data-state="ready"|"stopping"` |
  | `turn-steer-button` | Steer button (present only when `canSteer`) | `data-state="ready"|"sending"` |
  | `session-turn-state` | turn status indicator | `data-turn-state="running"|"idle"|"waiting"|"input_required"|"error"|"failed"|"completed"|"cancelled"` (product states pass through unnormalized), `data-accepts-controls="true"|"false"` |
  | `control-steer` | transcript steer item | `data-control-seq`, `data-outcome` |
  | `control-stop` | transcript Stop line | `data-control-seq`, `data-outcome` |
  | `control-outcome-badge` | outcome badge inside a control item | `data-outcome="pending"|"delivered"|"carried"|"carried_then_stopped" (D6 Option A only)|"not_delivered"|"stopped"|"too_late"` |
  | `control-notice` | toast/inline notice for every non-accepted answer, fallback and failure | `data-kind="steer"|"stop"`, `data-reason="no_turn"|"legacy_turn"|"not_found"|"too_many"|"request_id_reused"|"steering_disabled"|"forbidden"|"too_long"|"no_active_turn"|"timeout"|"unconfirmed"|"fallback_sent"|"fallback_failed"|"error"` |
  | `control-retry-button` | Retry action on an `unconfirmed` notice (reuses the request id, P14) | `data-request-id` |
  | `transcript-user-message` | ordinary user message (also the steer fallback) | `data-client-message-id` |
  Every row and every attribute value above is a visible state; no Stop/Steer state is shown without one of them.
- **Tests**: `packages/app/ui/core/test/turn-control-history.test.mjs` (every outcome, bulk and live, reload, once only), `turn-control-controller.test.mjs` (steer; request id kept across a lost response and reused by Retry with one transcript item; fallback only on definite refusal; canSteer with flag, legacy, read-only and eligibility refresh to false; Stop too_late); TUI keybinding/status tests; a portal e2e spec `packages/app/web/test/e2e/turn-control.spec.mjs` with a fake transport asserting every selector and every attribute value of the table.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test --workspace=pilotswarm` (app unit tests)
- [ ] `npm run test:e2e --workspace=pilotswarm -- turn-control.spec.mjs` (Playwright, `web/playwright.config.mjs`)

#### Manual Verification:
- [ ] TUI and portal parity for every state (report any divergence and its reason)
- [ ] Walk Stop and Steer in `scripts/local-pilotswarm.sh` with two dev personas (one read-only share)

---

## Phase C4: Documentation, templates and samples (C)

### Changes Required:
- **Docs**: `docs/api/reference.md` (steer, Stop result, request id), `docs/user-guide/portal.md` (Steer, outcomes), keybinding docs, `docs/proposals/mcp-web-api-parity.md` only if it lists operations.
- **`templates/builder-agents/**`, `examples/devops-command-center/`**: research found no Stop surface; add Steer only where management operations are listed, else record "no change needed" in C's Docs.md.
- **`CHANGELOG.md`**: one entry for the feature.
- **`.paw/work/turn-control-c/Docs.md`**.

### Success Criteria:
- [ ] Content matches code; privacy check passes

---

## Phase I1: Integration (parent)

Consumes A, B, C. Spec SC-001 to SC-010; design 4.12, 7.6 (latency), 7.7.

### Changes Required:
- Merge the workstream PRs into `waldemort/turn-control`; apply the proposed `provider-test-coverage.json` entries.
- Full suites on the integration branch (`./scripts/run-tests.sh`, then `--all-providers` where configuration exists), no reduced parallelism.
- Provider cells (design 7.7) on Azure AI Foundry OpenAI Responses, GitHub Copilot and Anthropic; record missing credentials.
- Latency: 30-run Stop and Steer measurements (SC-001, SC-002) in the test environment.
- Local instance walk (design 4.12).
- Rollout and rollback procedure (FR-020, design 6): document in the deployment docs that migration 0082 is additive, capable workers and the portal/Web API roll out together, and a rollback keeps workers able to run 1.0.81 until its sessions drain unless a separately authorized coordinated database-and-code rollback is chosen; flag-off is not an orchestration rollback; no database reset.
- Connection budget (evidence 7.8) for the test environment's configured worker count, from A5's method.

### Success Criteria:
- [ ] Full stock suite passes (or qualified by the repository's sequential-verification rule)
- [ ] Evidence matrix (Spec SC-010) complete

---

## Phase U0: Deployment route for the integration candidate (parent)

The existing `deploy-azure.yml` deploys only a published release tag from `main` (`.github/workflows/deploy-azure.yml:4-49`; `.github/DEPLOYMENT.md:26-66`), so it cannot deploy `waldemort/turn-control` before F1. Before U1 the parent establishes, and gets the owner's authorization for, an approved route that puts the exact integration commit on a test target: either a workflow change (parent-owned) that deploys a named immutable candidate SHA to the test environment through GitHub Actions, or an approved separate test host. The route records the deployed SHA and image digests and states how the environment is restored afterwards. No local mutation of the managed environment, no release publication and no early merge to `main` substitute for it. U1 stays pending until the route exists.

---

## Phase U1: UX test pass (parent)

After I1 and U0 and before F1. The parent deploys the exact integration commit through the U0 route and runs a swarm of test agents with a real model. Each agent drives the portal (and the TUI where noted), asserts the `data-testid` contract of C3, and takes screenshots into an organized report (one folder per scenario, named by scenario id, with a pass/fail summary). Workstream C's own UI and controller tests remain required; this pass does not replace them.

Acceptance scenarios (from Spec and design 7.6):

| ID | Scenario | Assert (selectors) | Spec / design |
|---|---|---|---|
| UX-01 | Steer hidden with the flag off; visible with it on while a turn runs | `turn-steer-button` absent / present; `data-accepts-controls` | US-6.3, FR-017; 7.6 |
| UX-02 | Steer during a multi-tool turn | `control-steer` → `data-outcome="delivered"`; model follows it | US-2.1; 7.6 |
| UX-03 | Steer during a long tool call | delivered after the tool ends | US-2.2 |
| UX-04 | Two quick steers | two `control-steer`, in order, both delivered | US-2.3 |
| UX-05 | Late steer at the final answer | `data-outcome="carried"`, then a new turn runs it; shown once | US-3.1 |
| UX-06 | Late steer when the turn asks a question | carried, rides with the answer | US-3.2, D3 |
| UX-07 | Stop a running turn | `turn-stop-button` `data-state` stopping → gone; `control-stop` `data-outcome="stopped"`; `session-turn-state` idle | US-1.1 |
| UX-08 | Stop with a pending steer | steer `not_delivered`, Stop `stopped`, no new turn | US-1.2, D2 |
| UX-09 | Steer delivered, then Stop | the delivered steer shows `not_delivered` | US-1.3 |
| UX-10 | Stop just after the turn finished | `control-stop` `too_late`; carried steer `not_delivered` | US-1.5, D5 |
| UX-11 | Stop with no running turn | `control-notice` `data-reason="no_active_turn"`, nothing recorded | US-1.6 |
| UX-12 | Steer with no running turn | `control-notice` `fallback_sent`; one `transcript-user-message` | US-2.7, US-4.4 |
| UX-13 | Read-only shared viewer | no `turn-steer-button`; API refusal shows `forbidden` | US-2.9, FR-018 |
| UX-14 | Legacy session (started before the upgrade) | Stop works through today's path; no Steer | US-6.1 |
| UX-15 | Reload after each outcome | every `control-*` item and badge unchanged, once | US-4; 7.6 |
| UX-16 | TUI: the same flows (Ctrl+T, Ctrl+X) | status/help text shows the keys; outcomes match the portal | 7.6 TUI parity |
| UX-17 | Stop latency, 30 runs | p95 ≤ 2 s from accept to outcome (event timestamps) | SC-001, D1 |
| UX-18 | Steer latency, 30 runs between tool calls | p95 ≤ 2 s from `acceptedAt` to `confirmedAt` of the P13 trace line (nearest-rank 95th percentile of 30 runs; record model, provider, workload, duration and that each steer arrived between tool calls) | SC-002 |
| UX-19 | Steer racing the end of the turn | either the steer has an outcome or a `control-notice` `fallback_sent` and one `transcript-user-message`; never both, never neither | Edge case; US-2.7 |
| UX-20 | Lost response (network cut while steering) | `control-notice` `unconfirmed`; `control-retry-button` reuses the request id; one `control-steer` | US-4.2, P14 |
| UX-22 | Carried steer, then Stop before or during the next turn (behaviour per D6), before and after reload | Option A: `control-steer` `data-outcome` badge `carried_then_stopped`, no further turn; Option B: steer rides with the next user turn | US-3.5, D6 |
| UX-21 | Eligibility refresh | `data-accepts-controls` turns `false` when the turn ends, waits or asks a question; Steer button disappears | P5 |

### Success Criteria:
- [ ] Every mandatory scenario passes on the final integration candidate. A failure goes back to its owning workstream; after the fix lands, the affected scenarios are re-run on the new candidate. Initial failure evidence is kept in the report.
- [ ] UX-17 and UX-18 meet p95 ≤ 2 s under the stated conditions (UX-17 excludes a CLI that ignores abort), with percentiles and test parameters reported
- [ ] Evidence that cannot be produced (for example a missing provider credential) is labelled "not covered" with the reason; it never counts as a pass
- [ ] The report names the deployed SHA and image digests

---

## Phase F1: Final PR to main (parent)

One PR from `waldemort/turn-control` to `main`, opened on behalf of @affandar, with the evidence matrix, the UX report and the measurements. The owner and the team review it.

---

## References

- Design: `docs/proposals/session-turn-control.md` (revision 5); design PR https://github.com/microsoft/PilotSwarm/pull/169
- Spec: `.paw/work/turn-control/Spec.md` (r3)
- Research: `.paw/work/turn-control/CodeResearch.md`
- Reviews: `.paw/work/turn-control/reviews/` (spec review r1-r3, plan review r1 and later rounds, planning-docs review)
