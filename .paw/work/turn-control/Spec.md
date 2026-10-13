# Feature Specification: Session Turn Control (Stop and Steer)

**Branch**: waldemort/turn-control (umbrella), workstream branches below it  |  **Created**: 2026-10-13  |  **Status**: Draft
**Input Brief**: Let a user stop a running agent turn within about a second, or steer it with guidance the model receives inside the same turn, without losing, doubling or hiding any request across crashes.

Design source (binding): `docs/proposals/session-turn-control.md`, revision 5 (design PR 169). Requirements R1-R7 and decisions D1-D5 are taken at the design's proposed defaults, as approved by the owner for this build.

## Overview

An agent turn can run for minutes: the model calls tools, reads results and calls the model again. Today a user who sees the turn go wrong can only press Stop, and Stop takes about six seconds because the request travels through the session's orchestration and a second worker operation. A user who only wants to correct course ("use the v2 API", "skip the tests for now") has no way to do it: any message sent during a turn waits until the turn ends, and the work the model is doing continues in the wrong direction.

This feature gives every running turn a control channel. A user can **Stop** the turn and see it stopped in about a second. Or the user can **Steer** it: add guidance that the model receives at its next model call, inside the same turn, while keeping the work already done. Guidance that arrives too late for the running turn is not lost; it runs automatically with the next turn.

Both requests are part of the session's history. Each Stop and each Steer appears once in the conversation and ends with exactly one visible outcome: delivered, will run next, not delivered, stopped, or too late. A worker crash, a retried turn or a duplicated client request never loses an accepted Stop, never drops an accepted steer, and never gives the model the same steer twice.

The feature must stay simple and cheap. A turn that nobody stops or steers costs the same as today. Sessions that started on the previous orchestration version keep today's Stop. Steering is offered only when an operator enables it.

## Objectives

- Stop a running turn quickly and reliably, including across worker crashes. (Rationale: a wrong turn wastes time and tokens.)
- Let a user add guidance to a running turn that the model receives inside that turn. (Rationale: correcting course is often better than stopping.)
- Never lose a late steer; run it with the next turn.
- Show each request once, with one final outcome, in every client (portal, terminal UI, management API, MCP, CLI).
- Keep the cost of a turn without controls unchanged, and keep the mechanism small enough to reason about.
- Roll out without breaking sessions that run on older orchestration versions or older workers.

## User Scenarios & Testing

### User Story P1 – Stop a running turn

Narrative: A user watches a turn go wrong and presses Stop. The turn ends within about a second, the session becomes idle, and its timers and schedules stay in place. The transcript shows the Stop and the outcome "stopped". The turn is not retried.
Independent Test: Start a long multi-tool turn, press Stop, measure the time to the stopped outcome, and check that the session is idle and the turn did not run again.
Acceptance Scenarios:
1. Given a running turn on the current orchestration version, When the user presses Stop, Then the turn ends with outcome "stopped" within the latency target, and the session is idle with its timers and schedules kept.
2. Given a running turn with a pending (not yet delivered) steer, When the user presses Stop, Then the turn ends "stopped" and the steer's outcome is "not delivered"; no new turn starts for it (D2).
3. Given a turn that has just finished, When a Stop arrives before the turn's end is recorded, Then the Stop's outcome is "too late" and any steer that would have run next is "not delivered" (D5).
4. Given no running turn (the session is idle, or waiting between retries after a returned error), When the user presses Stop, Then the answer is "nothing to stop" and nothing is recorded.
5. Given a worker that crashes after the Stop is accepted, When the turn is retried on another worker, Then the turn ends "stopped" without running the model again.

### User Story P1 – Steer a running turn

Narrative: While the model works, the user types "use the v2 API" and chooses Steer. The model receives the text at its next model call, after any running tool call ends, and continues with it. The transcript shows the steer as a user message with a steer badge and the outcome "delivered".
Independent Test: Start a multi-tool turn, steer it with a distinctive instruction, and check that the model's next step follows the instruction and the steer's outcome is "delivered".
Acceptance Scenarios:
1. Given a running turn and steering enabled, When the user steers, Then the request is accepted and the model receives the guidance at its next model call within the latency target.
2. Given a running long tool call, When the user steers, Then the guidance is received after the tool call ends, inside the same turn.
3. Given two steers sent quickly, When they are delivered, Then the model receives them in the order they were accepted, each once.
4. Given no running turn, When a client tries to steer, Then the request is refused as "no turn running" and the client sends the text as an ordinary message instead.
5. Given a session whose running turn started on an older orchestration version, When a client tries to steer, Then the request is refused as "legacy turn".

