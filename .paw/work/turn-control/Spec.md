# Feature Specification: Session Turn Control (Stop and Steer)

**Branch**: waldemort/turn-control (umbrella), workstream branches below it  |  **Created**: 2026-10-13  |  **Revised**: 2026-10-13 (r8, owner plan approval: amendment S1, workspace-lease guards, deltas approved)  |  **Status**: Draft
**Input Brief**: Let a user stop a running agent turn within about a second, or steer it with guidance the model receives inside the same turn, without losing, doubling or hiding any request across crashes.

Design source (binding): `docs/proposals/session-turn-control.md`, revision 5 (design PR 169). Requirements R1-R7 and decisions D1-D5 are taken at the design's proposed defaults, as approved by the owner for this build. Where this specification and the design differ, the design wins and this specification is corrected, except for the design deltas below; the parent records them in design revision 6.

Design deltas (all owner-approved on 2026-10-13: D6 directly, the rest with the plan) (the plan's decision IDs in brackets):
- D6 (owner): a carried steer whose consuming turn ends "stopped" is not run again (US-3.5).
- Carried steers leave the orchestration only when a turn actually used them, not merely when it passed its gates, because a provider-admission error is returned before the gates; they follow the prompt they were folded into, so a returned-error retry folds them again [P12].
- Each carried steer gets at most one closing record (ran, stopped, gave up, terminal), written inside writes that already happen: the consuming turn's end for ran and stopped, the session-state write for gave up and terminal, and a revive for the old lifetime; clients use it for the label [P17].
- The highest started turn, and the control events that turn start and turn end read, are scoped to one orchestration lifetime, because a restarted or revived session counts turns from zero again; this adds a second session column, a lifetime base position [P19].
- Any terminal session state closes open controls, whoever writes it [P20].
- Turn control does not change workspace attach or release; every result of a turn that attached the workspace reports it, including a Stop applied before the model ran [A4].
- The model run accepts controls only after its initial prompt is sent; earlier controls wait; registering a running turn triggers one look [P21].
- New-version Stop shows one transcript item, the Stop line, without the old "Turn stopped by user." message [P22].
- Steer confirmation is recorded as a session event outside the transcript [P13].
- The steering flag cannot be enabled by a user override unless the operator allows overrides.
- The open-controls read also returns each control's creation time (for latency evidence) [A2].

## Overview

An agent turn can run for minutes: the model calls tools, reads results and calls the model again. Today a user who sees the turn go wrong can only press Stop, and Stop takes about six seconds because the request travels through the session's orchestration and a second worker operation. A user who only wants to correct course ("use the v2 API", "skip the tests for now") has no way to do it: any message sent during a turn waits until the turn ends, and the work the model is doing continues in the wrong direction.

This feature gives every running turn a control channel. A user can **Stop** the turn and see it stopped in about a second. Or the user can **Steer** it: add guidance that the model receives at its next model call, inside the same turn, while keeping the work already done. Guidance that arrives too late for the running turn is not lost; it runs automatically with the next turn.

Both requests are part of the session's history. Each Stop and each Steer appears once in the conversation and ends with exactly one visible outcome: delivered, will run next, not delivered, stopped, or too late. For sessions with a session store, a worker crash, a retried turn or a duplicated client request never loses an accepted Stop that arrived in time, never drops an accepted steer that was not stopped, and never gives the model the same steer twice. Sessions without a session store keep today's crash behaviour.

The feature must stay simple and cheap. A turn that nobody stops or steers makes the same turn-path database calls as today. Sessions that started on the previous orchestration version keep today's Stop. Steering is offered only when an operator enables it.

## Objectives

- Stop a running turn quickly and reliably, including across worker crashes. (Rationale: a wrong turn wastes time and tokens.)
- Let a user add guidance to a running turn that the model receives inside that turn. (Rationale: correcting course is often better than stopping.)
- Never lose a late steer; run it with the next turn.
- Show each request once, with one final outcome, in every client (portal, terminal UI, management API, MCP, CLI).
- Keep the cost of a turn without controls unchanged, and keep the mechanism small enough to reason about.
- Roll out, and roll back, without stranding sessions that run on older or newer orchestration versions.

## User Scenarios & Testing

Story identifiers: US-1 to US-7. Priority is shown after the identifier.

### US-1 (P1) – Stop a running turn

Narrative: A user watches a turn go wrong and presses Stop. The turn ends within about a second, the session becomes idle, and its timers and schedules stay in place. The transcript shows the Stop and the outcome "stopped". The turn is not retried.
Independent Test: Start a long multi-tool turn, press Stop, measure the time to the stopped outcome, and check that the session is idle and the turn did not run again.
Acceptance Scenarios:
1. Given a running turn on the current orchestration version, When the user presses Stop, Then the turn ends with outcome "stopped" within the latency target, and the session is idle with its timers and schedules kept.
2. Given a running turn with a pending (not yet delivered) steer, When the user presses Stop, Then the turn ends "stopped" and the steer's outcome is "not delivered"; no new turn starts for it (D2).
3. Given a running turn in which a steer was already delivered to the model, When the user then presses Stop, Then the turn ends "stopped" and that steer's outcome is also "not delivered", because the stopped turn's conversation is discarded (D2, design 5.2).
4. Given a turn that returns an error while a Stop is open, When the turn ends, Then the result is "stopped", the Stop's outcome is "stopped", and the turn is not retried automatically.
5. Given a turn that has finished its model run, When a Stop is accepted before the turn's end is recorded, Then the Stop's outcome is "too late" and any steer that would have run next is "not delivered" (D5).
6. Given no running turn (the session is idle, or waiting between retries after a returned error), When the user presses Stop, Then the answer is "nothing to stop" and nothing is recorded.

### US-2 (P1) – Steer a running turn

Narrative: While the model works, the user types "use the v2 API" and chooses Steer. The model receives the text at its next model call, after any running tool call ends, and continues with it. The transcript shows the steer as a user message with a steer badge and the outcome "delivered".
Independent Test: Start a multi-tool turn, steer it with a distinctive instruction, and check that the model's next step follows the instruction and the steer's outcome is "delivered".
Acceptance Scenarios:
1. Given a running turn and steering enabled, When the user steers, Then the request is accepted and the model receives the guidance at its next model call within the latency target.
2. Given a running long tool call, When the user steers, Then the guidance is received after the tool call ends, inside the same turn.
3. Given two steers sent quickly, When they are delivered, Then the model receives them in the order they were accepted, each once.
4. Given a steer whose confirmation from the model run arrives before the send call itself completes, When the turn ends, Then the steer counts as delivered.
5. Given a steer that was sent but not yet confirmed when the model run reaches its final idle, When the turn settles, Then settlement waits for the confirmation and the following idle (bounded by the existing turn timeout), and the steer is answered inside the same turn; no steer starts a separate run after settlement or after an abort.
6. Given a steer whose send to the model run fails, When the turn ends, Then the turn fails and is retried from the saved conversation with the steer still open; the steer is neither lost nor reported "delivered" by the failed attempt.
7. Given no running turn, When a client tries to steer, Then the request is refused as "no turn running" and the client sends the text as an ordinary message with a new message id, never retrying the refused control request.
8. Given a session whose running turn started on an older orchestration version, When a client tries to steer, Then the request is refused as "legacy turn".
9. Given a caller with only read access to the session, When it tries to steer, Then the request is refused by the same access check as sending a message, and no control is recorded or delivered.

### US-3 (P2) – A late steer runs with the next turn

Narrative: The user steers just as the model run finishes. A steer sent while the model still writes its final answer is answered in the same turn (US-2). A steer accepted after the model run has finished, but before the turn has ended, missed the running turn, so it runs automatically as the next turn, as if the user had sent it as a message at the moment the turn ended. It is shown once, with the outcome "will run next".
Independent Test: Steer after the model run has finished and before the turn ends (a deterministic test hold); check that a new turn runs with the steer's text and that the transcript shows the steer once.
Acceptance Scenarios:
1. Given a steer accepted after the model run's final idle and before the turn's end-of-turn write, When the turn ends, Then the steer's outcome is "carried" ("will run next") and the next turn starts with its text without recording it again.
2. Given a turn that ends by asking the user a question, When a steer was carried, Then the carried steer rides with the user's answer (D3).
3. Given a turn that returns an error (no Stop open) and is retried, When a steer was carried, Then the retry includes it; a retry never drops it.
4. Given a turn the session gives up on (retries exhausted or a fatal error) or a session that reaches a terminal state, When steers or Stops are still open, Then open steers become "not delivered" and open Stops become "stopped"; a steer that was carried but not yet run is not run and every client shows it as "Carried, not run".
5. Given a carried steer, When the turn that consumes it (the first later turn that reaches the model run with it, or that takes it and then ends "stopped"; not necessarily the next turn index) ends "stopped" (a Stop at its start or during it), Then the steer is not run again; its outcome stays "carried" and every client shows it as "Carried, then stopped", before and after a reload (D6).

### US-4 (P2) – Every request is visible once and has one outcome

Narrative: Whatever happens, the user can read in the transcript what became of each Stop and each Steer, after a reload and in every client.
Independent Test: Produce each outcome once (delivered, carried, not delivered, stopped, too late), reload the portal and the terminal UI, and check that each request appears once with its outcome.
Acceptance Scenarios:
1. Given any accepted request, When its turn ends, Then exactly one outcome is recorded for it.
2. Given an accepted request that a client retries with the same request id after a transport failure, When the retry arrives (also after the turn has ended), Then the first answer is returned and nothing new is recorded.
3. Given an accepted request, When a request with the same id but a different kind or text arrives, Then it is refused.
4. Given a request refused as "no turn running" and sent as an ordinary message instead, When a new turn starts later, Then the text reaches the model once, as the ordinary message; the refused control request is not retried.

### US-5 (P2) – Crash safety (sessions with a session store)

Narrative: A worker can crash at any point of a turn. After recovery, each accepted request ends with the outcome that matches what survived, every accepted steer that was not stopped reaches the surviving conversation exactly once, and no steer reaches it twice.
Independent Test: Inject a crash at each turn boundary while a Stop or a steer is open, let another worker recover the turn, and check the outcomes and the restored conversation against the expected outcome of each case.
Acceptance Scenarios:
1. Given a crash after the turn was marked running and before anything of the turn was saved, When a Stop arrives meanwhile, Then the retried turn ends "stopped" without a model run.
2. Given a crash after the turn's end-of-turn write but before the conversation was saved, When the turn is retried, Then each open steer reaches the new conversation once and ends "delivered".
3. Given a crash after the conversation was saved but before outcomes were written, When the turn is retried, Then the model does not run again, the saved result is reused, and outcomes follow the saved conversation by the FR-009 table: steers it holds are "delivered"; a Stop accepted after the model run is "too late"; later steers are "carried" when no Stop is open, and "not delivered" when such a late Stop is open (D5).
4. Given a crash after outcomes were written, When the turn is retried, Then nothing new is written and the same result is returned.
5. Given a stopped turn, When the worker crashes before or after its outcomes are written, Then the retried turn ends "stopped" again.
6. Given a thrown error while the turn waits for its retry, When a Stop is accepted during that backoff, Then the retried turn ends "stopped" without a model run; if retries run out first, the Stop ends "stopped" by the give-up close.
7. Given a stale worker that comes back after its turn was given to another worker, When both reach the save, Then only one save wins, the stale delivery is cancelled, and both record the same outcomes from the winner's result (the documented residual risk of design 3.9 stays accepted).
8. Given a session without a session store, When a worker crashes during a turn, Then the turn re-runs from nothing as today, with no crash guarantee for its steers (D4).

### US-6 (P3) – Safe rollout and rollback

Narrative: An operator deploys the new version while sessions are running. Old sessions keep today's Stop; old workers never run a turn whose Stop no longer goes through the orchestration; Steer appears only after the operator enables it. A rollback never strands sessions that already run on the new orchestration version.
Independent Test: With a session on the previous orchestration version, press Stop and check it stops through today's path; with the flag off, check that no client offers Steer; with a worker lacking the capability, check it never runs a new-version turn.
Acceptance Scenarios:
1. Given a session on the previous orchestration version, When the user presses Stop, Then today's Stop path stops it.
2. Given a worker without the turn-control capability, When a new-version turn is scheduled, Then that worker never runs it.
3. Given the steering flag is off, When a turn runs, Then no client offers Steer and the steer API is refused; Stop still uses the new path for new-version turns.
4. Given the migration applied and old workers still running, When they run turns of old-version sessions, Then they keep working unchanged.
5. Given a rollback, When sessions already run on the new orchestration version, Then workers able to run that version stay deployed until those sessions drain, unless a separately authorized, coordinated database-and-code rollback is chosen; turning the flag off is not an orchestration rollback.

### US-7 (P3) – Low, bounded cost

Narrative: An operator runs many sessions. Turns that nobody controls cost what they cost today; each worker adds one listening connection and a cheap periodic look only while it runs turns; a worker that stops releases its connection.
Independent Test: Count turn-path CMS calls for a turn without controls before and after the change; count database connections and periodic look queries per worker while idle and while busy; stop a worker and check its listener is closed.
Acceptance Scenarios:
1. Given a turn without controls, When it runs, Then it makes the same turn-path CMS calls as today (turn start replaces today's "set running turn" call; no turn-end call) and saves no cursor.
2. Given a worker with no running turns, When time passes, Then it makes no periodic look queries.
3. Given a worker with running turns, When no notification arrives, Then it makes one batched periodic look every 5 s for all of them; notifications trigger additional immediate looks.
4. Given a worker that stops, When it shuts down, Then its listening connection is closed.

### Edge Cases

- A Stop and a steer arrive together: they apply in acceptance order; after a Stop no later steer is sent.
- Two clients steer at once: both are accepted in a single total order.
- A request arrives exactly as the turn ends: it is either accepted before the end-of-turn write (and gets an outcome from turn end) or refused as "no turn running"; never both, never neither.
- The live notification is lost: the worker still finds the request within 5 s.
- More than 20 open requests on one turn: the 21st is refused as "too many".
- The text exceeds the ordinary message size limit: refused as for ordinary messages.
- A turn is refused by a budget or workspace gate before it starts: there is no running turn, so requests are refused.
- A Stop during a returned-error retry backoff: "nothing to stop", as today. A Stop during a thrown-error retry backoff: accepted, and the retried turn applies it.
- A delayed start of an older turn after a newer one started: refused.
- A CLI that ignores abort: the existing forced settle after 8 s still applies; this case is excluded from the latency target.

## Requirements

### Functional Requirements

- FR-001: A client can request Stop for a session's running turn; the request is recorded durably as a session event in the same transaction that checks the turn is running. (US-1)
- FR-002: A client can request Steer with text for a session's running turn; the request is recorded durably as a session event in the same transaction that checks the turn is running. (US-2)
- FR-003: Requests are refused, with a distinct reason, when the session does not exist, no turn is running, the running turn does not accept controls (older orchestration version), 20 requests are already open on the turn, or a request id that already names a recorded control is reused for a different kind or text. (US-2, US-4, US-6)
- FR-004: A request whose id already names a recorded control returns that control's first answer and records nothing new, at any later time. Refusals are not recorded and are not deduplicated. Clients retry a control request with the same id only after a transport failure; after a definite "no turn running" refusal, the client sends the text as an ordinary message with a new id and never retries the refused control id. (US-2, US-4)
- FR-005: The worker running the turn learns of a new request promptly through a notification, and through a periodic batched look every 5 s while it runs at least one turn. (US-1, US-2, US-7)
- FR-006: An accepted Stop closes the turn to further steering and aborts the model run with today's abort mechanism; the turn ends "stopped", the session goes idle with timers and schedules kept, and the turn is not retried. (US-1)
- FR-007: An accepted steer is handed to the model run so the model receives it at its next model call, after any running tool call. A steer is sent to a given conversation at most once. A confirmation that arrives before the send call completes is recognised. (US-2)
- FR-008: The turn stops sending steers when the model run reaches its final idle or a Stop is applied; a steer already sent but not yet confirmed delays settlement until it is confirmed and answered within the same turn, bounded by the existing turn timeout. A failed steer send fails the turn; recovery follows FR-011. (US-2, US-3)
- FR-009: When a turn ends, every open request gets exactly one outcome by this table, in which a stopped turn takes precedence over the cursor (design 5.2):

  | Request | Turn stopped | Turn returned an error | Turn finished otherwise |
  |---|---|---|---|
  | Steer at or below the cursor | not delivered | delivered | delivered |
  | Steer after the cursor, no Stop open | not delivered | carried (into the retry) | carried (into the next turn) |
  | Steer after the cursor, a Stop open | not delivered | not delivered | not delivered |
  | Stop | stopped | stopped | too late |

  When a Stop ends "stopped" on a turn that returned an error, the turn's result becomes "stopped" and it is not retried automatically. (US-1, US-3, US-4)
- FR-010: Writing outcomes is idempotent: repeating it after any crash writes nothing new and returns the same late steers and stopped flag. (US-5)
- FR-011: The saved conversation records how far it provably got through the turn's steers (the cursor). A retried turn whose result was already saved reuses that result and cursor without running the model and applies FR-009. A retried turn with nothing of it saved applies an open Stop without running the model (FR-012), or else folds every open steer into its prompt. A stopped, superseded or lost conversation counts as cursor 0. (US-5)
- FR-012: A retried turn that has nothing saved and finds an open Stop, or a "stopped" outcome already recorded for the turn, ends "stopped" without running the model. (US-1, US-5)
- FR-013: Carried steers run with the next turn without being recorded again, including with a user's answer to a question and with an error retry; they survive the orchestration's continue-as-new. When they are the only pending work, their text is the next turn's prompt. They stay pending through gate waits and errors returned before the model runs. When the turn that carries them ends "stopped", they are not run again and clients show them as "Carried, then stopped" (D6); when the session gives up or ends first, clients show "Carried, not run"; after they ran, clients show "Carried, ran next". (US-3)
- FR-014: When the session gives up on a turn, or reaches a terminal state, every open request is closed: steers "not delivered", Stops "stopped". (US-3, US-5)
- FR-015: A delayed start of an older turn after a newer turn started is refused, within one orchestration lifetime; a restarted session starts a new lifetime. (US-5)
- FR-016: New-version turns are routed only to workers that declare the turn-control capability; sessions on older orchestration versions keep today's Stop, which the client selects automatically. (US-6)
- FR-017: Steer is offered by clients and accepted by the API only when the `sessions.steering` flag is on for the calling user; the operator turns it on and decides whether users may override it; Stop uses the new path for every turn that accepts controls, regardless of the flag. (US-6)
- FR-018: Steer requires the same write access as sending a message; Stop keeps today's access rule. A refused caller causes no control event and no delivery. (US-2)
- FR-019: Steer and the new Stop result are operations of the management client in both direct and Web API modes; the Web API, MCP, CLI, portal and terminal UI use that operation, never a side path. Each client renders each request once with its outcome; portal and terminal UI stay in parity. (US-2, US-4)
- FR-020: Rollout is additive and rollback-safe: the migration keeps older workers working; capable workers and the portal/Web API roll out together; a rollback keeps workers able to run the new orchestration version until its sessions drain unless a separately authorized coordinated database-and-code rollback is chosen. Nothing in this feature authorizes a database reset. (US-6)
- FR-021: A turn without controls makes the same turn-path CMS calls as today and saves no cursor. (US-7)
- FR-022: Each worker holds at most one additional database connection for notifications, makes no periodic look while it runs no turn, makes one batched periodic look every 5 s while it runs any, and closes the connection when it stops. Notification-triggered looks are additional and immediate. (US-7)

### Key Entities

- Control: a Stop or a Steer, recorded as a session event with its turn, text (the reason for a Stop), request id and actor.
- Control outcome: a session event that closes one control with one of delivered, carried, not delivered, stopped, too late.
- Running turn: the session's turn index currently marked running, plus the highest turn index started on the new path (which also marks a turn that accepts controls).
- Cursor: the position of the last steer the saved conversation provably holds, stored with the saved turn when it is not zero.
- Late steer: a steer accepted for a turn but not delivered in it, returned with the turn's result and carried into the next turn.

### Cross-Cutting / Non-Functional

- All database access goes through stored procedures in one additive migration with its review diff file; no new table and no new index.
- The orchestration change is a new version; the previous version stays registered for in-flight sessions.
- No new metric tables: requests and outcomes are session events, reachable by the existing event read APIs and tuner tools.

## Success Criteria

- SC-001: 95th percentile time from an accepted Stop to the "stopped" outcome is at most 2 s over 30 runs with a real model, excluding a CLI that ignores abort. (FR-001, FR-005, FR-006)
- SC-002: 95th percentile time from an accepted steer to the model run's confirmation of it is at most 2 s over 30 runs while the turn is between tool calls. (FR-002, FR-005, FR-007)
- SC-003: Every cell of the FR-009 table is produced by at least one test and yields exactly one outcome event per request; each request appears once in the transcript of every client, before and after a reload. (FR-004, FR-009, FR-010, FR-019)
- SC-004: In the crash matrix of US-5 (crash after turn start, after the end-of-turn write, after the save, after outcomes; stopped turn before and after outcomes; Stop during a thrown-error backoff; stale worker), each case ends with its expected outcome as stated in US-5, and, for sessions with a session store, every accepted, not-stopped steer reaches the surviving conversation exactly once. Sessions without a store are checked only for today's re-run behaviour (D4). (FR-010, FR-011, FR-012, FR-015)
- SC-005: Each late steer runs once, in the first later turn that consumes it, including after an error retry (the retry folds it again, as it re-sends its prompt) and with an answer to a question; none is dropped across continue-as-new or before the model runs. It is not run only when its consuming turn ends stopped (D6) or the session gives up or ends, and then every client shows which, before and after a reload. (FR-008, FR-013)
- SC-006: A turn without controls makes the same number of turn-path CMS calls as today and its saved result has no cursor field. (FR-021)
- SC-007: Per worker: one additional database connection; zero periodic looks while idle; one batched periodic look every 5 s while busy; a lost notification delays delivery by at most 5 s; the connection is closed after worker stop. (FR-005, FR-022)
- SC-008: Sessions on the previous orchestration version stop through today's path; a worker without the capability never runs a new-version turn; with the flag off no client offers Steer and the API refuses it; a read-only caller cannot steer. (FR-016, FR-017, FR-018)
- SC-009: The existing replay, multi-worker, chaos and stop suites pass with the previous orchestration version frozen and the new version current. (FR-016, FR-020)
- SC-010: The evidence matrix below is complete: each row has a measured result or is listed explicitly as not covered, with the reason (for example missing credentials). No untested provider is declared compatible and no new performance threshold is invented. (FR-005, FR-007, FR-020, FR-022)

### Acceptance evidence matrix (design section 7)

| Design | Evidence | Stories / FRs |
|---|---|---|
| 7.1 | Procedure tests on real PostgreSQL, including both orders of a request versus the end-of-turn write on two connections, refusals, retries, FR-009 cells, give-up close, call counts | US-4, US-7; FR-003, FR-004, FR-009, FR-010, FR-014, FR-021 |
| 7.2 | Unit tests with a fake model session: gate at idle, unconfirmed steer delays settlement, early confirmation, Stop closes gate before abort, send failure fails the turn, duplicate and ordered controls | US-2; FR-007, FR-008 |
| 7.3 | Integration tests with the real CLI and default model: delivered between tools and after a long tool, carried, stopped, stopped with pending steer, too late, no-controls turn, lost notification, worker stop | US-1, US-2, US-3, US-7 |
| 7.4 | Fault-injection crash matrix of US-5 | US-5; SC-004 |
| 7.5 | Stale worker cancelled with winner-result adoption; replay with the previous version frozen; capability routing; legacy-session Stop | US-5, US-6; FR-015, FR-016 |
| 7.6 | Browser and terminal UI flows with a real model; outcome labels before and after reload, including the window outcomes (carried, too late, carried then stopped) driven by a session-scoped test hold on a local instance of the exact candidate; 30-run Stop and Steer latency; keybinding and help parity | US-1, US-2, US-4; SC-001, SC-002, SC-003 |
| 7.7 | Provider cells (immediate send during tools, during a long tool, at the final message, after idle, abort then send) on Azure AI Foundry OpenAI Responses, GitHub Copilot and Anthropic; missing credentials recorded | US-2; FR-007 |
| 7.8 | Look query time and database CPU at 1, 10 and 50 running turns per worker; connection-budget fit against the deployment's `max_connections`; listener on stock PostgreSQL and on HorizonDB | US-7; FR-022 |
| 4.12 | Stop and Steer walked by hand in the local instance (`scripts/local-pilotswarm.sh`) against its local PostgreSQL | US-1, US-2 |

## Assumptions

- D1: the Stop latency target is 2 s at the 95th percentile, excluding a CLI that ignores abort.
- D2: steers of a stopped turn are "not delivered" and do not start a new turn.
- D3: late steers of a turn that ended with a question ride with the user's answer.
- D4: sessions without a session store keep today's crash behaviour; no crash guarantee for steers.
- D5: a Stop after the turn finished is "too late" and cancels any carried steers.
- D6 (decided by the owner on 2026-10-13, option A): a carried steer whose consuming turn ends "stopped" is not run again; its outcome stays "carried" and clients show "Carried, then stopped".
- The pinned Copilot SDK/CLI folds an "immediate" send into a running turn and confirms it with the same message id (spike evidence on the Azure AI Foundry OpenAI Responses provider; other providers are checked per the evidence matrix).
- The durable runtime cancels an activity whose lock renewal fails, and the Node binding reports it (duroxide-node 0.2.1 on this branch).
- Stock PostgreSQL supports LISTEN for workers; HorizonDB support is checked per the evidence matrix.
- A development or test database that ran draft PR 142's migrations 0082-0087 is not supported; use a fresh database.

## Scope

In Scope:
- One additive CMS migration (0082), its stored procedures and provider methods.
- Worker notification hub, per-turn live control loop, send gate and settlement, the new turn activity version and its capability routing.
- Orchestration version 1.0.81 (previous version frozen): no Stop race, carried steers, closing controls on give-up and terminal paths.
- Management client, Web API, MCP, CLI, portal and terminal UI support for Steer and the new Stop result; docs, builder templates and examples.
- The tests and measurements of the evidence matrix.

Out of Scope:
- A separate CLI subcommand for Stop or Steer: the CLI is the terminal UI, which gets both through key bindings.
- Withdrawing or editing a steer after acceptance.
- Steering a turn that has not started (that is an ordinary queued message).
- Stopping a session waiting between turns, including a returned-error retry backoff.
- Crash guarantees for sessions without a session store.
- A new metric table or new indexes.
- Changes to duroxide.
- Any database reset as part of rollout or rollback.

## Dependencies

- duroxide-node 0.2.1 (duroxide 0.1.32, duroxide-pg 0.1.36), already on the branch.
- Copilot SDK 1.0.13 with CLI 1.0.83 (current pins) and its "immediate" send mode.
- PostgreSQL LISTEN/NOTIFY on the CMS database.
- Feature flag `sessions.steering` (default off, user override off by default).
- The existing session write-access policy (`session:write`) for Steer.

## Risks & Mitigations

- A stale worker applies a Stop just before it observes cancellation while another worker completed the turn: the Stop reads "stopped" on a completed turn. Impact: a misleading outcome, nothing lost. Mitigation: documented and accepted residual risk (design 3.9).
- A model provider does not honour "immediate" sends: steers would arrive late or as new runs. Mitigation: provider cells in the evidence matrix; carried steers still guarantee delivery.
- Notification connection dies silently: Mitigation: the 5 s periodic look while a turn runs.
- Rollback removes every worker able to run the new orchestration version: its sessions strand. Mitigation: FR-020 rollback rule.
- Migration number collision with draft PR 142 databases: Mitigation: documented; use fresh development databases.
- Three parallel workstreams editing shared files: Mitigation: a contract phase (A1) lands first and the plan assigns every shared file to one owner.

## References

- Design: docs/proposals/session-turn-control.md (revision 5); design PR https://github.com/microsoft/PilotSwarm/pull/169
- Superseded: draft PRs 141 (spec) and 142 (implementation)
- Research: .paw/work/turn-control/CodeResearch.md
- Spec review: .paw/work/turn-control/reviews/spec-review.md
