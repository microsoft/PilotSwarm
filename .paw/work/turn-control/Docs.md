# Session turn control: workstream A (runtime)

## Overview

Session turn control lets a user act on a session's **running** turn without
ending the session:

- **Stop** ends the running turn. The session stays open and idle; its
  timers and cron schedule are kept.
- **Steer** adds guidance to the running turn. The model receives it at its
  next model call, without waiting for the turn to finish.

Both are recorded in the session catalog (CMS) as ordinary session events.
Each request gets exactly one outcome when the turn ends, also after a worker
crash, a worker loss or a stale worker coming back.

Workstream A builds the runtime half: the public contract, the CMS migration
and procedures, the worker's notification hub and per-turn live loop, the
send gate in `ManagedSession`, and the `runTurnV4` activity path. Workstream B
(orchestration 1.0.81) schedules `runTurnV4` and carries late steers to the
next turn. Workstream C (management client, Web API, MCP, TUI and portal)
exposes Stop and Steer to users. Their documentation is in the
[orchestration design](../../../docs/architecture/orchestration/design.md) (B)
and [`.paw/work/turn-control-c/Docs.md`](../turn-control-c/Docs.md) (C).

Binding design: [`docs/proposals/session-turn-control.md`](../../../docs/proposals/session-turn-control.md).

## Architecture and Design

### High-level architecture

```
client / API ──turnControlAdd──▶ CMS: user.steer / user.stop event + pg_notify
                                         │
             worker TurnControlHub ◀─────┘ LISTEN pilotswarm_turn_control
                     │  (plus a batched look every 5 s while a turn runs)
                     ▼
             LiveTurnControl (one per running turn)
                     │  ordered queue, drained only while the send gate is open
                     ▼
             ManagedSession send gate ──send({ mode: "immediate" })──▶ Copilot CLI
                     │                    confirmation: user.message with the same messageId
                     ▼
             runTurnV4: T3 turn start … T6 writeback … T7 save … T8 turn end
                                                                 │
                                         session.control_outcome per control
```