### User Story P2 – A late steer runs with the next turn

Narrative: The user steers just as the model writes its final answer. The steer missed the running turn, so it runs automatically as the next turn, as if the user had sent it as a message at the moment the turn ended. It is shown once, with the outcome "will run next".
Independent Test: Steer after the model's final model call; check that a new turn runs with the steer's text and that the transcript shows the steer once.
Acceptance Scenarios:
1. Given a steer accepted after the model's last model call, When the turn ends, Then the steer's outcome is "carried" ("will run next") and the next turn starts with its text without recording it again.
2. Given a turn that ends by asking the user a question, When a steer was carried, Then the carried steer rides with the user's answer (D3).
3. Given a turn that returns an error and is retried, When a steer was carried, Then the retry includes it; a retry never drops it.
4. Given a turn the session gives up on (retries exhausted or a fatal error), When steers or Stops are still open, Then open steers become "not delivered" and open Stops become "stopped".

### User Story P2 – Every request is visible once and has one outcome

Narrative: Whatever happens, the user can read in the transcript what became of each Stop and each Steer, after a reload and in every client.
Independent Test: Produce each outcome once (delivered, carried, not delivered, stopped, too late), reload the portal and the terminal UI, and check that each request appears once with its outcome.
Acceptance Scenarios:
1. Given any accepted request, When its turn ends, Then exactly one outcome is recorded for it.
2. Given a client that retries a request after a transport failure with the same request id, When the retry arrives, Then the first answer is returned and nothing new is recorded.
3. Given a request id reused for different text or a different kind, When it arrives, Then it is refused.

### User Story P2 – Crash safety

Narrative: A worker can crash at any point of a turn. After recovery, every accepted Stop still holds, every accepted steer that was not stopped reaches the surviving conversation exactly once, and no steer reaches it twice.
Independent Test: Inject a crash at each turn boundary while a Stop or a steer is open, let another worker recover the turn, and check the outcomes and the restored conversation.
Acceptance Scenarios:
1. Given a crash after the turn was marked running, When a Stop arrives meanwhile, Then the retried turn ends "stopped" without a model run.
2. Given a crash after the turn's end-of-turn write but before the conversation was saved, When the turn is retried, Then each open steer reaches the new conversation once and ends "delivered".
3. Given a crash after the conversation was saved but before outcomes were written, When the turn is retried, Then the model does not run again and the outcomes follow the saved conversation.
4. Given a crash after outcomes were written, When the turn is retried, Then nothing new is written and the same result is returned.
5. Given a stale worker that comes back after its turn was given to another worker, When both try to save, Then only one save wins and both record the same outcomes.

### User Story P3 – Safe rollout

Narrative: An operator deploys the new version while sessions are running. Old sessions keep today's Stop; old workers never run a turn whose Stop no longer goes through the orchestration; Steer appears only after the operator enables it.
Independent Test: With a session on the previous orchestration version, press Stop and check it stops through today's path; with the flag off, check that no client offers Steer.
Acceptance Scenarios:
1. Given a session on the previous orchestration version, When the user presses Stop, Then today's Stop path stops it.
2. Given a worker without the turn-control capability, When a new-version turn is scheduled, Then that worker never runs it.
3. Given the steering flag is off, When a turn runs, Then no client offers Steer and the steer API is refused; Stop still uses the new path for new-version turns.

### Edge Cases

- A Stop and a steer arrive together: they apply in acceptance order; after a Stop no later steer is sent.
- Two clients steer at once: both are accepted in a single total order.
- A steer arrives exactly as the turn ends: either it is accepted before the end (and is delivered or carried) or it is refused as "no turn running" (and the client sends it as a message); never both, never neither.
- The live notification is lost: the worker still finds the request within 5 s.
- More than 20 open requests on one turn: the 21st is refused as "too many".
- The text exceeds the ordinary message size limit: refused as for ordinary messages.
- A turn is refused by a budget or workspace gate before it starts: there is no running turn, so requests are refused.
- A Stop during a returned-error retry backoff: "nothing to stop", as today. A Stop during a thrown-error retry backoff: accepted, and the retried turn applies it.
- A delayed start of an older turn after a newer one started: refused.
- A session without a session store: today's crash behaviour; no crash guarantee for steers (D4).
- A CLI that ignores abort: the existing forced settle after 8 s still applies; this case is excluded from the latency target.

