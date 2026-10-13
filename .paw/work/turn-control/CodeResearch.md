---
date: 2026-10-13T01:38:39+00:00
git_commit: 8ffed787f29629bfb202f25a052bfed0ff3a2326
branch: waldemort/turn-control-runtime
repository: microsoft/pilotswarm
topic: "Session Turn Control revision 5: refreshed existing-code map for runtime/CMS/worker, orchestration and client surfaces"
tags: [research, codebase, session-proxy, session-lifecycle, snapshot-protocol, orchestration-turn, stop-turn, managed-session, cms-migrations, live-plane, duroxide-worker-dispatcher, fault-injection]
status: complete
last_updated: 2026-10-13
last_updated_note: "Refreshed Q1-Q9 from 12dfd3ee and added Q10-Q20 at 8ffed787; external dependency evidence remains explicitly inherited."
---

# Research: Turn control through the CMS — existing code map

## Research Question

Work ID `turn-control`, custom mode (design-first; no Spec.md supplied). Binding input:
`docs/proposals/session-turn-control.md` revision 5 at
`8ffed787f29629bfb202f25a052bfed0ff3a2326`. The complete 1,218-line proposal was read.
This document maps existing implementation, not proposed behavior.

Q1-Q9 refresh the prior [CodeResearch.md](artifact://767de262-d3d8-47a9-85b2-2f3af17b656c/turnctl-CodeResearch.md)
(SHA-256 `6d01a2ffb163600eb4fd1fe9f872c5b3fc8a6249c6a12de767ae2b5d9ecffcc0`), whose PilotSwarm
input was `12dfd3ee95642fca9e3a4acb84befda8d9e96c2d`. Q10-Q20 extend the map for the
runtime/CMS/worker, orchestration and client-surface workstreams.

1. The `runTurn` activity end to end (order of CMS writes, preamble, model run, snapshot commit, post-turn writes, return; failure points).
2. Snapshot lifecycle (sentinel, marker, turn-commit file, already-committed recovery, unpublished/superseded, stopped skip, storeless sessions, epochs).
3. Orchestration turn index advancement per result type, retry paths, turnKey per retry, prompt carry-forward.
4. Today's Stop (client, `stopTurn.<n>` queue, race, `handleTurnStopped`, `abortTurn`, `abortWarmSessionTurn`, `ManagedSession` stop classification).
5. `ManagedSession` turn settlement (`session.idle`, post-idle sends, native subagent settlement, any "send immediate").
6. `active_turn_index`: every writer, clearer and reader.
7. LISTEN/NOTIFY infrastructure and worker PostgreSQL connections.
8. duroxide activity lock/renewal/cancellation/redelivery/late-completion semantics and `ActivityContext`; PilotSwarm's configured lock timeout.
9. Crash/fault-injection test patterns.

10. Shared turn types, activity input, Stop types, event lists and result switches.
11. Activity routing, registration, scheduling and worker tags.
12. Catalog/provider method surfaces, callers, test doubles and migration registration.
13. Latest complete writeback/update-session SQL and return behavior.
14. Feature definitions/defaults/cache/API/bootstrap exposure.
15. Worker start/stop, catalog configuration and activity injection.
16. ManagedSession event capture, SDK IDs, idle settlement, send shape and test fakes.
17. Orchestration freeze/registration, budgetStash, continue-as-new and CMS state propagation.
18. Stop management/Web API/MCP/CLI/portal/TUI/transcript/docs/sample surfaces.
19. Test discovery/scripts, Stop/crash harnesses and HorizonDB provider routing.
20. Existing implementation of the new turn-control identifiers, at candidate and base.

All PilotSwarm file:line references are relative to the repository root at the candidate SHA.
Explicit-SHA Git reads were used; mutable HEAD/index/working files were not research inputs.
The assigned workspace record matched the supplied `git` root/folder, and candidate, base,
proposal-path and root-commit objects were present. First-parent root:
`d7b321ede780ab6da1e60a7962251508e679e97d`.

References prefixed `duroxide:` are **inherited external-source evidence** from the prior artifact at
`585c89c86f03956f799913cf0b98186452221e75`; that repository was not read again. These are not
independently verified evidence about the newly pinned Node 0.2.1 package. Revision-5 dependency/spike
appendices are identified as proposal-reported evidence where used. Copilot SDK installed typings,
live model/provider behavior and real database behavior were not inspected or executed.

Logical artifact path: `.paw/work/turn-control/CodeResearch.md`. Delivered as a session artifact,
without a repository write.

## Summary

- **runTurn order today** (inside one per-session in-process lock): preamble (store probe; may return the
  stored result for an already-committed turnKey with no CMS writes) → provider budget gate (may return a
  `wait` with `gate:"budget"` or an `error`) → workspace gate (may return `wait` with `gate:"workspace"`) →
  `getOrCreate` → turn sentinel → (fire-and-forget) `system.message`/`user.message` events → awaited
  best-effort `state=running` then `setActiveTurnIndex` → `session.turn_started` → model run → 100 ms quiesce
  and event-write barrier → `completeTurnWriteback` (state, `active_turn_index=NULL`, metrics row,
  `session.turn_completed`) → `settleTurn` (ledger, idempotent by (session, turn)) → **then** the snapshot
  commit (`.ps-turn-commit.json` {turnKey, result} + CAS tar) → return `{...result, snapshotVersion}`.
  The CMS post-turn writeback precedes the snapshot commit.
- **Snapshot protocol**: sentinel written after `getOrCreate`, cleared only after a published commit;
  `stopped` results skip the commit and leave the sentinel dirty; a CAS conflict leaves the turn
  unpublished (`superseded`); an `alreadyCommitted` CAS outcome (same turnKey) restores the winner and
  returns its stored result. Sessions without a versioned store get an empty turnKey from the
  orchestration and run with no preamble/commit.
- **Turn index**: `state.iteration` increments for every result except a gate-refused `wait`
  (`orchestration/turn.ts:650-651`), and in the stop path (`:762`). A returned `error` increments, then
  retries through continue-as-new as a **new** index; a thrown runTurn error retries the **same** index.
  Every processPrompt call draws a new turnKey (`:446`); duroxide redelivery reuses the original input.
- **Stop today**: client reads `active_turn_index`, enqueues on `stopTurn.<n>`, polls KV; the orchestration
  races `runTurn` against that dequeue (`turn.ts:493-494`); on a stop win it awaits an `abortTurn`
  activity (lock-bypassing `abortWarmSessionTurn`, 8 s grace, then `forceSettleTurn` + async
  `invalidateWarmSession`), records `session.turn_stopped`, sets idle, increments iteration.
- **duroxide**: an activity's work item lock is renewed by a manager task; renewal failure cancels the
  activity's token; after the grace period the result is acked with no completion. This is inherited
  external-source evidence from the prior artifact, not a newly inspected Node package. A re-fetched
  (expired-lock) item carries the same input and an incremented attempt count, which the provider returns
  but `ActivityContext` does not expose. Ack requires a still-valid lock token (provider contract), and
  the replay engine drops duplicate completions. PilotSwarm's worker lock timeout defaults to 10 s.
- **LISTEN**: two portal relays (`pilotswarm_live`, `pilotswarm_canvas_live`) each hold one dedicated
  `pg.Client`. The SDK worker has no `pg.Client`/LISTEN; it uses pools only.
- **Current shared contracts**: `TurnResult` is in `types.ts:69-102`; activity input remains inline in
  `session-proxy.ts:1397-1425`; latest registered CMS migration is `0081` (`cms-migrations.ts:402-408`);
  current orchestration is `1.0.80` (`orchestration-version.ts:15`). No `TurnControlHub`, V4 turn activity,
  `turn_high`, control procedures or `sessions.steering` implementation exists.
- **Surface inventory**: Stop has direct/web management, generated HTTP routing, MCP `stop_turn`, portal
  button and TUI `Ctrl+X` / `Ctrl+Esc`; the CLI entrypoint has no dedicated Stop subcommand. Feature
  settings are separate management reads, not fields of portal bootstrap.

## Delta since 12dfd3ee

The exact base-to-candidate diff contains 11 changed paths:

| Area | Changed paths | Observed delta |
|---|---|---|
| Workflow context | `.paw/work/turn-control/WorkflowContext.md` | New workflow context |
| Deployment | `deploy/providers/azure/envs/template.env`; `deploy/providers/azure/services/base-infra/bicep/base-infra.params.template.json`; `deploy/providers/azure/services/base-infra/bicep/main.bicep`; `deploy/scripts/README.md`; `deploy/scripts/lib/deploy-bicep.mjs`; `deploy/scripts/test/foundry-substitute.test.mjs` | Foundry deployment-region support, unrelated to existing turn execution |
| Design | `docs/proposals/session-turn-control.md` | Added revision-5 proposal |
| Dependency | `packages/sdk/package.json`; `package-lock.json` | Duroxide Node/platform packages pinned to 0.2.1 |
| Worker | `packages/sdk/src/worker.ts:1095-1101` | Comments now describe poller cancellation, return as soon as work drains, and abort at drain-budget expiry; same line count |

All Q1-Q9 implementation files other than that comment-only worker delta are byte-unchanged in the
diff. Their line references remain valid. This refresh corrects the prior migration-registry citation
to `cms-migrations.ts:402-408`, stashed-prompt citations to `orchestration/turn.ts:448,464-469`, and
replaces the previously open portal-listener wiring question with `server.js:104-106,379-389`.
The newly added proposal is excluded from negative implementation searches.

## Documentation System

- **Framework**: plain Markdown; navigation uses Markdown indexes (`docs/README.md:1-45`).
- **Docs Directory**: `docs/`; design proposals in `docs/proposals/`, implementation plans in
  `docs/proposals-impl/` (e.g. `docs/proposals-impl/stop-button-turn-abort-plan.md`,
  `docs/proposals/session-lifecycle-protocol.md`, `docs/proposals/snapshot-store-wins.md`).
- **Navigation Config**: `docs/README.md` links Quick Start, User Guide, Architecture, API and Developer
  sections; user-track/keybinding links are at `:17-19`. No documentation-generator configuration or
  docs build/serve npm script was found in the tracked root/package manifests.
- **Style Conventions**: proposals carry numbered sections and lettered edge cases (e.g. stop plan E1–E12,
  `stop-button-turn-abort-plan.md:276-306`); schema changes require a companion
  `packages/sdk/src/migrations/NNNN_diff.md` (e.g. `0024_diff.md`). Latest CMS migration is `0081`
  (`packages/sdk/src/cms-migrations.ts:402-408`).
- **Build Command**: N/A for docs.
- **Standard Files**: root `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`; `docs/README.md`;
  `.github/copilot-instructions.md`; canonical user pages under `docs/user-guide/`.

## Verification Commands

These are existing command definitions, **not executed by this read-only activity**.

| Purpose | Existing command | Source |
|---|---|---|
| Full provider-aware test runner | `./scripts/run-tests.sh`; `--all-providers`; `--with-horizondb` | `scripts/run-tests.sh:177-189,980-1009,1144-1153` |
| Filtered local tests | `./scripts/run-tests.sh --suite=<substring>` | `scripts/run-tests.sh:1110-1118` |
| SDK local Vitest | `npm run test:local --workspace=packages/sdk` | Root `package.json:27`; SDK `package.json:53`; `vitest.config.js:12-17` |
| SDK Node unit tests | `npm run test:unit --workspace=packages/sdk` | SDK `package.json:62` |
| SDK API Node tests | `npm run test:api --workspace=packages/sdk` | SDK `package.json:58` |
| SDK build | `npm run build --workspace=packages/sdk` (`tsc`) | SDK `package.json:20` |
| Whole build | `npm run build` (SDK, horizon-store, app) | Root `package.json:24` |
| Type check/lint | `npm run lint` / SDK `tsc --noEmit` | Root `package.json:41`; SDK `package.json:56` |
| Shared UI / web / TUI tests | `npm run test:ui`, `test:web`, `test:tui` in app workspace | `packages/app/package.json:62-65` |
| Browser tests | App `npm run test:e2e` | `packages/app/package.json:71` |
| Privacy guard | `npm run check:privacy` | Root `package.json:10` |

There is no `SUITES` array in this revision's `scripts/run-tests.sh`. Full SDK Vitest discovery is
`test/local/**/*.test.js` (`packages/sdk/vitest.config.js:12`); filtering uses filesystem discovery.

## Detailed Findings

### Q1. The runTurn activity end to end (`packages/sdk/src/session-proxy.ts`)

**Scheduling (orchestration side).** `createSessionProxy().runTurn` schedules
`ctx.scheduleActivityOnSession(routedActivityName("runTurn"|"runTurn2"), input, affinityKey)`
(`session-proxy.ts:696-776`). Input carries `turnIndex`, `retryCount`, `clientMessageIds`, `sender`,
`snapshot:{turnKey}`, `attachments`, `transcriptEpoch`, `epochStart`, `stashedPrompts`,
`workspaceRevision`, `workspaceNotice` (`:709-760`). Routed names `runTurnV3`/`runTurnEpochV3` plus the
capability tag `pilotswarm.agent-handoff.v2`, or `pilotswarm.workspaces.v1` for workspace sessions
(`activity-routing.ts:6-16`, `:22-45`; `session-proxy.ts:772-775`). Both legacy and routed names are
registered to the same handler (`activity-routing.ts:48-51`; `session-proxy.ts:4649-4652`).

**Handler steps, in execution order** (`runTurnHandler`, `session-proxy.ts:1397-4647`):

| # | Step | Lines | Durable effect | Failure behaviour |
|---|---|---|---|---|
| 0 | Trace input; read model summary; open OTel span | 1430-1465 | none | — |
| 1 | `catalog.getSession` (authoritative model/agent) | 1471-1476 | none | best-effort, swallowed (`cms-retry.ts:13-16`, `:135-146`) |
| 2 | Model-mismatch / bound-agent-restored events | 1500-1543 | `session_events` inserts | best-effort |
| 3 | Acquire per-session in-process lock `withRunTurnLock` | 1582-1583; `session-manager.ts:1599-1611` | none | waits up to 120 s (`session-manager.ts:59`, `:1568-1572`), then `SessionLockAcquireTimeoutError` → caught at `session-proxy.ts:4591-4614`: records `session.error`, sets `state=error`, **returns** `{type:"error"}` |
| 4 | Build lifecycle context (only with `input.snapshot` + versioned store) | 1588-1608 | none | — |
| 5 | `runTurnPreamble` | 1632-1633 | may hydrate local dir from store | store errors propagate → activity **throws** |
| 5a | `already-committed` → return stored result + `snapshotVersion` | 1634-1647 | `session.hydrated` event, metric summary (best-effort) | returns before any `running`/`active_turn_index`/writeback write |
| 5b | `snapshot_regressed` / `snapshot_store_empty` events | 1655-1686 | event inserts | best-effort |
| 6 | Provider budget gate (`checkTurn`) | 1700-1781 | `session.budget_paused` event | pause → **returns** `{type:"wait", gate:"budget"}` (1754-1771); admission exception → **returns** `{type:"error"}` (1773-1780) |
| 7 | Workspace gate (`prepareWorkspace`, extras) | 1795-1950 | `session.workspace_unavailable` event | **returns** `{type:"wait", gate:"workspace"}` (`holdForWorkspace` 1829-1859, used at 1884 and 1906-1913) |
| 8 | `executeTurnBody` begins; fold stashed prompts | 1953-1981 | none | — |
| 9 | `getOrCreate` (epoch create only when preamble `fresh`) | 2070-2078 | may create SDK session files | missing/lost state → store recovery (2093-2117) or lossy replay (2118-2169, `failForMissingState` → `state=failed` + `{type:"error"}`); other errors rethrown (2171-2173) → **throws** |
| 10 | Write turn sentinel (lifecycle only) | 2177-2186 | `.ps-turn-inprogress` | — |
| 11 | Cooperative cancel poll every 2 s on `activityCtx.isCancelled()` → `session.abort()` | 3774-3782 | none | sets `cancelled=true` |
| 12 | `system.message` (turn note) unless retry attempt | 3945-3958 | event insert (tracked, not awaited) | best-effort |
| 13 | `user.message` unless timer prompt, bootstrap or `retryCount>0` | 3943-3990 | event insert (tracked, not awaited) | best-effort |
| 14 | `updateSession({state:"running"})` then `setActiveTurnIndex(turnIndex)` | 3996-4013 | sessions row | both best-effort (awaited, swallowed after one 3 s retry) |
| 15 | `session.turn_started {iteration}` | 4017-4025 | event insert (tracked) | best-effort |
| 16 | Attachment resolution (vision gate) | 4038-4180 | `runtime.attachment_dropped` events | best-effort |
| 17 | `ManagedSession.runTurn(prompt, {onEvent, controlToolBridge, turnIndex,...})` | 4183-4198 | `onEvent` writes each non-ephemeral SDK event (3849-3930); `session.wait_started` → `state=waiting` (3864-3874); `session.input_required_started` → `state=input_required` (3875-3885) | returns a `TurnResult`; can throw (see Q5) |
| 18 | Live-session-lost recovery (invalidate warm, recreate, re-run once) | 4200-4250 | `system.message` event | unrecoverable → `failForMissingState` |
| 19 | Corrupted-transcript recovery (reset, recreate at turn 0, re-run) | 4252-4310 | lossy-handoff + `system.message` events | unrecoverable → `{type:"error"}` |
| 20 | Child `QUESTION FOR PARENT:` coerced to `wait` | 4312-4325 | none | — |
| 21 | 100 ms quiesce; await all tracked event writes | 4352-4361 | none | — |
| 22 | `if (cancelled) return {type:"cancelled"}` | 4364 | none | skips steps 23-24 |
| 23 | `completeTurnWriteback` (status map 4370-4386) | 4405-4446 | sessions row (state, `active_turn_index=NULL`), `session_metrics` upsert, `session_turn_metrics` insert, `session.turn_completed` event (`cms-migrations.ts:7235-7333`) | best-effort |
| 24 | Provider `settleTurn` | 4448-4483 | ledger row; "idempotence lives in the ledger's (session, turn) primary key" (4449-4454) | best-effort |
| 25 | `executeTurnBody` returns the result | 4485 | — | — |
| 26 | Mark `workspaceAttached`; `keepOrchestrationTurnEvents` | 4490-4500 | — | — |
| 27 | Snapshot commit if lifecycle and `workspace.yaml` exists | 4513-4517 | `.ps-turn-commit.json`, store CAS, marker, sentinel clear (see Q2) | transient store errors retried 3× then **throw** (`session-lifecycle.ts:451-468`) |
| 27a | Unpublished (`stopped`/`superseded`) → `session.snapshot_unpublished` | 4518-4549 | event insert | best-effort |
| 27b | Snapshot size summary | 4550-4559 | metric summary | best-effort |
| 27c | `alreadyCommitted` with stored result → return the winner's result | 4560-4574 | — | — |
| 28 | Return `{...bodyResult, snapshotVersion}` (or `bodyResult` without lifecycle) | 4575-4577 | duroxide records completion on ack | — |
| 29 | Null result → throw | 4579-4581 | — | **throws** |
| 30 | Catch: package-binding errors → `{type:"error", retryable:false}`; lock timeout → error result; other → rethrow | 4583-4617 | as listed | — |
| 31 | Finally: span attributes, `clearInterval(cancelPoll)`, stop inline SDK client | 4618-4646 | none | — |

Observed ordering facts:

- The `user.message` write (step 13) and `turn_started` (step 15) are fire-and-forget tracked promises,
  drained only at step 21; the `running` + `active_turn_index` writes (step 14) are awaited.
- The post-turn CMS writeback (step 23) runs **before** the snapshot commit (step 27). Steps 23's inserts
  (`session_turn_metrics`, `session.turn_completed`) and `cms_record_events` (`cms-migrations.ts:3253-3266`)
  have no idempotency key; `session_events.seq` is a `BIGSERIAL` (`cms-migrations.ts:2979-2985`).
- `retryCount > 0` suppresses the `user.message` and `system.message` records (3944-3990). A duroxide
  redelivery carries the original `retryCount`.
- Statuses written by step 23: `completed→idle`, `wait→waiting`, `cron→running`, `error→error`,
  `cancelled→idle`, `stopped→idle`, sub-agent actions mostly `running` (4370-4386).

**abortTurn activity** (`session-proxy.ts:4654-4676`): registered with plain `registerActivity` (no
routing tag), scheduled by `createSessionProxy().abortTurn` with `scheduleActivityOnSession` on the same
affinity key (`:823-833`); body calls `sessionManager.abortWarmSessionTurn` and returns its outcome; no
CMS writes.

### Q2. Snapshot lifecycle (`session-lifecycle.ts`, `snapshot-protocol.ts`)

**Files** (`snapshot-protocol.ts:1-30`): marker `.ps-snapshot-version` {version, turnKey?, contentHash?,
epoch?, updatedAt} (`:32-46`), excluded from tars; sentinel `.ps-turn-inprogress` {turnKey?, startedAt}
(`:48-51`, write `:220-226`, clear `:228-230`), excluded from tars (`session-store.ts:368`);
turn-commit file `.ps-turn-commit.json` = `{ turnKey, result }` written atomically via tmp+rename
(`:232-236`), included in tars.

**Store contract** `VersionedSnapshotStore` (`snapshot-protocol.ts:125-145`): `probeSnapshot`,
`commitSnapshot(sessionId, {baseVersion, turnKey}, epoch)` succeeds iff stored version = base, or returns
`alreadyCommitted` when base+1 already holds the same turnKey; throws `SnapshotConflictError` otherwise
(`:103-118`); `hydrateSnapshot` replaces the local dir atomically and writes no marker.

**Preamble** `runTurnPreamble` (`session-lifecycle.ts:239-334`):

1. Reads sentinel, marker, layout anchor `workspace.yaml` (`:240-243`, `:146-148`).
2. Epoch gate: local is untrusted when the marker epoch differs from `transcriptEpoch`; for epoch ≥ 1 a
   markerless dir is also untrusted (`:252-263`). `localTrusted = !sentinel && usable && !epochMismatch` (`:264`).
3. One `probeSnapshot` (`:269`).
4. Store bears this turnKey → `recoverAlreadyCommitted` (`:280-282`): drop warm session, hydrate, marker,
   clear sentinel, read commit file; if its turnKey matches → `{kind:"already-committed", version, result}`;
   otherwise degrade to a hydrated re-run (`:171-191`).
5. Store empty → warm if local trusted, else wipe dir → `fresh` (lossy flag when a marker existed) (`:285-297`).
6. Legacy snapshot → warm if trusted, else hydrate (`:301-306`).
7. Warm fast path only if marker version and hash equal the probe (`:320-324`); otherwise hydrate the
   store (`:326-333`), flagging `regressed` when the store is below the marker (`:311-313`).

**Commit** `runTurnCommit` (`session-lifecycle.ts:358-469`):

- `result.type === "stopped"` → no commit, sentinel left dirty, `{published:false, unpublishedReason:"stopped"}` (`:372-385`).
- Write commit file `{turnKey, result}` (`:387-388`), fault point `turn.commit.before-cas` (`:389`).
- Up to 3 attempts (`:146`, `:392`) of `commitSnapshot(base, turnKey)`; fault point `turn.commit.after-cas` (`:398`).
- `alreadyCommitted` → drop warm, hydrate winner, marker, clear sentinel, return `storedResult` from the
  winner's commit file (`:400-422`).
- Success → marker (`:425-430`), `turn.commit.after-marker` (`:432`), clear sentinel (`:433`),
  `turn.commit.after-sentinel-clear` (`:434`), `published:true`.
- `SnapshotConflictError` → `{published:false, unpublishedReason:"superseded", observedStoreVersion,
  observedStoreTurnKey}`, sentinel stays dirty (`:444-462`).
- Transient failures exhausted → throw (`:451-468`).
- The caller commits only when `workspace.yaml` exists (`session-proxy.ts:4513-4516`).

**Store recovery after getOrCreate failure** `attemptStoreRecovery` (`session-lifecycle.ts:344-354`).

**Sessions without a store.** The orchestration sends `snapshot:{turnKey}` only when `state.blobEnabled`
(`orchestration/turn.ts:446`, `:484-491`). The worker builds a lifecycle context only with
`input.snapshot` AND a store that implements the versioned contract (`session-proxy.ts:1588-1608`).
Without it: no preamble, no sentinel (`:2177`), no commit (`:4516`), no already-committed recovery; the
handler returns `bodyResult` (`:4577`).

**Epochs (regeneration).** `transcriptEpoch` scopes every store call (`session-lifecycle.ts:115-123`);
epoch 0 = legacy key family, epoch ≥ 1 = separate CAS chain restarting at version 1
(`snapshot-protocol.ts:147-170`). `runTurn2`/`epochStart` creates a fresh SDK session only when the
preamble is `fresh` (`session-proxy.ts:2065-2077`); rebirth is "proven" by a committed snapshot ≥ 1, or
a non-error result for storeless sessions (`orchestration/turn.ts:512-544`).

### Q3. Orchestration turn index, retries and prompt carry-forward (`packages/sdk/src/orchestration/`)

**processPrompt** (`turn.ts:322-671`):

- New turnKey per call: `state.blobEnabled ? yield ctx.newGuid() : ""` (`:446`). Activity input
  `turnIndex = state.iteration` (`:449`).
- Stop race: `stopTask = ctx.dequeueEvent(stopTurnQueueName(state.iteration))` and
  `yield ctx.race(turnTask, stopTask)` (`:493-494`); stop win → `handleTurnStopped` and return (`:496-499`).
- Raced error value → rethrow (`:506-509`).
- **Thrown path** (`:549-597`): missing-state prefix → `state=failed` + throw (`:552-559`); auth error →
  `projectAuthFailure` (no retry) (`:561-565`); else `retryCount++` (`:567`) and
  `handleConnectionClosedRetry` or `handleGenericRetry`. `state.iteration` is **not** incremented on this
  path (the increment at `:651` is after the try/catch), so the retry re-enters with the same index.
- `retryCount = 0` only when the result is not `error` and not a workspace-gate `wait` (`:602-604`).
- Snapshot version mirror + `session.snapshot_lineage_jump` (`:609-633`).
- **Index increment**: `const gateRefused = result.type === "wait" && timerGate(result) !== undefined;
  if (!gateRefused) state.iteration++;` (`:650-651`). Only other increment: stop path `:762`. No other
  writer of `state.iteration` exists in `orchestration/` (grep).
- Then `maybeSummarize`, `refreshTrackedSubAgents`, queue `queuedActions`, `handleTurnResult` (`:661-670`).

**Per result type** (`handleTurnResult`, `turn.ts:1284-1660`; index already advanced unless gate-refused):

| Result | Index | Handling |
|---|---|---|
| `completed` | +1 | `writeLatestResponse`; optional `forceContinuePrompt` CAN; parent notify; `schedulePostTurnContinuation` (`:1333-1404`) |
| `cron` / `cron_at` | +1 | `applyCronAction` / `applyCronAtAction` (`:1406-1412`) |
| `wait` (wait / wait_on_worker tools, child question) | +1 | durable timer, `session.wait_started` (`:1414-1520`) |
| `wait` with `gate:"budget"` | unchanged | prompt stashed durably via `stashBudgetRefusedPrompt` (`:1425-1437`) and replayed as `stashedPrompts` |
| `wait` with `gate:"workspace"` | unchanged | `holdForWorkspace` (`:1415-1418`) |
| `input_required` (ask_user) | +1 | `pendingInputQuestion`, grace/idle timer (`:1522-1571`) |
| `cancelled` | +1 | trace only (`:1573-1575`) |
| `stopped` (defensive) | +1 | `session.turn_stopped {turnIndex: iteration-1, interrupt:"turn-result"}`, `updateCmsState idle`, continuation (`:1577-1597`) |
| `set_workspace*`, sub-agent actions | +1 | `:1599-1616` |
| `error` | +1 | missing-state → fail; auth → project; `retryable:false` → project, no retry; else `retryCount++` and retry (`:1618-1660`) |

**Retry mechanics.** `handleGenericRetry` (`turn.ts:274-318`): at `retryCount >= MAX_RETRIES` (3,
`state.ts:340`) writes `state=error` via `updateCmsState` (`:291-295`) and stops; otherwise backoff
`15 * 2^(retryCount-1)` s (`:300`), `releaseAffinity` if blob-enabled, durable timer, then
`versionedContinueAsNew(continueInput(retryContinueOverrides(...)))` (`:316-317`).
`handleConnectionClosedRetry` (`:116-194`) is analogous with its own limits and a lossy-handoff fallback.
`retryContinueOverrides` (`:196-221`) carries `prompt: sourcePrompt`, `requiredTool`, `cycleOrigin`,
`retryCount`, `needsHydration` (and `bootstrapPrompt` for system-only turns); it carries no
`clientMessageIds` or `sender`. `buildContinueInput` carries `iteration: state.iteration`
(`lifecycle.ts:536-538`). Result: a returned error retries at index n+1; a thrown error at index n.
The retried execution re-enters `processPrompt` through `pendingPrompt` (Priority 2,
`queue.ts:712-735`), which draws a fresh turnKey (`turn.ts:446`). `versionedContinueAsNew` captures the
active timer and continues as the latest version (`lifecycle.ts:631-661`).

**Timers and system turns.** `processTimer` (`turn.ts:1666-1913`): wait timer → prompt "The N second wait
is now complete…" (`:1674-1702`; `session-proxy.ts:3943` skips recording it as `user.message`); budget
timer → `BUDGET_TIMER_WAKE_PROMPT`; `cron`/`cron_at` → `[SYSTEM: …]` bootstrap prompts with `cycleOrigin`
(`:1704-1794`); `workspace_retry` → `WORKSPACE_RETRY_WAKE_PROMPT` (`:1796-1802`); `idle` → release
affinity, no turn (`:1804-1812`). System-only turns use `INTERNAL_SYSTEM_TURN_PROMPT` with bootstrap
(`turn.ts:355-359`). Child digests run `[SYSTEM: …]` bootstrap prompts (`queue.ts:885-1006`). All pass
through the same `processPrompt` index rule.

**Prompt carry-forward slots.**

- `state.pendingPrompt` (+ `pendingAttachments`, `pendingRequiredTool`, `pendingCycleOrigin`,
  `bootstrapPrompt`) (`state.ts:99-107`), seeded from `input.prompt` on each execution (`state.ts:449-455`).
- `queueFollowup` merges text into `pendingPrompt` (`lifecycle.ts:499-506`); `buildContinueInputWithPrompt`
  merges a next prompt (`lifecycle.ts:615-628`); `buildContinueInput` writes `prompt` from
  `overridePrompt ?? pendingPrompt` (`lifecycle.ts:525`, `:557`).
- Dispatch order in `queue.ts`: pending tool actions (`:700-707`), then `pendingPrompt` (`:712-735`), then
  FIFO prompts merged into one turn with their `clientMessageIds` (`:738-829`), then child digests (`:848-855`).
- `state.pendingSystemPrompt` → `turnSystemPrompt` (`turn.ts:339-345`).
- `state.budgetStash` → `stashedPrompts` + `stashedAttachments` on the next runTurn (`turn.ts:448,464-469`);
  cleared once a turn gets past the gates (`turn.ts:1317-1320`).
- User messages sent during a turn go to the `messages` queue (`management-client.ts:3805-3860`) and are
  dequeued only outside the runTurn race (`queue.ts:286`, `:311`, `:342`, `:346`, `:570`).

### Q4. Today's Stop

**Client** `PilotSwarmManagementClient.stopSessionTurn` (`management-client.ts:2481-2553`): reads the CMS
row; returns `no_active_turn` unless `state === "running"` and `activeTurnIndex != null` (`:2503-2513`);
asserts the orchestration is live (`:2516`); enqueues `{id, reason, requestedAt}` on
`stopTurn.<activeTurnIndex>` (`:2517-2526`); polls the KV command response every 400 ms up to 30 s
(`:2528-2545`); else `timeout` (`:2549-2553`). Web variant forwards to the API
(`web/web-management-client.ts:108-110`). Types: `stopTurnQueueName` (`types.ts:1707-1709`),
`StopTurnEventPayload`, `AbortTurnResult`, `StopTurnResult` (`types.ts:1711-1731`).

**Race** (`orchestration/turn.ts:493-499`): see Q3. When `runTurn` wins, the stop dequeue is dropped;
duroxide keeps queued messages after a dropped dequeue and carries up to 100 unread queued arrivals across
continue-as-new (`duroxide:docs/migration-guide.md:61-69`; `duroxide:src/runtime/limits.rs:14`). A stop
enqueued on `stopTurn.<n>` therefore remains readable by any later race on the same index n (thrown-error
retry, or the turn after a gate refusal).

**handleTurnStopped** (`turn.ts:707-780`): parse reason; `retryCount = 0` (`:723`); `yield
runtime.session.abortTurn(reason, stoppedIteration)` with failure → `no_active_turn` (`:732-739`); record
`session.turn_stopped {reason, turnIndex, interrupt, detail, clientMessageIds}` and
`system.message "Turn stopped by user."` (`:744-756`); `updateCmsState(idle)` (clears
`active_turn_index`) (`:757-759`); `state.iteration++` (`:762`); write command response
(`stopped`/`stop_forced`) (`:764-774`); `schedulePostTurnContinuation` (`:779`). The dropped runTurn work
item is cancelled by duroxide as a select loser (`duroxide:src/runtime/execution.rs:119-126`,
`duroxide:src/runtime/dispatchers/orchestration.rs:933-997`).

**Worker primitive** `SessionManager.abortWarmSessionTurn` (`session-manager.ts:1713-1781`), documented as
lock-bypassing (`:1716-1725`): `no_active_turn` if no warm session or no active turn (`:1731-1738`);
`expectedTurnIndex` mismatch guard (`:1739-1750`); `managed.requestStop(reason)` then `managed.abort()`
(`:1752-1759`); poll every 200 ms up to `unwindGraceMs ?? 8_000` (`:1761-1765`) → `stopped`; else
`forceSettleTurn` + 2 s poll + fire-and-forget `invalidateWarmSession` (lock-taking,
`session-manager.ts:3354-3365`) → `stop_forced` (`:1771-1780`).

**ManagedSession** (`managed-session.ts`): `activeTurn` set for the duration of `runTurn` (`:894`,
`:1460`); `requestStop` sets `stopRequest` only when a turn is active (`:1505-1509`); `forceSettleTurn`
sets `stopRequest` if absent and resolves the turn promise (`:1518-1523`); after the inner turn and native
cleanup, any `stopRequest` reclassifies the outcome as `{type:"stopped", reason, events}` (`:1478-1485`),
including over thrown errors (`:1486`); `finally` clears `activeTurn`, `stopRequest`, resolver
(`:1488-1492`). `abort()` sends `copilotSession.abort()` (`:3889-3891`).

**Backstop** (dropped future): duroxide lock-steal → token cancel (Q8) → the 2 s `isCancelled` poll aborts
the SDK request (`session-proxy.ts:3774-3782`) → `{type:"cancelled"}` returned before CMS writeback
(`:4364`) and committed (cancelled is not skipped, `session-lifecycle.ts:366-371`); duroxide then acks the
cancelled work item without a completion (`duroxide:src/runtime/dispatchers/worker.rs:611`).

**Plan document**: `docs/proposals-impl/stop-button-turn-abort-plan.md` (edges E1-E12, `:276-306`;
E6 states that during retry backoff `active_turn_index` is cleared, `:294`).

### Q5. ManagedSession turn settlement

- **What ends a turn.** `turnComplete` resolves on the first non-child `session.idle`
  (`managed-session.ts:3306-3311`, `:3553-3562`); `forceSettleTurn` resolves the same promise
  (`:3308-3310`). The main wait races `turnComplete` against a 20 min wall-clock cap and a 5 min
  inactivity watchdog (`:698-708`, `:3564-3608`, `:3657-3663`).
- **Sends inside a turn.** The only `copilotSession.send` calls are the initial prompt (`:3641-3655`) and
  bounded correction re-prompts for a tool call written as text (`:3673-3696`) and a missing required tool
  (`:3717-3746`); each correction arms `waitForNextIdle` before sending (`:3612-3624`).
- **After the turn.** `finally` clears guard timers, finishes the live-turn row, finishes native task
  tracking, and unsubscribes every handler (`:3805-3816`), so events emitted after settlement are not
  collected or forwarded by this turn. The result is chosen from `pendingActions` first (`:3819-3846`),
  then `session.error` (`:3858-3874`), else `completed` (`:3876-3882`).
- **Control tools.** `wait`/`wait_on_worker` above the 30 s threshold and `ask_user` push a pending action
  and return an acknowledgement asking the model to stop (`:552-555`, `:1571-1597`, `:1659-1685`,
  `:1847-1869`); they do not abort the session. Short waits sleep inside the tool handler (`:1573-1576`,
  `:1662-1665`). A second control tool after a terminal boundary is refused (`:571`, `:640-646`).
- **Native subagents.** With `nativeSubagents === "sync"`, `settleNativeSubagents` runs before the inner
  turn and after it with `rejectRunning` when the result is `completed` and no stop is set
  (`managed-session.ts:1465-1477`). It cancels running/idle agent tasks, removes them, and throws on
  timeout (5 s), on a still-active agent, or on a running agent after completion
  (`native-subagents.ts:188-224`). The post-turn settle is outside the inner try, so its throw propagates
  out of `runTurn` (`managed-session.ts:1473-1477`) → `executeTurnBody` → activity throw.
- **"Send immediate".** No immediate send mode or Steer method is implemented in `packages/sdk/src`.
  The initial/correction send sites pass no `mode` (`:3641-3655,3673-3696,3717-3746`). Revision-5
  proposal appendix 10.1 reports an Azure Responses spike; it is not existing runtime implementation
  or installed SDK typing evidence. No implemented API sends into a running turn from outside the activity.

### Q6. `active_turn_index`

- **Column**: `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_turn_index INTEGER` (migration 0024,
  `cms-migrations.ts:7093-7102`; registry `:139-140`; diff `migrations/0024_diff.md:9-23`).
- **Writer (only)**: `cms_set_active_turn_index(session, turn)` sets the column and `updated_at`
  (`cms-migrations.ts:7104-7116`); `PgSessionCatalog.setActiveTurnIndex` (`cms.ts:1493`, `:1858-1862`);
  called once, at runTurn step 14 (`session-proxy.ts:4007-4012`), no state check.
- **Clearers**:
  - `cms_complete_turn_writeback` sets it `NULL` unconditionally
    (`cms-migrations.ts:7235-7273`; latest definition is migration 0024, after earlier definitions).
  - `cms_update_session` sets it `NULL` when the update carries a `state` other than `running`
    (0024 `:7215`, 0026 `:7510`, 0034 `:2250`, latest 0059 `:13029`).
  - Callers of `updateSession` with a non-running state: runTurn `failForMissingState`
    (`session-proxy.ts:1561-1574`), mid-turn `waiting`/`input_required` on `session.wait_started` /
    `session.input_required_started` (`:3864-3885`), lock timeout `error` (`:4602-4610`),
    `cancelSession` activity (`:5681-5690`), `updateCmsState` activity used by the orchestration
    (`:5718-5737`; orchestration calls at `turn.ts:240`, `:259`, `:291`, `:557`, `:759`, `:1594`,
    `:1624`), and management/client transitions (`management-client.ts:913`, `:1277`, `:1289`, `:1301`;
    `client.ts:1098`, `:1110`, `:1126`).
- **Readers**: `cms_get_session` returns it (`cms-migrations.ts:7119-7190`), mapped to
  `activeTurnIndex` (`cms.ts:139`, `:3823`); used only by `stopSessionTurn` (`management-client.ts:2507`).
  List procedures are intentionally not extended (`migrations/0024_diff.md:17`).
- **Thrown-path observation**: a runTurn throw after step 14 and before step 23 leaves `state=running` and
  `active_turn_index` set; `handleGenericRetry` writes CMS state only on exhaustion (`turn.ts:291-295`).

### Q7. LISTEN/NOTIFY infrastructure

- **Portal live plane** `createLivePlane` (`packages/app/web/api/live-plane.js:15-207`): one dedicated
  `pg.Client` (`:21`, `:97`) with `keepAlive`, 5 s connect/query timeouts; `LISTEN pilotswarm_live`
  (`:110`); reconnect with backoff 1 s → 15 s (`:148-154`); 30 s `SELECT 1` liveness probe (`:162-171`);
  per (sessionId, topic) subscribers (`:173-195`); filters by `payload.schema` (`:46`); per-key `seq`
  monotonic delivery (`:84-87`); pointer payloads trigger a `getLive` read (`:59-83`); on reconnect each
  subscriber gets `unavailable` then a fresh snapshot read (`:126-145`).
- **Portal canvas plane** `createCanvasPlane` (`packages/app/web/api/canvas-plane.js:26-156`): same
  connection discipline, channel `pilotswarm_canvas_live` (`:30`, `:50`), pure fan-out by session id
  (`:4-18`).
- **NOTIFY sources**: `cms_publish_live` → `pg_notify('pilotswarm_live', {schema, sessionId, topic, seq,
  kind[, data]})`, inline ≤ 7,900 bytes else pointer (`cms-migrations.ts:14774-14824`, migration 0074);
  retained rows in UNLOGGED `live_state` (migration 0073, `:14742-14755`); canvas NOTIFY in migrations
  (`:13989`, `:14040`) and inline SQL in `cms.ts:2406-2479`.
- **Config helper** `buildSessionCatalogPgClientConfig` (`pg-pool-factory.ts:200-233`), exported
  (`index.ts:77-78`): resolves the CMS URL, applies `buildPgPoolConfig` (sslmode fix, managed-identity
  password callback per connection), drops `max`. Construction site:
  `packages/app/web/server.js:104-106` builds the connection through the exported helper; `:379-389`
  shares that configuration with the canvas and live relays. Both start before socket attachment and
  are stopped during portal shutdown (`:396-400`). This previously open source-wiring question is resolved.
- **Workers**: no `pg.Client` construction and no `LISTEN` in `packages/sdk/src` (git grep). Worker
  PostgreSQL access in the inspected TypeScript paths is pooled: CMS `pg.Pool` (`cms.ts:1589-1623`, `PILOTSWARM_CMS_PG_POOL_MAX`), facts
  `pg.Pool` (`facts-store.ts:622`), the duroxide `PostgresProvider` (`storage-providers.ts:15`, `:156`;
  `DUROXIDE_PG_POOL_MAX` default 10, `worker.ts:57`, `:679-681`). Transient checkouts only:
  `cms.ts:1669`, `feature-store.ts:28-36`, `pg-migrator.ts:90`, `duroxide-schema-migration.ts:101`,
  `resourcemgr-tools.ts:585`. The feature-flag cache polls (`feature-flag-cache.ts:11`, `:48`).
- **Env gate for the worker live turn publisher**: `PILOTSWARM_LIVE_TURN === "1"` (`session-proxy.ts:3824-3826`).

### Q8. duroxide activity semantics (585c89c) and PilotSwarm lock settings

The `duroxide:` references in this section are retained from the prior artifact, not newly read
dependency objects. The candidate manifest pins Node 0.2.1. The proposal reports updated Node
cancellation wiring in appendix 10.3 (`session-turn-control.md:1179-1204`); live cancellation/JavaScript
termination and omitted binding settings remain outside this source-only activity's evidence.

- **Fetch**: `fetch_work_item(worker_lock_timeout, long_poll_timeout, session_config, tag_filter)`
  returns `(WorkItem, lock_token, attempt_count)` (`duroxide:src/runtime/dispatchers/worker.rs:307-325`;
  contract `duroxide:src/providers/mod.rs:1741-1778`). Session-bound items are fetchable only by the
  session owner or when the session lock is free (`duroxide:src/providers/mod.rs:1752-1761`). SQLite
  reference: an item is eligible when unlocked or `locked_until <= now`; the fetch sets a new token and
  increments `attempt_count` on the same row (same input) (`duroxide:src/providers/sqlite.rs:1839`,
  `:1864`, `:1907`).
- **Poison**: `attempt_count > max_attempts` (default 10) → `ActivityFailed` Poison without running
  (`worker.rs:381-385`, `:426-462`; `mod.rs:252`, `:365`).
- **Renewal**: manager task renews every `timeout - buffer` (timeout ≥ 15 s) or `ceil(0.5 × timeout)`
  (timeout < 15 s), minimum 1 s (`worker.rs:792-803`, `:808-875`). It deliberately ignores runtime
  shutdown (`:833-836`).
- **Renewal failure**: logs "Lock renewal failed, signaling activity cancellation (lock was stolen or
  expired)" and calls `cancellation_token.cancel()` (`worker.rs:855-863`).