The CMS is the only source of truth. A notification is a hint that makes
delivery fast; the positional read (`turnLook` after the turn's cursor)
decides what is new.

### The turn path (`runTurnV4`)

`runTurnV4` and `runTurnEpochV4` run the same handler as `runTurnV3` with
turn control on. The order of the turn-control steps:

1. **Gates as today.** The budget gate, provider admission and the workspace
   gate run first. A turn they refuse never reaches turn start and consumes
   no carried steer.
2. **Prompt record.** The prompt and the turn's system message are recorded
   before T3. A normal activity retry skips them; on a worker-loss retry with
   `retryCount` 0, V4 uses `turn_high` to skip them if T3 already ran (see
   "Worker loss and the prompt record").
3. **T3 turn start** (`cms_turn_start`, replaces `setActiveTurnIndex`). It
   marks the turn running and returns its open controls and whether a
   stopped outcome is already recorded. A failure throws, so the turn retries
   (plan P21). A start of an older turn after a newer one is refused as
   stale, within one orchestration lifetime (FR-015).
4. **Early Stop.** An open Stop, or a recorded stopped outcome, ends the turn
   `stopped` without a model run.
5. **Fold.** Carried steers from the previous turn go in front of the prompt
   (or replace the internal carried-steers wake prompt); open steers go after
   it. Folded text is not recorded again.
6. **Live loop.** A `LiveTurnControl` is registered with the hub for the
   model run; registering triggers one look for it.
7. **T6 writeback** (`cms_complete_turn_writeback`, now returning whether
   controls are open). The result is three-valued (P15): `true`, `false`, or
   `undefined` when the best-effort write failed. Only `false` skips T8.
8. **T7 save.** The turn commit file saves `controlCursor` only when the
   cursor is not 0. When a racing attempt already saved the turn, this
   attempt adopts the winner's result and cursor. An unpublished save
   (stopped or superseded) counts as cursor 0.
9. **T8 turn end** (`cms_turn_end`). It gives every open control of the turn
   one outcome, closes the carried steers folded into this turn (`ran` or
   `stopped`, never on `error`), and returns whether the turn is stopped and
   which steers were carried (late steers). It is retried in place on a
   database error and then fails the activity.

Every V4 result sets `workspaceAttached: true` whenever this attempt
attached the workspace: a Stop applied at turn start, a carried-steer-only
turn and an end-of-turn stopped result included. The orchestration uses it to
clear delivered workspace notes. Turn control does not change workspace
attach (the runTurn gates) or release (`releaseAffinity`, worker eviction,
shutdown).

### Outcome table (FR-009)

`cms_turn_end` decides each open control's outcome from the result kind and
the cursor (the last steer the model run confirmed):

| Control | Turn result | Outcome |
|---|---|---|
| Stop | `stopped` or `error` | `stopped` |
| Stop | anything else | `too_late` |
| Steer | `stopped` | `not_delivered` |
| Steer | seq ≤ cursor | `delivered` |
| Steer | a Stop is open | `not_delivered` |
| Steer | otherwise | `carried` (runs in the next turn) |

`cms_update_session` closes what is left when the session gives up
(`closeControls` → Stop `stopped`, Steer `not_delivered`, carried steers
`gave_up`) or reaches `completed`, `failed` or `cancelled` (carried steers
`terminal`).

### Design decisions

| Decision | Why |
|---|---|
| Controls are session events, not a new table. | One durable, ordered record that every client already pages through. |
| The procedure takes the session row lock. | Orders an add against the end-of-turn write; both orders are tested on two connections. |
| The request id deduplicates retries, within the orchestration lifetime. | A lost response can be retried safely. A revived session starts a new lifetime (`turn_base_seq`), so an old request id is not answered from it. |
| The Steer flag is checked inside `cms_turn_control_add`, after the retry lookup, under the lock. | A lost-response retry gets its first answer even after the flag was turned off; a new Steer is refused with `steering_disabled`; a Stop ignores the flag. |
| A steer counts as delivered only after the model run confirms it. | `send()` resolving means the CLI took the message; its `user.message` event with the same `messageId` means it is in the conversation. Only confirmed steers move the saved cursor. |
| The send gate opens only after the initial prompt is sent. | Controls that arrive between turn start and that send are held in order; a held Stop prevents the initial send (P21). |
| A Stop closes the gate before the abort. | No steer may be sent after an abort (spike cell C5b). |
| One notification connection per worker, plus a 5 s look while a turn runs. | Low latency without per-turn connections; a lost notification delays delivery by at most 5 s. |
| The confirmation is recorded as `session.steer_confirmed` (best effort, not a transcript item). | Latency evidence and operator diagnosis (P13). |
| Carried steers leave orchestration state only on proof of consumption (`carriedSteersConsumed`). | A gate wait or a pre-model error must not lose them (P12). |
| A carried steer whose consuming turn is stopped is not run again. | Owner decision D6 option A; clients show "Carried, then stopped". |

### Integration points

- **Contract** (`turn-control-contract.ts`, `types.ts`, `activity-routing.ts`):
  event names, channel, limits, the V4 activity names and the
  `pilotswarm.turn-control.v1` worker tag. A worker without the tag never
  runs a V4 turn.
- **Catalog** (`SessionCatalog` in `cms.ts`): `turnControlAdd`, `turnStart`,
  `turnLook`, `turnEnd`, `completeTurnWriteback` (boolean), and the optional
  `createTurnControlListener()` that supplies the hub's connection from the
  catalog provider's own connection settings. A catalog without migration
  0082 raises `TurnControlUnavailableError`; the management client then
  takes the legacy Stop path.
- **Worker** (`worker.ts`): starts the hub after the catalog and stops it
  after the runtime has drained its activities, so a Stop that arrives during
  a graceful drain still reaches running turns.
- **Session manager** (`session-manager.ts`): carries the hub to the
  activity; the lock-bypassing abort primitive is unchanged.

## User Guide

### Prerequisites

- Migration 0082 applied (automatic on worker start).
- Orchestration 1.0.81 or later for the session. Sessions on 1.0.80 and older
  keep today's Stop; the client selects it automatically (`legacy_turn`).
- For Steer: the `sessions.steering` feature flag, off by default and without
  user override. The operator turns it on at cluster scope and may then allow
  user overrides. Stop is never gated.

### Basic usage

Through the management client (direct or Web API mode):

```js
await mgmt.steerSessionTurn(sessionId, { text: "Use the v2 API.", requestId });
await mgmt.stopSessionTurn(sessionId, { reason: "Stopped by user", requestId });
```

`steerSessionTurn` answers `accepted` with the control's seq and turn, or a
refusal (`no_turn`, `legacy_turn`, `not_found`, `too_many`,
`request_id_reused`, `steering_disabled`). After `no_turn` or `legacy_turn`,
send the text as an ordinary message with a new client message id.
`stopSessionTurn` waits for the outcome (`stopped` or `too_late`).

### Advanced usage

- **Retries.** Retry with the same `requestId` only after a transport
  failure. The retry gets the first answer (`repeat: true`) and records
  nothing new.
- **Mid-turn waits (P11).** A turn that moved to `waiting` or
  `input_required` cleared `active_turn_index`. A Steer then answers
  `no_turn` and the client falls back to an ordinary message; a Stop answers
  "nothing to stop" and its reason is never sent as a message.
- **Up to 20 open controls per turn** (`too_many` after that).

## API Reference

### Key components

| Component | Role |
|---|---|
| `TurnControlHub` (`turn-control.ts`) | Worker-owned LISTEN connection and registry of running turns. One connection attempt at a time per start..stop span (generation counter); `stop()` ends a client that is still connecting; concurrent `start()` calls share one claim. Reconnects with backoff (1 s to 15 s) and looks once after a reconnect. Injectable timers. |
| `LiveTurnControl` (`turn-control.ts`) | One turn's bookkeeping: `sent` (taken from the CMS), `cursor` (confirmed). One position-ordered queue; `retire()` drops it and ignores late confirmations and failures. |
| `TurnControlBinding` / `TurnControlSessionPort` | The run-bound interface between the live loop and `ManagedSession`: `attach(port)`, `heldStop()`, `gateOpened()`, `detach()`; the port's `gate()`, `close()`, `sendSteer()`, `failTurn()` are bound to one model run. |
| `ManagedSession` send gate | `pending` until the initial send, `open` during the run, `closed` on Stop, abort, forced settle, either turn guard (wall-clock timeout, inactivity watchdog), any error unwind, and before `session.idle` observers run. An unconfirmed steer delays settlement until its confirmation and a later idle. |

### Configuration options

| Setting | Default | Effect |
|---|---|---|
| `sessions.steering` | off, no user override | Gates new Steers. |
| `TURN_CONTROL_LOOK_INTERVAL_MS` | 5,000 ms | Periodic look while turns run; none while idle. |
| `TURN_CONTROL_OUTCOME_POLL_MS` | 250 ms | Management client's poll for a Stop outcome (30 s default timeout). |
| `TURN_CONTROL_MAX_OPEN` | 20 | Open controls per turn. |

### SDK send typing

Installed `@github/copilot-sdk` 1.0.13: `send(options: MessageOptions):
Promise<string>` returns the message id; `MessageOptions.mode` is
`"enqueue" | "immediate"`. A steer uses `mode: "immediate"`. Its
`user.message` event carries `messageId` equal to the id that `send`
returned, and `delivery` (`idle`, `steering`, …). The event can arrive before
`send()` resolves, so the watch is armed first.

### Observation probes

Armed only through `PILOTSWARM_FAULT_INJECT` (no-ops otherwise):

| Point | Where | Used by |
|---|---|---|
| `turn.control.after-start`, `after-writeback`, `after-commit`, `after-end` | after T3, T6, T7, T8 | crash matrix |
| `turn.control.before-send`, `before-writeback` (`hold@<sessionId>`) | before the initial send; after the gate closed, before T6 | window cases (P23) |
| `turn.control.cancel-observed` | the cancel poll saw `isCancelled()` | stale-worker test M1 |
| `turn.control.activity-end` | end of a V4 attempt | stale-worker test M2 |

The committed M1/M2 tests are the only in-repo callers that arm
`turn.control.cancel-observed` and `turn.control.activity-end`, using the
`log` action. Both points are no-ops unless named in `PILOTSWARM_FAULT_INJECT`.

The action `log` prints the hit line and continues. When the cancel poll
observes a cancellation it also writes one warning trace:
`[runTurn] activity cancelled for <session> turn <n> (its lock was lost); aborting the turn`.

## Testing

### How to test

The behavioral test files are in `packages/sdk/test/local/`, except for the
hand-run measurement at `packages/sdk/test/perf/turn-control-look-cost.mjs`:

| File | Covers |
|---|---|
| `turn-control-cms.test.js` | Procedures on real PostgreSQL: FR-009 cells, both orders against the end-of-turn write, refusals, retries, the flag, lifetimes, give-up and terminal closing, call counts, stale turn end. |
| `turn-control-live.test.js`, `turn-control-hub.test.js` | Gate and settlement orders, ordering, cross-turn fences; hub lifecycle with hand-driven timers; real notifications. |
| `turn-control-run-turn.test.js` | The V4 activity path with fakes. |
| `turn-control.test.js` | Real CLI and the default model: design 7.3 rows and the window cases. |
| `turn-control-crash.test.js` | US-5 crash matrix on forked worker processes. |
| `turn-control-workspaces.test.js` | W1-W6 on the reference repo-workspaces deployment. |
| `turn-control-multi-worker.test.js` | A stale worker comes back (design 3.9). |
| `packages/sdk/test/perf/turn-control-look-cost.mjs` | Look cost and connection budget, run by hand. |

### Edge cases

- **Worker loss and the prompt record.** A worker loss re-dispatches the same
  activity with `retryCount` 0. Before this change the next worker recorded
  the prompt and the turn's system message again; this was a duplicate that
  already existed on V3 (`runTurnV3` is unchanged). On V4, when the session
  row that runTurn already loads before T3 has `turnHigh >= turnIndex`, both
  records are skipped. No CMS call was added.
- **Stale worker (design 3.9).** duroxide 0.1.32 renews an activity's lock
  every `lock_timeout / 2` (minimum 1 s, for timeouts under 15 s) and cancels
  the activity when a renewal fails; duroxide-pg 0.1.36 fails a renewal whose
  lock token was replaced. The default worker lock timeout is 10 s
  (`resolveDuroxideLockOptions` in `worker.ts` defaults it to 10,000 ms when
  no option or environment override is set; renewal is every 5 s), so a
  resumed stale worker sees cancellation within about `lock_timeout / 2` plus
  one 2 s cancel poll, about 7 s. In the test (2 s lock) it was 2,003 ms.
  Until then correctness holds by the turn-end fence below.
- **Turn-end fence.** A late turn end for an older turn writes nothing for a
  newer turn. This comes from per-turn scoping and idempotency, not from an
  explicit `turn_high` check: it only closes that turn's open controls,
  clears `active_turn_index` only when it still equals that turn, and skips
  carried steers that are already closed.
- **A stale worker skips T8 when no controls are open** (P15): its
  T6 writeback finds no open controls after the winner's T8. The outcome
  equals design 3.9, where both workers call T8.
- **Sessions without a session store** (D4): a crash re-runs the turn from
  nothing, as today. A stopped turn's earlier delivered steer is labelled
  `not_delivered` although the live conversation keeps it.

## Measurements

`packages/sdk/test/perf/turn-control-look-cost.mjs`, dev pod, PostgreSQL
16.15, local database, `PERF_TURNS=1,10,50`, `PERF_ITERATIONS=200`, and
`PERF_STEER_EVERY=5` (open steers at zero-based indices 0, 5, ...). The script
warms each count with 10 looks, collects 200 round-trip and CPU samples, and
runs 100 server-side `EXPLAIN ANALYZE` samples:

| Live turns | Round trip mean | Round trip p95 | Server mean | Server p95 | DB CPU per look |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.53 ms | 0.71 ms | 0.32 ms | 0.41 ms | 0.38 ms |
| 10 | 0.88 ms | 1.17 ms | 0.60 ms | 0.71 ms | 0.73 ms |
| 50 | 2.16 ms | 2.25 ms | 1.79 ms | 1.91 ms | 1.98 ms |

Run 2026-10-13T07:07:55Z (the script's own header).

Server time is `EXPLAIN ANALYZE` execution time of the same look. DB CPU is
the CPU time of one dedicated database backend running the same look, read
from `/proc/<pid>/schedstat`. The script reads it only when the database
runs on the same host and the PID is provably that connection's backend:
its process title must name the user, database and client port that
`pg_stat_activity` reports for `pg_backend_pid()`. Otherwise it names the
reason and prints no number. At the 5 s look interval, one worker with 50
live turns uses about 1.98 ms of database CPU every 5 s, about 0.04% of one
core.
`pg_stat_statements` was not installed. One LISTEN connection per worker
while the hub runs, none after stop.

Connection budget at the default pool sizes: per worker 16 connections
before (CMS 3, facts 3, duroxide 10) and 17 with turn control. With
`max_connections` 1,600, 3 reserved and 6 for the portal, 99 workers fit
before and 93 with turn control.

Real CLI with the notification connection killed: the steer was confirmed
1,214 ms after it was accepted.

## Limitations and Future Work

- **Prompt record, known limits.** A crash between the prompt record and T3
  still records the prompt again on the next attempt. Two attempts of the
  same turn that run at the same time (design 3.9) can both read the old
  `turnHigh` and both record it.
- **Migration 0082 edited in place.** The Steer-flag parameter was added to
  0082 before its release. A database that already applied the earlier 0082
  keeps the old function until its schema is reset.
- **HorizonDB listener** not covered: the dev pod has no `.env.horizondb`.
- **Dev pod limit.** `multi-worker.test.js` "Turn 0 Resets Stale Stored
  Session" needs a GitHub token for its seed turn and fails in the pod; it
  does not touch turn control.