## Requirements

### Functional Requirements

- FR-001: A client can request Stop for a session's running turn; the request is recorded durably as a session event in the same transaction that checks the turn is running. (Stories: Stop)
- FR-002: A client can request Steer with text for a session's running turn; the request is recorded durably as a session event in the same transaction that checks the turn is running. (Stories: Steer)
- FR-003: Requests are refused, with a distinct reason, when the session does not exist, no turn is running, the running turn does not accept controls (older orchestration version), 20 requests are already open on the turn, or a request id is reused for a different request. (Stories: Steer, Visible once, Rollout)
- FR-004: A request retried with the same request id returns the first answer and records nothing new. (Stories: Visible once)
- FR-005: The worker running the turn learns of a new request promptly through a notification, and through a periodic look at most 5 s apart while it runs at least one turn. (Stories: Stop, Steer)
- FR-006: An accepted Stop closes the turn to further steering and aborts the model run with today's abort mechanism; the turn ends "stopped", the session goes idle with timers and schedules kept, and the turn is not retried. (Stories: Stop)
- FR-007: An accepted steer is handed to the model run so the model receives it at its next model call, after any running tool call. A steer is sent to a given conversation at most once. (Stories: Steer)
- FR-008: The turn stops sending steers when it settles; a steer already sent but not yet confirmed delays settlement until it is confirmed and answered within the same turn. (Stories: Steer, Late steer)
- FR-009: When a turn ends, every open request gets exactly one outcome according to the outcome table: steers at or below the saved cursor "delivered"; later steers "carried" unless the turn stopped or a Stop is open ("not delivered"); Stops "stopped" when the turn stopped or erred, otherwise "too late". (Stories: Visible once, Late steer, Stop)
- FR-010: Writing outcomes is idempotent: repeating it after any crash writes nothing new and returns the same late steers and stopped flag. (Stories: Crash safety)
- FR-011: The saved conversation records how far it provably got through the turn's steers (the cursor); a retried turn uses the saved cursor or, when nothing of the turn was saved, folds every open steer into its prompt. (Stories: Crash safety)
- FR-012: A retried turn that finds an accepted Stop ends "stopped" without running the model. (Stories: Stop, Crash safety)
- FR-013: Carried steers run with the next turn without being recorded again, including with a user's answer to a question and with an error retry; they survive the orchestration's continue-as-new. (Stories: Late steer)
- FR-014: When the session gives up on a turn, or reaches a terminal state, every open request is closed: steers "not delivered", Stops "stopped". (Stories: Late steer)
- FR-015: A delayed start of an older turn after a newer turn started is refused. (Stories: Crash safety)
- FR-016: New-version turns are routed only to workers that declare the turn-control capability; sessions on older orchestration versions keep today's Stop, which the client selects automatically. (Stories: Rollout)
- FR-017: Steer is offered by clients and accepted by the API only when the `sessions.steering` flag is on; Stop uses the new path for every turn that accepts controls, regardless of the flag. (Stories: Rollout)
- FR-018: The management client, Web API, MCP, CLI, portal and terminal UI expose Steer (flag-gated) and the new Stop result, and render each request once with its outcome; portal and terminal UI stay in parity. (Stories: Steer, Visible once)
- FR-019: A worker stops its notification listener when it stops. (Stories: Cost)

### Key Entities

- Control: a Stop or a Steer, recorded as a session event with its turn, text (the reason for a Stop), request id and actor.
- Control outcome: a session event that closes one control with one of delivered, carried, not delivered, stopped, too late.
- Running turn: the session's turn index currently marked running, plus the highest turn index started on the new path (which also marks a turn that accepts controls).
- Cursor: the position of the last steer the saved conversation provably holds, stored with the saved turn when it is not zero.
- Late steer: a steer accepted for a turn but not delivered in it, returned with the turn's result and carried into the next turn.

### Cross-Cutting / Non-Functional

- All database access goes through stored procedures in one additive migration with its review diff file; no new table and no new index.
- One dedicated database connection per worker for notifications.
- The orchestration change is a new version; the previous version stays registered for in-flight sessions.
- No new metric tables: requests and outcomes are session events, reachable by the existing event read APIs and tuner tools.

## Success Criteria