- **After cancel**: waits `activity_cancellation_grace_period` (default 10 s, `mod.rs:270`, `:366`), aborts
  the task handle if unfinished, then `ack_work_item(lock_token, None)` — the result is dropped
  (`worker.rs:572-618`).
- **Late completion from an old holder**: ack contract requires a non-retryable error when the locked entry
  no longer exists or the lock expired (`duroxide:src/providers/mod.rs:1797-1831`); SQLite deletes
  `WHERE lock_token = ? AND locked_until > now` and returns a permanent error otherwise
  (`sqlite.rs:1975-2003`). On ack failure the dispatcher abandons the token (`worker.rs:754-781`). The
  replay engine also ignores completions already in history or staged in the current run
  (`duroxide:src/runtime/replay_engine.rs:142-182`).
- **Cancellation of dropped/abandoned activities**: select losers (`execution.rs:119-126`) and in-flight
  activities at Completed/Failed/**ContinuedAsNew** (`orchestration.rs:933-976`) are passed as
  `cancelled_activities` to the ack; renewal then fails (`providers/mod.rs:1848-1856`).
- **ActivityContext** fields: instance_id, execution_id, orchestration name/version, activity name/id,
  worker_id, session_id, tag, cancellation token, store (`duroxide:src/lib.rs:2168-2185`); accessors
  `:2223-2265`, `is_cancelled` `:2347-2349`, `cancelled()`, `cancellation_token()`, `get_client()`. No
  attempt or delivery count (the dispatcher's `ActivityWorkContext.attempt_count` is not passed,
  `worker.rs:524-543`).
- **Defaults** (`duroxide:src/runtime/mod.rs:355-377`): worker lock 30 s/5 s buffer, orchestrator lock 5 s,
  session lock 30 s, session idle 300 s, `max_sessions_per_runtime` 10, grace 10 s.
- **PilotSwarm settings** (`worker.ts:98-130`, `:852-863`): `workerLockTimeoutMs` = option →
  `PILOTSWARM_WORKER_LOCK_TIMEOUT_MS` → **10,000 ms**; renewal buffer defaults to 75% of timeout only when
  timeout ≥ 15 s (`:76-81`), so 10 s locks renew every 5 s; orchestrator lock 60,000 ms; session lock
  option/env else duroxide default 30 s; `maxSessionsPerRuntime` 50; `sessionIdleTimeoutMs` 3,600,000;
  `workerConcurrency` default 2 (`worker.ts:56`, `:672-673`); grace period not set by PilotSwarm.
  `kill-harness.js:20-24` comments that the session lock (~30 s) bounds re-dispatch after a kill.

### Q9. Crash and fault-injection test patterns

- **`faultPoint(name)`** (`packages/sdk/src/fault-injection.ts:1-42`): no-op unless
  `PILOTSWARM_FAULT_INJECT` lists `<point>[:exit|throw[:afterHits]]`; `exit` = `process.exit(137)`.
  Points: `turn.commit.before-cas`, `turn.commit.after-cas`, `turn.commit.after-marker`,
  `turn.commit.after-sentinel-clear` (`session-lifecycle.ts:389`, `:398`, `:432`, `:434`);
  `store.commit.before-write`, `store.commit.tar-renamed`, `store.commit.after-write`,
  `store.hydrate.before-swap` (`session-store.ts:757`, `:809`, `:813`, `:872`; `blob-store.ts:690`,
  `:703`, `:786`).
- **Kill harness** `packages/sdk/test/helpers/kill-harness.js:1-148`: forks real worker processes with the
  fault armed, 2 s worker lock, a shared filesystem snapshot store and separate per-worker state dirs.
- **Live crash matrix** `packages/sdk/test/local/fault-injection-live.test.js`: scenario driver
  `runKillScenario` (`:62-148`) — healthy turn 1, kill at the boundary on turn 2, recover on worker B,
  assert exact store version, clean marker/sentinel, no lossy path, exactly one hydration, then turn 3
  (`:150-253`, F2-F6b).
- **Unit lifecycle** `test/local/turn-lifecycle.test.js` (preamble and commit cases, `:78-536`) using
  `PILOTSWARM_FAULT_INJECT` with `:throw` (`:339`, `:460`).
- **Stop** `test/local/stop-turn.test.js` (fake `CopilotSession` with `abortFiresIdle`, `:29-75`; classification,
  `abortWarmSessionTurn`, `stopSessionTurn`, race normaliser, `:88-381`) and
  `test/local/stop-turn-live.test.js` (`:175-187`).
- **Multi-worker / chaos / crash**: `multi-worker.test.js:420-441`, `chaos.test.js:298-316`,
  `reliability-crash.test.js:223-235`.
- **Live plane on PostgreSQL**: `test/local/live-plane.test.js:48-211` (publish, seq, inline vs pointer
  NOTIFY, refusals).
- **Suite registration**: `scripts/run-tests.sh` discovers files under `packages/sdk/test/local`
  (`:1110-1115`); restart-heavy files are named at `:1031-1032`.

### Q10. Shared types, event strings and TurnResult switches

| Contract | Existing declaration |
|---|---|
| `TurnAction` | `packages/sdk/src/types.ts:20-43` |
| Snapshot/workspace/queued-action carriers | `types.ts:45-67` |
| `TurnResult` | `types.ts:69`; intersection with variant and snapshot/workspace carriers |
| Variants | `types.ts:71-102`: completed, wait, cron set/cancel, cron_at set/cancel, input_required, spawn/message/check/wait/list/complete/cancel/delete agents, set_workspace, set_workspace_extra, cancelled, stopped, error |
| Captured SDK event | `types.ts:104-108`: `eventType: string`, `data: unknown` |
| Model turn options | `types.ts:112-122`, including `onEvent` and `turnIndex` |
| runTurn activity input | Inline at `session-proxy.ts:1397-1425`; scheduling metadata inline at `:700`. No named `RunTurnInput` in `types.ts` |
| Stop queue | `types.ts:1707-1709`, `stopTurnQueueName(turnIndex)` |
| Stop payload | `types.ts:1712-1717`, `StopTurnEventPayload` |
| Abort result | `types.ts:1720-1724`, outcomes stopped / stop_forced / no_active_turn |
| Management Stop result | `types.ts:1727-1731`, same outcomes plus timeout |
| Public exports | `packages/sdk/src/index.ts:155-157` exports TurnAction/TurnResult/CapturedEvent; CMS types at `:86` |

The inline handler input lists the current execution metadata (session/config/prompt/bootstrap,
turn index, parent/nesting, retry, required tool, cycle, client message IDs/sender, snapshot,
attachments, epoch and workspace fields). Stashed prompt handling exists in the body
(`session-proxy.ts:1964-1979`) and scheduling metadata but is not a separate shared activity-input
interface. No Stop/Steer control-row type is present.

**Event strings.** There is no single global enum/constant registry governing all session events.
`SessionEvent` and emitter types use `eventType: string` (`cms.ts:21-35`), `CapturedEvent` is also
string-valued, and client subscription accepts a string (`client.ts:1443`). Separate purpose-specific
lists do exist:

| List/filter | Location and role |
|---|---|
| Streaming types | `turn-result-events.ts:26-38` |
| Turn-result exclusions | `turn-result-events.ts:46-49`; applied at `managed-session.ts:3498` |
| Orchestration retained events | `turn-result-events.ts:57-63,83-89`: usage/compaction/tool completion |
| CMS generic event exclusions | `session-proxy.ts:3802-3823,3859`; streaming events, already-recorded user.message and canvas events |
| Model trace event set | `model-event-logging.ts:26-31`; controlled separately by the logging flag |
| Shared transcript event allowlist | `packages/app/ui/core/src/history.js:22-55`, used for history filtering |
| PostgreSQL event-type filtering | Migration 0025, `cms-migrations.ts:7338-7404`; nullable `TEXT[]`, `event_type = ANY(p_event_types)`, not an enum |

**Every source file with a TurnResult-type switch.** Active `orchestration/turn.ts:1332` handles the
result; `orchestration/agents.ts:647` switches a result-like `any` for subagent actions.
`managed-session.ts:3825` switches **firstAction.type** (TurnAction), not the returned TurnResult.
`session-proxy.ts:4370-4386` uses a lookup/status mapping instead of a switch.
Historical switches remain in frozen source files. Exact inventory:

| Frozen monolithic file suffix (`packages/sdk/src/orchestration_1_0_<suffix>.ts`) | `switch (result.type)` line |
|---|---|
| 26, 27, 28 | 797 |
| 29 | 944 |
| 30 | 957 |
| 31 | 1000 |
| 32, 33 | 1366 |
| 34, 35 | 1501 |
| 36 | 1615 |
| 37 | 1862 |
| 38 | 1871 |
| 39, 40, 41 | 1904 |
| 42 | 1907 |
| 43, 44 | 1957 |
| 45, 46 | 1968 |
| 47 | 2142 |
| 48 | 2167 |
| 49 | 2193 |
| 50 | 2209 |
| 51 | 2258 |

Each following row names **two files**, `packages/sdk/src/orchestration_1_0_<suffix>/agents.ts`
and `/turn.ts`, with their exact switch lines:

| Directory suffix | agents.ts | turn.ts |
|---|---|---|
| 52 | 517 | 418 |
| 53, 54 | 539 | 425 |
| 55 | 539 | 472 |
| 56 | 539 | 789 |
| 57 | 539 | 803 |
| 58 | 539 | 801 |
| 59 | 547 | 832 |
| 60 | 547 | 847 |
| 61 | 547 | 850 |
| 62, 63 | 547 | 850 |
| 64 | 557 | 850 |
| 65 | 557 | 853 |
| 66 | 593 | 853 |
| 67 | 593 | 893 |
| 68 | 609 | 896 |
| 69 | 609 | 1012 |
| 70 | 609 | 1029 |
| 71 | 609 | 1052 |
| 72, 73, 74, 75, 76 | 609 | 1096 |
| 77, 78 | 646 | 1097 |
| 79 | 647 | 1097 |

### Q11. Activity routing, registration and worker tags

`packages/sdk/src/activity-routing.ts` is 51 lines. Its full existing content is in Appendix A.
The handoff names are `runTurnV3`, `runTurnEpochV3`, and V2 names for agent resolution/spawn/status/list
(`:8-16`). Without a contract, the original name is retained (`:18-20`). Handoff routing uses
`withTag("pilotswarm.agent-handoff.v2")`; workspace routing uses
`withTag("pilotswarm.workspaces.v1")` (`:22-45`). Missing `.withTag` throws the exact routing-support
error. Registration retains both legacy and current names (`:48-51`).

`createSessionProxy().runTurn` selects routed runTurn/runTurn2, schedules on the affinity key, then
applies workspace or handoff routing (`session-proxy.ts:696-776`). The two runTurn registrations use
`registerHandoffActivity` (`:4649-4652`); the Stop abort activity remains a plain registration
(`:4660-4676`) and affinity-bound schedule (`:823-833`). `registerActivities` is called once per worker
with that worker's SessionManager/catalog (`worker.ts:893-921`).

The worker passes tags in Duroxide Runtime options:
`workerTagFilter: { defaultAnd: [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY] }`
(`worker.ts:853-863`, specifically `:854`). Current orchestration routing-contract adoption begins with
the named-agent handoff contract; no new turn-control tag or V4 routing names exist at this SHA.

### Q12. CMS provider/method surface, call sites and migrations

**Provider interface and method inventories.**

| Surface | Existing definition |
|---|---|
| Full catalog interface | `SessionCatalog`, `packages/sdk/src/cms.ts:952-1437` |
| PostgreSQL implementation | `PgSessionCatalog implements SessionCatalog`, `cms.ts:1561`; aliases `SessionCatalogProvider` / `PgSessionCatalogProvider` at `:4203-4206` |
| Factory interface | `RuntimeStorageProvider.createSessionCatalog(args: RuntimeStorageConfig): Promise<SessionCatalog>`, `storage-providers.ts:17-28` |
| Implementing factories | PostgreSQL `storage-providers.ts:86-105`; HorizonDB `:107-120`; **both instantiate PgSessionCatalog** |
| Qualified SQL name map | `sqlForSchema`, `cms.ts:1447` onward; writeback/index names `:1492-1493` |
| Exported catalog types | SDK `index.ts:84-86` |
| Public management class | `management-client.ts`; Stop method `:2498-2553` |
| Web public management | `web/web-management-client.ts`; Stop `:108-110`; direct/web structural parity `:995-1033` |
| Public HTTP operation list | `packages/sdk/api/src/protocol.js`, Stop at `:105` |
| Generated operation methods | `web/generated-op-methods.ts`, Stop at `:1654-1660`, list/dispatch at `:173,:1955` |
| UI transport method lists | `api/src/http-api-transport.js:267-269`; `packages/app/tui/src/node-sdk-transport.js:1559-1564`; portal dispatch `runtime.js:1245-1246` |

There is no separately implemented web/direct **SessionCatalog** pair. Catalog methods are an internal
provider contract; public management operations have the separate management/HTTP/transport surfaces
listed above. The factory method list returns SessionCatalog rather than duplicating every catalog
method. The web management parity types derive public keys from the direct class; they are not a
manually repeated catalog-method list.

**Exact current signatures.**

```ts
// cms.ts:1157-1159,1306
updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;
setActiveTurnIndex(sessionId: string, turnIndex: number): Promise<void>;
completeTurnWriteback(input: CompleteTurnWritebackInput): Promise<void>;
```

`CompleteTurnWritebackInput` extends `InsertTurnMetricInput` (`cms.ts:40-67`): session/agent/model/
reasoning, turnIndex, start/end/duration, input/output/cache tokens, tool counts/errors, result/error/
worker plus toolNames, state, lastActiveAt, lastError, waitReason and currentIteration.
`SessionRowUpdates` is an **interface**, not a Pick (`cms.ts:233-250`); it allows orchestration/title/
state/model/reasoning/context/model-source/activity/iteration/error/wait/system/agent/splash fields.
It has no activeTurnIndex or new turn-control fields.

`setActiveTurnIndex` implementation is `cms.ts:1858-1863`; its production caller is
`session-proxy.ts:4011`. `completeTurnWriteback` implementation is `cms.ts:2777-2806`, with 23 positional
procedure arguments; production caller is `session-proxy.ts:4408`. The real-catalog integration test
calls writeback in `test/local/cms-turn-metrics.integration.test.js:170-209`.

**Catalog test doubles.** These are partial JavaScript objects, not independently complete
SessionCatalog implementations. Whether a test needs a new method depends on its actual call path.
The two shared runtime harnesses relevant to turn execution are:

| Double | Existing members / scope |
|---|---|
| `test/helpers/run-turn-activity-harness.mjs:31-36` | getSession, recordEvents, upsertSessionMetricSummary, updateSession; no setActiveTurnIndex or completeTurnWriteback |
| `test/helpers/parent-child-handoff.mjs:79-86` | Includes noop setActiveTurnIndex (`:83`); shared parent/child harness |
| `test/local/stop-turn.test.js:255-272` | Management `_catalog` has getSession only (`:264-266`) |
| `test/local/contracts.test.js:120` | createNoopSessionCatalog |
| `test/local/enhanced-tool-gating.test.js:97-106` | noopCatalog with reads/events/summary methods |
| `test/local/session-proxy-events.test.js:36` | Activity event-projection catalog |
| `test/local/worker-provider-lifecycle.test.js:40` | initialize/close lifecycle stub |
| `test/local/feature-worker.test.js:17` | workerHeartbeat/close stub |

Other catalog literal/factory sites found by explicit-SHA search (all relative to `packages/sdk/`):
`test/local/agent-package-install-layout.test.js:33`, `agent-tuner.test.js:140`,
`base-agent-policy-adversarial.test.js:68`, `capability-session-lifecycle.test.js:31`,
`child-cleanup.test.js:239`, `cross-session-messaging.test.js:22`, `facts.test.js:241`,
`feature-session-tools.test.js:22`, `model-providers-reload.test.js:149`,
`native-subagents-runtime.test.js:190`, `prompt-attachments.test.js:125`,
`provider-budgets-adversarial.test.js:894`, `resourcemgr-tools.test.js:86`,
`spawn-tree-visibility.test.js:39`, `system-agent-bootstrap.test.js:88,124`,
`system-copilot-key.test.js:24`, `system-session-restart.test.js:57`;
`test/unit/agent-authoring-tools.test.mjs:234,243,258,278,366`,
`canvas-app-catalog.test.mjs:101`, `distiller-tools-gate.test.mjs:18`,
`inspect-viewer-spine.test.mjs:38`, `manager-tool-gating.test.mjs:37`,
`provider-credentials.test.mjs:241`, `provider-surface-parity.test.mjs:453`,
`session-agent-binding-lifecycle.test.mjs:271,500`, `top-level-agent-binding.test.mjs:17`.
`test/helpers/cms-helpers.js:16` and the canvas/live-plane helpers create real catalogs instead.

**Migrations.** `CMS_MIGRATIONS(schema)` begins `cms-migrations.ts:20`; registry tail is
`:402-408` and latest migration is **0081 model_event_logging_flag**. Registration creates ordered
`{version,name,sql}` entries, including imported SQL builders. `runCmsMigrations` passes that list to
shared advisory-lock runner (`cms-migrator.ts:8,20-21`); `PgSessionCatalog.initialize` invokes it
(`cms.ts:1625-1629`). Companion documents use `packages/sdk/src/migrations/NNNN_diff.md`; 0024's
turn-index/writeback delta is `0024_diff.md:9-23`.

Migration/procedure-sensitive tests:

| Test | Existing assertions |
|---|---|
| `test/unit/cms-migrations-shape.test.mjs:20-27` | Sorted unique versions, registered/name of 0028; **no fixed total migration-count assertion** |
| Same test `:46-74` | List/page return-column parity and DROP before shape change |
| `test/local/pg-migrator.test.js:25-61` | Applied 0013 and named bounded event-read procedures |
| `test/local/cms-event-type-filter.test.js:4,205-206` | Four-argument event-read overload behavior/fallback |
| `test/local/feature-model-event-logging-catalog.test.js:2,45` | 0081 logging catalog publication |
| `test/local/provider-budgets.test.js:1919` | Selects migration 0070 |
| `test/local/provider-legacy-key-migration.test.js:23,130,145` | Selects migration entries for provider legacy keys |
| `test/local/session-group-placement-migration.test.js:99,190` | Selected migration fixtures |
| `test/unit/footprint.test.mjs:257-259` | Selects 0035 and checks footprint procedure registration |

### Q13. Latest writeback/update SQL and return values

Appendix B contains the **full latest** `cms_complete_turn_writeback` definition, from migration 0024
(`cms-migrations.ts:7235-7334`). It takes 23 parameters and `RETURNS VOID` (`:7259`); updates sessions
and clears active_turn_index (`:7266-7274`), accumulates session metrics (`:7276-7292`), inserts a turn
metric (`:7294-7306`) and completion event (`:7308-7332`). `cms.ts:2777-2806` awaits SELECT and ignores
returned rows, matching `Promise<void>`.

Appendix C contains the **full latest** `cms_update_session`, from migration 0059
`provider_authoritative_routing` (function starts at `cms-migrations.ts:12660`; SQL at
`:13007-13040`). It `RETURNS VOID` (`:13010`), explicitly reads supported JSON keys, clears active index
on supplied non-running state (`:13029`), and mirrors model/reasoning into session_metrics
(`:13033-13038`). `PgSessionCatalog.updateSession` serializes its explicit allowed-field map, skips an
empty map, calls SELECT and ignores returned rows (`cms.ts:1831-1856`).

Neither procedure currently returns a business value, Boolean publication result, or control rows.
Source function order is not migration order: latest definitions are selected from registered
migration versions, not from whichever declaration appears last in the TypeScript file.

### Q14. Feature definitions, defaults, reads and bootstrap

There is no existing `sessions.steering` flag. `FEATURE_FLAGS` owns three definitions:
`copilot.native_tasks`, `agents.base_v2`, `debug.enable_model_event_logging`
(`feature-flags.ts:2-24`). All default disabled; current code defaults allow user override.
`FeatureKey` derives from the registry (`:25`). Callers must choose `{fallback:boolean}` or
`{required:true}` (`:26,55-64`); cluster policy, allowed user preference, then published defaults decide
the value (`:66-71`). Unknown keys have an explicit resolution path (`:53,62-64`).

Migration 0077 creates the feature catalog/settings (`migrations/feature-flags-0077.ts:5-29`) and
initially seeded native-task override disabled. Migration 0078 publishes default disabled /
override allowed and inserts the initial cluster setting only if missing
(`migrations/native-tasks-default-policy-0078.ts:5-18`). Existing saved cluster settings are not
overwritten by that insert. Registry tail is `cms-migrations.ts:402-406`.

`FeatureStore` is the procedure adapter (`feature-store.ts:18-109`, calls `:55-63`, revision/snapshot
`:68-72`, reads `:73-87`, mutations `:89-102`). `FeatureFlagCache` resolves against its cached snapshot
(`feature-flag-cache.ts:30-40`), reports supported keys (`:43-46`) and polls revisions/refreshes
(`:48-102`), with stop at `:103`. Worker creates/refreshed cache at `worker.ts:722-725`, uses it through
SessionManager, and refreshes on its configuration clock (`:1282-1294`; default clock 20,000 ms unless
positive package-refresh interval). Native-task runtime consumption is
`session-manager.ts:2300-2309`; model logging consumption is `session-proxy.ts:3798-3801`.

Public management reads are `management-client.ts:4921-4924`; web variants are
`web/web-management-client.ts:774-776`. HTTP feature descriptors are
`packages/sdk/api/src/protocol.js:251-263`; portal dispatch is `packages/app/web/runtime.js:1024-1040`.
The shared admin UI independently reads personal/cluster/user flags
(`packages/app/ui/core/src/controller.js:3973-3995`).

**Portal bootstrap does not expose feature flags/effective steering policy.** Full
`PortalRuntime.getBootstrap()` return at `runtime.js:619-656` contains mode, worker/log/model catalog,
creatable agents, creation policy and authz. Feature reads are separate management calls. Documentation:
`docs/api/reference.md:367-385`; implementation writeup
`docs/models/feature-flighting-implementation-2026-09-09.md`; original design
`docs/proposals/feature-flighting.md`.

### Q15. Worker lifecycle and dependency injection

| Start order (`packages/sdk/src/worker.ts`) | Source |
|---|---|
| Resolve storage/concurrency, create selected runtime provider | `:662-683` |
| Create/initialize CMS catalog; bounded startup retry | `:700-720` |
| Create and initially refresh feature cache | `:722-725` |
| Provider bootstrap/routing | `:743-757` |
| Facts, enhanced embed lifecycle, graph | `:762-817` |
| Pass facts/graph to manager, refresh packages | `:825-836` |
| Pass catalog to manager and finish associated configuration | `:839-845` |
| Inspect client; Runtime options/tags; instantiate Runtime | `:850-865` |
| Register activities with manager, catalog, provider, full storage/config and artifact store | `:893-921` |
| Register every frozen/current orchestration version | `:923-929` |
| Register runtime tools | `:931-985` |
| Start Runtime and await native initialization | `:987-995` |
| Eviction/configuration polling; nonblocking provider/system reconciliation | `:1000-1033` |

`stop()` first sets stop-requested, stops polling/timers/cache/histogram (`:1035-1050`), awaits runtime
startup and shuts Runtime down (configured budget, default 5,000 ms, `:1051-1066`), waits provider
reconciliation (`:1069`), shuts SessionManager down (`:1070`), then closes catalog/facts/graph and
clears provider/started (`:1071-1091`). It deliberately does not stop the fleet-wide durable embedder
(`:1075-1083`). Graceful drain is a separate method whose comments changed at `:1095-1101`.

Catalog creation goes through configured provider factories, which resolve the CMS URL and call
`PgSessionCatalog.create` with schema/auth settings (`storage-providers.ts:89-95,114-120`).
`cms.ts:1588-1622` builds a `pg.Pool` using `buildPgPoolConfig`, default max 3 with
`PILOTSWARM_CMS_PG_POOL_MAX` override, and 10,000 ms connection timeout.

`buildSessionCatalogPgClientConfig(options,env): ClientConfig` resolves the same CMS target and builds
normal auth/SSL configuration, then removes pool `max` (`pg-pool-factory.ts:218-233`). It is exported at
`index.ts:78`, used by the portal's `buildListenConnection` (`server.js:104-106`), and not currently
used by the worker. The worker has no dedicated listener.

`registerActivities` receives SessionManager, sessionStore and optional SessionCatalog directly
(`session-proxy.ts:1155-1194`). The closure captures those per-worker instances for handlers; it also
receives complete target/configuration metadata. There is no existing per-worker TurnControlHub
parameter or object.

### Q16. Event subscription, IDs, send shape, idle and existing fakes

Catch-all SDK subscription is `managed-session.ts:3312-3384`. It normalizes event type and
`event.data ?? event`, clones object data and enriches known tool metadata. CapturedEvent holds only
`{eventType,data}`. The code does **not explicitly copy a top-level SDK event ID into captured data**;
an existing `data.messageId` is preserved. It does not currently install a user.message-confirmation
watcher. Native-child events are namespaced/isolated (`:3366-3379`). Result inclusion/observer forwarding
occurs at `:3493-3503`.

Exact idle settlement (`managed-session.ts:3553-3562`):

```ts
// session.idle = turn finished (normal completion or post-abort)
unsubscribers.push(
    this.copilotSession.on("session.idle", (event: any) => {
        if (isNativeChildEvent(event)) return;
        flushStreamingProgress(true);
        publishReasoningSnapshot("session.idle", true);
        liveTurn?.finishTurn();
        resolve();
    }),
);
```

The promise stores its resolver at `:3307-3310`, so force-settle and parent session.idle resolve the
same wait. The first send is awaited at `:3641-3655`, with this object shape:

```ts
await this.copilotSession.send({
    prompt: effectivePrompt,
    ...(effectivePrompt !== prompt ? { displayPrompt: prompt } : {}),
    ...(opts?.requiredTool ? { requiredTool: opts.requiredTool } : {}),
    ...(opts?.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments.map((a) => ({
                type: "blob" as const,
                data: a.data,
                mimeType: a.mimeType,
                ...(a.displayName ? { displayName: a.displayName } : {}),
            })),
        }
        : {}),
});
```

No `mode` is supplied and the return value is not retained as a confirmation ID. Correction sends
at `:3673-3696` and `:3717-3746` arm their next-idle watcher first (`:3612-3624`). Cleanup unsubscribes
at `:3805-3816`. Installed Copilot send typings are outside Git and remain open; appendix 10.1 of the
proposal supplies spike observations, not full model-provider coverage.

**Fake Copilot sessions are predominantly local Vitest fixtures, not under test/unit.**

| Path (relative to `packages/sdk/`) | Existing fake capability |
|---|---|
| `test/local/stop-turn.test.js:30-66` | Factory `createFakeCopilotSession`, catch-all/typed listeners + unsubscribe/manual emit, sends array, abort/disconnect counters, optional abortFiresIdle; send returns no ID |
| `test/local/managed-session-reasoning.test.js:4-61` | Fake class with registered tools, typed/catch-all events, scripted message/reasoning/idle, noop abort |
| `test/local/turn-inactivity-watchdog.test.js:15-56` | Event listeners; onSend hook defaults to silence, abort flag; fake-time tests |
| `test/local/native-subagents.test.js:67-86` | Tasks RPC list/cancel/remove; event agentId; abort emits idle |
| `test/local/turn-result-events.test.js:26-65` | Script-driven fake, tool registration, typed/catch-all listeners, manual emit, script on send |
| `test/local/prompt-attachments.test.js:25-67` | Records full send options, emits assistant message/idle, listener cleanup |
| `test/local/inline-control-tools.test.js:6` onward | Scripted tool calls/events/sends, registered tools, listeners and abort flag |
| `test/local/cron-tool.test.js:5` onward | Scripted registered tool calls, assistant result/idle and abort flag |
| `test/local/contracts.test.js:173-234` | Registered-tool snapshots, script calls/events and abort |
| `test/local/session-policy-behavior.test.js:216-267` | Scripted tool execution and listener/abort fake for policy behavior |
| `test/local/copilot-client-start.test.js:24-31` | Connection holder plus process/start/create/resume fake client; not a turn-event simulator |
| `test/local/enhanced-tool-gating.test.js:109-122` | Tool registration snapshots, noop event/send/abort; fake client creates/resumes it |
| `test/local/permission-contracts.test.js:7-24` | Empty session, config-capturing fake client |
| `test/local/session-manager-lock.test.js:7-23` | Empty session, create/resume fake with controllable gate |

`test/local/native-subagents-runtime.test.js` uses the **real SDK/CLI with a synthetic model backend**;
it is not a fake CopilotSession. None of the mapped fakes establishes real send-mode/message-ID
semantics for GitHub Copilot or Anthropic.

### Q17. Orchestration versions, budgetStash and CMS state propagation

Current latest version is **1.0.80** (`orchestration-version.ts:15`), compatibility floor **1.0.47**
(`:16`), minimum workspace version **1.0.80** (`:22`). Registry imports frozen monoliths 47-51,
frozen directories 52-79, and current 80 from `orchestration/index.js`
(`orchestration-registry.ts:2-35`); registered list is `:40-78`.
Older 26-46 monoliths exist in the tree but are not in the active registry. Frozen 52-79 directories
contain agents/index/lifecycle/queue/runtime/state/turn/utils modules; there is no frozen 80 directory.
Tests pin this layout/version: `test/unit/agent-handoff-routing.test.mjs:56-63`,
`test/unit/orchestration-freeze-1-0-71.test.mjs:34,56,61,105`; live upgrade cases in
`test/local/orchestration-version-upgrade.test.js:116-187`.

**Complete current budgetStash lifecycle** (nonfrozen code):

| Source | Operation |
|---|---|
| `types.ts:1047` | Optional CAN input array: prompt, client IDs, required tool, attachments, sender |
| `orchestration/state.ts:125-136` | Required state field; documents already-recorded gate-refused prompts |
| `state.ts:473` | Initialize from input or null |
| `turn.ts:336` | Required-tool fallback from first stash entry with one |
| `turn.ts:448` | Sanitize merged stash attachments |
| `turn.ts:464-469` | Pass stash strings and separate attachment refs to activity |
| `turn.ts:1040-1111` | Stash function, excludes internal wake prompts, deduplicates by client IDs or prompt (`:1053-1065`), preserves tool/attachments/sender, records user.message unless alreadyRecorded (`:1083-1097`), assigns stash (`:1099-1106`) |
| `turn.ts:1319-1320` | Clear once a result is past gates |
| `lifecycle.ts:590` | Carry nonempty stash into CAN |
| `session-proxy.ts:1964-1979` | Fold stash in front of ordinary prompt, or use it without internal gate wake text |

Full CAN input builder is `orchestration/lifecycle.ts:510-612`: iteration `:538`, prompt `:557`,
retryCount `:584`, budgetStash `:590`, explicit overrides last `:611`.
`versionedContinueAsNew` captures active timer state and continues at latest version (`:631-661`).
The existing input has no proposed controlHigh/carriedSteers cursor state.

Current state activity signature and propagation:

```ts
// session-proxy.ts:1085-1093
updateCmsState(sessionId: string, state: string,
               lastError?: string | null, waitReason?: string | null)
```

The proxy includes lastError/waitReason only when not undefined, and schedules `updateCmsState`.
The registered handler copies state and explicit optional error/wait keys, then critical-retries
`catalog.updateSession` (`session-proxy.ts:5723-5738`). That method's explicit field serialization
(`cms.ts:1831-1856`) sends JSON to `cms_update_session` (Appendix C). No generic options parameter,
preserve-active-index flag or new control state flows through this existing path.

Current calls to the state activity: `orchestration/agents.ts:390,424,499`,
`orchestration/runtime.ts:84,91,118`, `orchestration/turn.ts:240,259,291,557,759,1594,1624`.

### Q18. Client surfaces, Stop button, transcript and documentation inventory

| Surface | Existing path |
|---|---|
| Direct management | `packages/sdk/src/management-client.ts:2498-2553` |
| Web management | `packages/sdk/src/web/web-management-client.ts:108-110` |
| Canonical HTTP descriptor | `packages/sdk/api/src/protocol.js:105`: POST `/management/sessions/:sessionId/stop-turn`, session:write, sessionId path, options body |
| HTTP route registration | `packages/app/web/server.js:297` mounts `/api/v1`; `web/api/router.js:198-218` generates all operation routes and calls `runtime.call(op.name,params,req.auth)` |
| Portal dispatch | `packages/app/web/runtime.js:1245-1246` delegates transport Stop |
| HTTP UI transport | `packages/sdk/api/src/http-api-transport.js:267-269` |
| Direct UI transport | `packages/app/tui/src/node-sdk-transport.js:1559-1564`, reason default Stopped by user |
| Generated typed op | `packages/sdk/src/web/generated-op-methods.ts:1654-1660` |
| MCP | `packages/app/mcp/src/tools/turn-control.ts:22-42`, `stop_turn`, reason/timeout, management delegate |
| UI command | `packages/app/ui/core/src/commands.js:75` STOP_TURN=stopTurn; controller dispatch `:11326` |
| Shared Stop controller | `ui/core/src/controller.js:10716-10749`, supports no-active/timeout/error/status outcomes and refresh |
| Can-Stop selector | `ui/core/src/selectors.js:1698-1701`, true for running non-group, user or system |
| Portal composer | `ui/react/src/web-app.js:9690-9695` state/callback; button `:9874-9885` |
| TUI input | `packages/app/tui/src/app.js:272-279`, Ctrl+X or Ctrl+Esc |
| TUI status/help | `ui/core/src/selectors.js:6034` ctrl-x stop; `:9361` ctrl-x (ctrl-esc) help |

**CLI command distinction.** App bins `pilotswarm` and `pilotswarm-cli` both use
`tui/bin/tui.js` (`packages/app/package.json:19-23`). That entrypoint branches only for `auth` and
`agents`, then otherwise starts TUI (`tui/bin/tui.js:7-33`). No dedicated Stop subcommand exists there
or in its command routing. The existing CLI-facing Stop operation is the **interactive TUI shortcut**,
not a `pilotswarm stop` command.

**Transcript rendering is shared between TUI and portal.** `ui/core/src/history.js:22-55` is the
transcript allowlist. Bulk user-message construction is `:1331`, live user-message construction
`:1454-1487`, and the common constructor is `:575` onward. Stop uses persisted
`session.turn_stopped`: bulk reconciliation at `:1326`, live reducer `:1433-1451` marks matching
client-message IDs stopped and clears the live turn. The Stop handler also records a system message
(`orchestration/turn.ts:744-756`), rendered via `history.js:1523-1535`. Turn completion/live clearing is
`:1520-1522`. Delivery glyph/header rendering is `selectors.js:2145-2220`; stopped delivered messages
use the stopped marker (`:2204-2209`).

There is no current user.steer/control_outcome transcript case. Existing tests include
`packages/app/ui/core/test/stopped-prompt.test.mjs`, live-turn-streaming tests, and portal
`packages/app/web/test/e2e/mobile-header-status.spec.mjs:30,125` for Stop route invocation.

| Documentation surface | Existing Stop reference |
|---|---|
| Canonical API | `docs/api/reference.md:155`, Stop method |
| Canonical portal guide | `docs/user-guide/portal.md:164-168,603`, button/session-alive behavior |
| MCP README | `packages/app/mcp/README.md:386`, stop_turn |
| Orchestration design | `docs/architecture/orchestration/design.md:379` |
| CMS schema | `docs/architecture/internals/cms-schema.md:48`, active index |
| System reference | `docs/architecture/system-reference.md:232`, abort primitive |
| Prior Stop plan | `docs/proposals-impl/stop-button-turn-abort-plan.md` |
| MCP parity proposal | `docs/proposals/mcp-web-api-parity.md:103` |
| TUI maintenance skill | `.github/skills/pilotswarm-tui/SKILL.md:121`, retained mobile Stop |
| New design | `docs/proposals/session-turn-control.md:651-682,901-929`, proposed new surfaces |

Case-insensitive searches of `templates/builder-agents/` and `examples/devops-command-center/` found no
concrete stop_turn / stopSessionTurn / stop-turn / Stop-a-turn operation documentation. Generic prose
about stopping work is not a Stop API surface. The canonical keybinding page does not currently list
the shortcut; shared status/help code above does.

### Q19. Existing tests, discovery, fault injection and HorizonDB routing

**No SUITES array exists at this candidate.** `scripts/run-tests.sh:1110-1118` discovers filtered
SDK local/Horizon integration test filenames. Unfiltered full run invokes stages for deployment,
MCP, SDK unit, app, Horizon provider and external packages, then SDK Vitest (`:1144-1153`).
SDK `package.json:53` test:local invokes Vitest without an explicit file list; config
`vitest.config.js:12-17` discovers `test/local/**/*.test.js`, fork pool, fileParallelism true,
default eight workers (`:6-7`), 300,000 ms test / 120,000 ms hook timeout. Runner default is also eight
(`run-tests.sh:189`, export `:1022`).

SDK tests under **`test/unit/*.test.mjs` use Node test** (`package.json:62`); API tests under
`api/test/*.test.mjs` use Node test (`:58`); local behavior tests use Vitest (`:53`).
Existing target locations:

| Coverage | Files |
|---|---|
| Fake Stop/classification/management/race | `packages/sdk/test/local/stop-turn.test.js:88-381` |
| Real Stop | `packages/sdk/test/local/stop-turn-live.test.js:175-187` |
| CMS atomic writeback | `packages/sdk/test/local/cms-turn-metrics.integration.test.js:170-209` |
| Snapshot filesystem and lifecycle | `snapshot-protocol-fs.test.js`; `turn-lifecycle.test.js:78-536` |
| Crash boundary matrix | `fault-injection-live.test.js:62-253` |
| Multiworker/crash/chaos | `multi-worker.test.js:420-441`; `chaos.test.js:298-316`; `reliability-crash.test.js:223-235` |
| Event-volume filtering | `turn-result-events.test.js`; `session-proxy-events.test.js`; CMS event-type tests |
| Versioning/routing | `test/unit/agent-handoff-routing.test.mjs:56-63`; freeze and local upgrade tests in Q17 |
| Shared UI Stop | `packages/app/ui/core/test/stopped-prompt.test.mjs`; portal mobile-header test in Q18 |

`fault-injection.ts:1-42` parses `<point>[:exit|throw[:afterHits]]`; armed exit uses code **137**.
Snapshot fault points and exact lines are in Q9. `test/helpers/kill-harness.js:1-148` forks actual
workers; `fault-injection-live.test.js:62-148` drives kill/recover and `:150-253` asserts the matrix.
This activity ran none of those commands.

**HorizonDB includes CMS.** `--with-horizondb` / `--with horizondb` use standalone Horizon config and
route CMS, orchestration, facts and graph to HDB (`run-tests.sh:177-187,980-1009`).
`scripts/test-provider-plan.mjs:6-39` clears conflicting routing variables, requires HORIZON_DATABASE_URL,
normalizes SSL compatibility, retains plain DATABASE_URL only as a negative-control PLAIN_DATABASE_URL,
sets DATABASE_URL/HORIZON_DATABASE_URL/HORIZON_GRAPH_DATABASE_URL to the HDB target and runtime provider
to horizondb. Horizon SDK discovery defaults every local file in until excluded by the reviewed
coverage JSON (`:42-53`). `--all-providers` keeps one stock baseline then additive HDB coverage.

HDB's CMS factory still returns **PgSessionCatalog** (`storage-providers.ts:114-120`), not an
EnhancedFactStore catalog. No dedicated `LISTEN` implementation exists in `packages/horizon-store/src`
or SDK worker source. This absence does not establish real HDB LISTEN support or lack of support.
The binding proposal explicitly leaves C3 HDB listener testing open
(`session-turn-control.md:1126`). The portal's existing PostgreSQL listener is source-mapped in Q7.

### Q20. New identifiers at candidate and base

Explicit-SHA `git grep` in candidate source, excluding `docs/proposals/session-turn-control.md`, finds
no `turn_high`, `user.steer`, `control_outcome`, `pilotswarm_turn_control`, `TurnControlHub`,
`sendSteer` or `runTurnV4`. `sessions.steering` is proposal-only.
The base `12dfd3ee95642fca9e3a4acb84befda8d9e96c2d` likewise has no implementation of those identifiers.
The candidate/base searches use pinned objects, not current mutable main.

Plain `steer` has incidental prose/comments (other proposals, a portal comment at
`packages/app/ui/react/src/web-app.js:8640`, builder language about steering into named agents);
these are not Steer runtime/API implementations. A broad regex for immediate-send language also
matches unrelated checked-in corpus prose; exact turn-control searches and send-site reads distinguish it.

The proposal alone specifies R1-R7 (`:62-72`), T1-T9 (`:172-184`), migration 0082 (`:495-509`),
new procedures (`:518-649`), TurnControlHub (`:684-727`), LiveTurn (`:729-761`), send gate
(`:763-788`), runTurnV4 (`:790-853`), orchestration 1.0.81 (`:867-899`) and D1-D5 (`:1110-1118`).
Current source remains at migration 0081 and orchestration 1.0.80. These proposal locations are context,
not claims that any of their described code exists.

## Code References

- `packages/sdk/src/session-proxy.ts:696-776` — runTurn scheduling, input shape, routing.
- `packages/sdk/src/session-proxy.ts:1582-1583` — per-session run-turn lock around the whole activity.
- `packages/sdk/src/session-proxy.ts:1632-1647` — already-committed return (no CMS turn writes).
- `packages/sdk/src/session-proxy.ts:1754-1780` — budget gate wait/error returns.
- `packages/sdk/src/session-proxy.ts:2177-2186` — turn sentinel write.
- `packages/sdk/src/session-proxy.ts:3774-3782` — cooperative cancel poll.
- `packages/sdk/src/session-proxy.ts:3996-4013` — `state=running` + `setActiveTurnIndex`.
- `packages/sdk/src/session-proxy.ts:4364` — `cancelled` return before writeback.
- `packages/sdk/src/session-proxy.ts:4405-4446` — `completeTurnWriteback`.
- `packages/sdk/src/session-proxy.ts:4513-4575` — snapshot commit and return.
- `packages/sdk/src/session-proxy.ts:4654-4676` — `abortTurn` activity.
- `packages/sdk/src/session-lifecycle.ts:239-334` — preamble; `:358-469` commit.
- `packages/sdk/src/snapshot-protocol.ts:29-30`, `:220-246` — protocol files.
- `packages/sdk/src/orchestration/turn.ts:446`, `:493-499`, `:549-597`, `:650-651`, `:707-780`, `:1577-1597`, `:1618-1660`.
- `packages/sdk/src/orchestration/lifecycle.ts:499-506`, `:510-612`, `:631-661`.
- `packages/sdk/src/orchestration/queue.ts:700-735`.
- `packages/sdk/src/management-client.ts:2498-2553` — `stopSessionTurn`.
- `packages/sdk/src/session-manager.ts:1713-1781` — `abortWarmSessionTurn`.
- `packages/sdk/src/managed-session.ts:1458-1523`, `:3553-3562`, `:3641-3663`, `:3805-3846`.
- `packages/sdk/src/cms-migrations.ts:7093-7333` — migration 0024; `:13007-13040` latest `cms_update_session`.
- `packages/app/web/api/live-plane.js:93-154`; `packages/app/web/api/canvas-plane.js:45-131`.
- `packages/sdk/src/pg-pool-factory.ts:200-233`.
- `packages/sdk/src/worker.ts:98-130`, `:852-863`.
- `duroxide:src/runtime/dispatchers/worker.rs:307-325`, `:550-618`, `:792-875`.
- `duroxide:src/providers/mod.rs:1772-1897`; `duroxide:src/providers/sqlite.rs:1975-2003`.
- `duroxide:src/lib.rs:2168-2265`; `duroxide:src/runtime/replay_engine.rs:142-182`.
- `packages/sdk/src/fault-injection.ts:25-42`; `packages/sdk/test/helpers/kill-harness.js`.

## Architecture Documentation

- **Activity is the unit of durability.** The turn, its CMS projection and its snapshot commit all live in
  one `runTurn` activity under one in-process per-session lock (`session-proxy.ts:1583`); the orchestration
  sees only the returned `TurnResult` (`session-lifecycle.ts:1-10`).
- **Store-wins reconcile.** One probe per turn decides warm/hydrate/fresh/already-committed; the turnKey
  makes commit retries idempotent (`snapshot-protocol.ts:64-69`); the commit file carries the result so a
  redelivered attempt can return it.
- **CMS writes are best-effort projections.** Activity-side CMS writes use `cmsRetryBestEffort` (one retry,
  swallow) except `updateCmsState`/`cancelSession` which use `cmsRetryCritical` (`cms-retry.ts:1-24`;
  `session-proxy.ts:5733-5737`).
- **The inspected turn-state/writeback adapters use stored procedures** with numbered migrations and
  `NNNN_diff.md` companions. Later migrations redefine procedures with `CREATE OR REPLACE`.
  Existing canvas writes also contain inline SQL (`cms.ts:2406-2479`); the turn mapping does not imply
  that every existing catalog query is procedure-only.
- **Turn-scoped channels.** Stop uses a per-index queue so a stale event cannot win a later index's race
  (`types.ts:1700-1709`).
- **Orchestration versioning.** Latest handler `1.0.80` (`orchestration-version.ts:15`), registered with
  frozen predecessors (`orchestration-registry.ts:70-77`); worker capability tags gate new activity
  contracts during rolling deploys (`activity-routing.ts:1-45`).
- **Naming note.** `packages/sdk/src/live-turn.ts` already exports `LiveTurnPayload`,
  `LiveTurnCoalescer` and `LatestValuePublisher` (streaming text snapshots), distinct from the design's
  proposed `LiveTurn` class.

## Open Questions

| ID | Question | Evidence limit / affected question |
|---|---|---|
| O1 | Exact installed Copilot SDK send options/return typing, last-model-call race and matching user.message ID on GitHub Copilot/Anthropic | Typings not in Git. Proposal `:1124,1140-1157` reports Azure Responses spike only; Q5/Q16 partially open |
| O2 | Node 0.2.1 cancellation bridge, whether Rust abort terminates a live JS handler, and attempt-count exposure | Proposal `:1179-1204` reports cancellation-token source wiring; external dependency and live behavior were not independently read/run; Q8 partially open |
| O3 | Production Duroxide PostgreSQL provider's current ack/renew fencing and internal LISTEN long-polling | Prior artifact supplies trait/SQLite evidence at a separate SHA, not current production provider evidence; Q8 |
| O4 | Effective omitted cancellation grace and session-lock settings through the deployed Node binding | Candidate worker settings are mapped, but omitted binding/runtime values were not observed; Q8 |
| O5 | Real HorizonDB behavior for a dedicated worker LISTEN connection/reconnect | No current worker listener; proposal C3 at `:1126` remains open; Q19 partially open |

The old portal configuration question is source-resolved by Q7/Q15. The old retry-backoff question is
resolved as a **path distinction**, not a runtime guess: returned errors reach writeback first; a throw
after active-index publication can enter retry without a clearing CMS write before exhaustion
(`session-proxy.ts:3996-4013,4405-4446`; `orchestration/turn.ts:549-597,274-318`).

**Coverage:** 20 numbered questions documented; **16 fully answered at source scope**, **4 partially
open** (Q5, Q8, Q16, Q19). There are **5 residual external/runtime questions**, listed above. The
research activity is complete; no implementation or live validation verdict is implied.

## Appendix A. Full activity-routing.ts

Verbatim `packages/sdk/src/activity-routing.ts:1-51` at the candidate:

```ts
/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Orchestrations 1.0.75 and later opt into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
export type ActivityRoutingContract = "agent-handoff-v2";
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
    getSessionStatus: "getSessionStatusV2",
    listChildSessions: "listChildSessionsV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(AGENT_HANDOFF_CAPABILITY);
}

/**
 * Session workspaces (1.0.80): the turns of a session that has, or had, a
 * workspace, and the checkWorkspace and releaseWorkspace activities, go only
 * to workers that declare this tag. During a rolling deploy, an older worker
 * would run such a turn in its own folder, and it lacks the two activities.
 * The tag stands for the handoff contract as well: every worker that
 * declares it also declares AGENT_HANDOFF_CAPABILITY.
 */
