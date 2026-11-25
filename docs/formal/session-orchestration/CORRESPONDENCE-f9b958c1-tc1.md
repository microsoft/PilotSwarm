# TurnCut (tc1) correspondence to f9b958c1

Workspace-moves M4 after #367: a runTurn attempt cut by a worker drain or by a lost activity lock, and its retry under
the same turnKey. Code at `f9b958c17f51b8e224de1c02bdc1730a94a9fdcb` (branch `fix/turn-cut-lost-lock`, based on main
`1f6af957`, PilotSwarm 0.8.18). Mode `"fix"` is this head. Mode `"main"` is bound to `ac86a39e` (0.8.16 and 0.8.17,
which include #367); its lines are marked **main**. Mode `"old"` is 0.8.15 and earlier (before #367); its lines are
marked **old**. Modes `"upgrade-main"` and `"upgrade-old"` run main's or the old code on worker A and this head on
worker B. Line numbers are at `f9b958c1` unless marked.

The batch was first bound to `2078582c`, the same fix on main `ac86a39e` (0.8.17). Between `ac86a39e` and `1f6af957`
(0.8.18), main's only source changes are outside the modelled paths: a session without native tasks gets no custom
agents (`session-manager.ts` 3408-3415 at this head), and doc comments in `types.ts`. The first moves the
`session-manager.ts` lines after it by four. Every bound line was re-read at `f9b958c1` and is unchanged;
`session-proxy.ts`, `session-lifecycle.ts`, `snapshot-protocol.ts`, `worker.ts` and `orchestration/turn.ts` are
unchanged. So 0.8.18 behaves as mode `"main"`.

| Model | Code | Label |
|---|---|---|
| `A1Cancel`: the drain deadline or a lost lock cancels the activity | `worker.ts` `gracefulShutdown` 1358-1361 `runtime.shutdown(drainBudgetMs)` cancels the activities still running at the deadline; duroxide cancels an activity whose lock was lost | Code behavior |
| `A1Latch`: the body latches the cancel; `localA' = "cut"` | the aborted body may have written part of the turn to the session's local dir | Model simplification |
| `A1Latch`, `MarkCut`, a lost lock: the fix marks the session | `session-proxy.ts` `latchCancelled` 4327-4331 calls `markTurnCut(sessionId, turnGeneration)` (`session-manager.ts` 4311-4313); its callers are the cancel poll 4332-4334 and the turn's own check `eligible()` 5014 | Code behavior |
| `A1Latch`, `MarkCut`, a drain: marked from **main** on | `session-proxy.ts` `throwIfDrainCut` 1737-1742 (marks 1739, throws `TURN_CUT_BY_SHUTDOWN_MESSAGE` 1741) and `runBody` 5400-5407 (a body that throws while the drain cancelled it marks 5404); unchanged from **main** | Code behavior |
| `A1Latch`, `MarkCut`, a lost lock, **main** and **old**: no mark | **main** `session-proxy.ts` the cancel poll sets `cancelled = true` only; **old** has no `cutTurns` | Code behavior |
| `Locked`: A holds the run-turn lock until `A1Return` | `session-proxy.ts` 2082 `withRunTurnLock` (`session-manager.ts` 2086) wraps the body and its commit; the mark is set inside it, before the lock is released | Code behavior |
| `A1Return`, `SkipCutCommit`, a lost lock: no commit, the sentinel stays dirty | `session-proxy.ts` 5265 the body returns `{ type: "cancelled" }`; 5448 `runTurnCommit`; `session-lifecycle.ts` `runTurnCommit` 427-439 (`isCancelledResult` 146-148) returns `unpublishedReason: "cancelled"`; `session-proxy.ts` 5449-5486 records `session.snapshot_unpublished` (the message at 5477-5478) | Code behavior |
| `A1Return`, `SkipCutCommit`, a drain: no commit | `session-proxy.ts` 5264 `throwIfDrainCut("before the CMS writeback")` throws before the return and the commit (#367, unchanged) | Code behavior |
| `A1Return`, **main** (a lost lock) and **old** (both): the cut body is saved under the turnKey with its cancelled result | **main** `session-lifecycle.ts` `runTurnCommit` commits every result but a stopped one (`commitTurnSnapshot` writes the turn-commit file with the result, 450, and CASes at `base + 1` under the turnKey, 456-459) | Code behavior |
| `A1Return`, `storeVer # 0`: nothing is written | `session-lifecycle.ts` `commitTurnSnapshot` 461-494 (the store reports this turnKey committed: the retry won) and 514-531 (a foreign version superseded the base) | Code behavior |
| `SdRelease`: skip a locked session and, with `ReleaseSkip`, a marked one | `worker.ts` 1382 `releaseIdleWorkspaces`; `session-manager.ts` 4170 filters out `sessionLocks` and `isTurnCut` | Code behavior |
| `SdSweep`: skip a locked session and, with `SweepSkip`, a marked one; else release its workspace, then reclaim | `worker.ts` 1402 `sweepIdleSessions(1)`; `session-manager.ts` 2124 (locks) and 2125 (`isTurnCut`); the workspace release 2137-2140; the dir 2142-2179 | Code behavior |
| `ReclaimA`: delete when the dir holds a committed marker or the store chain is versioned; else a legacy dehydrate publishes it; the mark is not cleared | `session-manager.ts` 2149-2152 (marker), 2153-2165 (`probeSnapshot`, versioned), 2166-2170 `_dehydrateUnlocked`; `_forgetTurnState` 2178 does not touch `cutTurns` (4196) | Code behavior |
| `markerA = ~first` | the marker of the last commit stays in the dir while a turn runs (`snapshot-protocol.ts` `writeTurnSentinel` 226 does not remove it); a first turn has none | Code behavior |
| `EvSweep`: without a drain, the eviction sweep may reclaim A's dir once the attempt returned, unless it is marked | `worker.ts` 1193-1194 the eviction clock's `sweepIdleSessions(evictAfterMs)`; it skips a cut session at `session-manager.ts` 2125 like the shutdown sweep; its workspace release is not tracked | Code behavior; the release is a model simplification |
| `A2Start` on B, also while the cut body still runs | duroxide schedules the retry once the activity is cancelled; the zombie body keeps running on A | Code behavior |
| `A2Start` on A: only after a lost lock, once the attempt returned; the fix clears the mark | `session-proxy.ts` 2085 `clearTurnCut` at the start of the run-turn lock body (`session-manager.ts` 4316-4318) | Code behavior |
| `A2Start`: resolve from the store (`loc2' = storeC`) | `session-lifecycle.ts` `runTurnPreamble` 263-361: a dirty sentinel (293) or no usable dir resolves from the store (`resolveFromStore` 222, called at 337 and 361) | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, `RecoverNoAdopt`: run the turn on top of it | `session-lifecycle.ts` 304 `recoverAlreadyCommitted`; 194-205 a cancelled result under this turnKey degrades to a hydrated re-run at the stored version | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, **main** and **old**: adopt it (`dropped`) | **main** `recoverAlreadyCommitted` returns `already-committed` with the stored result; `orchestration/turn.ts` 1609-1611 `case "cancelled"` only traces and returns | Code behavior |
| `A2Commit`, `storeVer = base2`: CAS at `base2 + 1` under the turnKey | `session-lifecycle.ts` `commitTurnSnapshot` 444-511 (the turn-commit file 450, the CAS 456-459); the store accepts `base + 1` under the same turnKey after the degrade | Code behavior |
| `A2Commit`, `storeVer # base2`, `CommitNoAdopt`: return its own result (`residual`) | `session-lifecycle.ts` 474-492: `adoptable` (478) excludes a cancelled result, so `storedResult` is omitted | Code behavior |
| `A2Commit`, **main** and **old**: adopt the stored cancelled result (`dropped`) | **main** `commitTurnSnapshot` returns `storedResult` for any readable result under this turnKey | Code behavior |
| one retry; the retry on A runs only after A's attempt returned and never beside a retry on B; no retry on A in the upgrade modes | the orchestration runs one attempt at a time per turn; in an upgrade A runs the older release, whose retry the `"main"` and `"old"` modes cover | Model simplification |
| no worker restart | `worker.ts` 743 `startGeneration` clears every mark (`session-manager.ts` 4282-4285) | Model simplification |
| `Inv_NoCancelledCommit`, `Inv_TurnNotDropped`, `Inv_NoAbortedHandOff`, `Inv_ShutdownKeepsCut`, `Prop_TurnRuns` | the requirements: a cut turn runs again, from the last committed snapshot, and the drained worker leaves the cut session as if its turn still ran | Rule to evaluate |
| `W_NoLingeringMark` | the documented cost: after a lost lock whose retry ran on B, A keeps the mark and its local copy until A restarts or the session returns to it (`CHANGELOG.md` Unreleased) | Rule to evaluate |

`Inv_ShutdownKeepsCut` is the rule `workspace-moves.test.js` M4 checks ("releases only what is idle"): the next worker
sees a dead holder and tells the turn its workspace may hold partial changes.

#364's shutdown cut (`session-proxy.ts` 5054-5059: a run that returns after this worker began shutting down marks the
session and throws `TURN_CUT_BY_SHUTDOWN_MESSAGE`) runs only after the manager's shutdown, after the release and the
sweep, and is not modelled. A turn that lost its Copilot runtime (#329, another branch) does not mark the session.

Bounds: one session, one turn, one cut attempt and one retry; the turn is a first or a later one, and the cut comes
from a drain or a lost lock (both chosen in `Init`).

Not modelled:

- an attempt that completes before its cancel lands (an ordinary commit);
- the orchestration's retry count and timers, and a second retry;
- a stopped turn (`runTurnCommit`'s stopped skip, 407-419);
- a worker restart (a new generation clears every mark);
- the workspace provider, the partial-changes note and the eviction sweep's own workspace release;
- the snapshot store's CAS beyond the turnKey rule (`TurnCommit.tla`, `SnapshotWarmDrop.tla`).

Test evidence (each fails at `ac86a39e`, with the three source files restored to main, and passed at `2078582c`; the
rebase changed neither these tests nor the code they cover):

- `packages/sdk/test/local/turn-lifecycle.test.js`: a cancelled attempt is not committed (the sentinel stays dirty)
  and its retry commits v2; a stored cancelled result is never adopted by recovery (the retry runs at base 2 and
  commits v3); a commit that finds one returns no `storedResult`; a lost lock marks the session with the attempt's
  generation, and each attempt clears the mark before it runs.
- `packages/sdk/test/unit/session-workspace-release.test.mjs`: a marked session is neither released by
  `releaseIdleWorkspaces` nor reclaimed by the sweep until `clearTurnCut`.

Not tested: the `session.snapshot_unpublished { reason: "cancelled" }` event (best-effort, as for `stopped`).