- SC-001: 95th percentile time from an accepted Stop to the "stopped" outcome is at most 2 s over 30 runs, excluding a CLI that ignores abort. (FR-001, FR-005, FR-006)
- SC-002: 95th percentile time from an accepted steer to the model run's confirmation of it is at most 2 s over 30 runs while the turn is between tool calls. (FR-002, FR-005, FR-007)
- SC-003: In every tested case, each accepted request has exactly one outcome event and appears once in the transcript of every client, before and after a reload. (FR-004, FR-009, FR-010, FR-018)
- SC-004: In the crash matrix (crash after turn start, after the end-of-turn write, after the save, after outcomes; stopped turn before and after outcomes; Stop during thrown-error backoff), every accepted Stop ends "stopped", and every accepted, not-stopped steer reaches the surviving conversation exactly once. (FR-010, FR-011, FR-012, FR-015)
- SC-005: A late steer always runs with the next turn, including after an error retry and with an answer to a question; none is dropped across continue-as-new. (FR-008, FR-013)
- SC-006: A turn with no controls makes the same number of database round trips as today and saves no cursor. (FR-009, R7)
- SC-007: Per worker, one additional database connection, and at most one look query every 5 s while it runs at least one turn; a lost notification delays delivery by at most 5 s. (FR-005, FR-019)
- SC-008: Sessions on the previous orchestration version stop through today's path; a worker without the capability never runs a new-version turn; with the flag off no client offers Steer. (FR-016, FR-017)
- SC-009: The existing replay, multi-worker, chaos and stop suites pass unchanged with the previous orchestration version frozen and the new version current. (FR-016)

## Assumptions

- D1: the Stop latency target is 2 s at the 95th percentile, excluding a CLI that ignores abort.
- D2: steers of a stopped turn are "not delivered" and do not start a new turn.
- D3: late steers of a turn that ended with a question ride with the user's answer.
- D4: sessions without a session store keep today's crash behaviour; no crash guarantee for steers.
- D5: a Stop after the turn finished is "too late" and cancels any carried steers.
- The pinned Copilot SDK/CLI folds an "immediate" send into a running turn and confirms it with the same message id (spike evidence on the Azure AI Foundry OpenAI Responses provider; other providers to be checked during testing).
- The durable runtime cancels an activity whose lock renewal fails, and the Node binding reports it (duroxide-node 0.2.1 on this branch).
- Stock PostgreSQL supports LISTEN for workers; HorizonDB support is checked during testing.
- A development or test database that ran draft PR 142's migrations 0082-0087 is not supported; use a fresh database.

## Scope

In Scope:
- One additive CMS migration (0082), its stored procedures and provider methods.
- Worker notification hub, per-turn live control loop, send gate and settlement, the new turn activity version and its capability routing.
- Orchestration version 1.0.81 (previous version frozen): no Stop race, carried steers, closing controls on give-up and terminal paths.
- Management client, Web API, MCP, CLI, portal and terminal UI support for Steer and the new Stop result; docs, builder templates and examples.
- Unit, procedure, integration, crash, multi-worker, routing and legacy-session tests; latency measurements.

Out of Scope:
- Withdrawing or editing a steer after acceptance.
- Steering a turn that has not started (that is an ordinary queued message).
- Stopping a session waiting between turns, including a returned-error retry backoff.
- Crash guarantees for sessions without a session store.
- A new metric table or new indexes.
- Changes to duroxide.

## Dependencies

- duroxide-node 0.2.1 (duroxide 0.1.32, duroxide-pg 0.1.36), already on the branch.
- Copilot SDK 1.0.13 with CLI 1.0.83 (current pins) and its "immediate" send mode.
- PostgreSQL LISTEN/NOTIFY on the CMS database.
- Feature flag `sessions.steering` (default off).

## Risks & Mitigations

- A stale worker applies a Stop just before it observes cancellation while another worker completed the turn: the Stop reads "stopped" on a completed turn. Impact: a misleading outcome, nothing lost. Mitigation: documented and accepted residual risk (design 3.9).
- A model provider does not honour "immediate" sends: steers would arrive late or as new runs. Mitigation: provider cells in the test plan (design 7.7); carried steers still guarantee delivery.
- Notification connection dies silently: Mitigation: the 5 s look while a turn runs.
- Migration number collision with draft PR 142 databases: Mitigation: documented; use fresh development databases.
- Three parallel workstreams editing shared files: Mitigation: a contract phase (A1) lands first and the plan assigns every shared file to one owner.

## References

- Design: docs/proposals/session-turn-control.md (revision 5); design PR https://github.com/microsoft/PilotSwarm/pull/169
- Superseded: draft PRs 141 (spec) and 142 (implementation)
- Research: .paw/work/turn-control/CodeResearch.md