export const WORKSPACE_CAPABILITY = "pilotswarm.workspaces.v1";

export function routeWorkspaceActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Session workspaces require Duroxide activity tag routing support");
    }
    return task.withTag(WORKSPACE_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any, versionedHandler = handler): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], versionedHandler);
}
```

## Appendix B. Full latest cms_complete_turn_writeback

Verbatim embedded SQL from `packages/sdk/src/cms-migrations.ts:7235-7334`, migration 0024.
`${s}` is the migration's schema template variable, retained exactly.

```sql
CREATE OR REPLACE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        active_turn_index = NULL,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;
```

## Appendix C. Full latest cms_update_session

Verbatim embedded SQL from `packages/sdk/src/cms-migrations.ts:13007-13040`, migration 0059.

```sql
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId') ELSE orchestration_id END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title') ELSE title END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'      THEN (p_updates->>'titleLocked')::BOOLEAN ELSE title_locked END,
        state             = CASE WHEN p_updates ? 'state'            THEN (p_updates->>'state') ELSE state END,
        model             = CASE WHEN p_updates ? 'model'            THEN (p_updates->>'model') ELSE model END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort'  THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        context_tier      = CASE WHEN p_updates ? 'contextTier'      THEN NULLIF(BTRIM(p_updates->>'contextTier'), '') ELSE context_tier END,
        model_resolution_source = CASE WHEN p_updates ? 'modelResolutionSource' THEN NULLIF(BTRIM(p_updates->>'modelResolutionSource'), '') ELSE model_resolution_source END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'     THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ ELSE last_active_at END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'        THEN (p_updates->>'lastError') ELSE last_error END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'       THEN (p_updates->>'waitReason') ELSE wait_reason END,
        is_system         = CASE WHEN p_updates ? 'isSystem'         THEN (p_updates->>'isSystem')::BOOLEAN ELSE is_system END,
        agent_id          = CASE WHEN p_updates ? 'agentId'          THEN (p_updates->>'agentId') ELSE agent_id END,
        splash            = CASE WHEN p_updates ? 'splash'           THEN (p_updates->>'splash') ELSE splash END,
        splash_mobile     = CASE WHEN p_updates ? 'splashMobile'     THEN (p_updates->>'splashMobile') ELSE splash_mobile END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL ELSE active_turn_index END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metrics
       SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
           reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
           updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
     WHERE session_id = p_session_id
       AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql VOLATILE;
```
