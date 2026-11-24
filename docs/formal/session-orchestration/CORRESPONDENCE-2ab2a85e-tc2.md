# TurnCut (tc2) correspondence to 2ab2a85e

Workspace-moves M4 after #367, with the fixes from the review of #382: a runTurn attempt cut by a worker drain, a lost
activity lock or a terminal cancel, and its retry under the same turnKey. Code at
`2ab2a85efb1b73c27eafda5992f243eb81ac8bb0` (branch `fix/turn-cut-lost-lock`, based on main `ac86a39e`, PilotSwarm
0.8.17). Mode `"fix"` is this head. Mode `"head"` is the branch before its review (`2078582c`, whose source
`9ac0cff5` leaves unchanged; `CORRESPONDENCE-2078582c-tc1.md`); its lines are marked **head**. Mode `"main"` is bound
to `ac86a39e` (0.8.16 and 0.8.17, which include #367); its lines are marked **main**. Mode `"old"` is v0.6.0, the
first versioned-snapshot release, to 0.8.15 (before #367); its lines are marked **old**. Modes `"upgrade-main"` and
`"upgrade-old"` run main's or the old code on worker A and this head on worker B. Line numbers are at `2ab2a85e`
unless marked. `worker.ts` is unchanged from `2078582c`.

| Model | Code | Label |
|---|---|---|
| `A1Cancel`: the drain deadline, a lost lock or a terminal cancel cancels the activity; not fair | `worker.ts` `gracefulShutdown` 1360 `runtime.shutdown(drainBudgetMs)` cancels the activities still running at the deadline; duroxide cancels an activity whose lock was lost, and the running activity of a session that is cancelled or deleted | Code behavior; the lack of fairness is the model's (review C-5): a cancel is an external event |
| `term => lc /\ ~drain`: a terminal cancel is not retried | the orchestration ends the session and runs `destroySession` (`session-proxy.ts` 6071) instead of another attempt; a terminal cancel of a turn without the lifecycle protocol is not modelled | Model simplification |
| `A1Latch`: the body latches the cancel; `localA' = "cut"` | the aborted body may have written part of the turn to the session's local dir | Model simplification |
| `A1Latch`, `MarkCut`: any latched cancel marks the session | `session-proxy.ts` `latchCancelled` 4337-4341 calls `markTurnCut(sessionId, turnGeneration)` (`session-manager.ts` 4369-4371) unless the attempt already saved its turn (`turnSaved`); its callers are the cancel poll 4353 and `lockCut` 4345-4351, which every send and recovery reads (5034, 5046, 5052, 5106, 5170) | Code behavior |
| `A1Latch`, `MarkCut`, a drain: marked from **main** on | `session-proxy.ts` `throwIfDrainCut` 1737-1742 and `runBody` 5433; unchanged from **main** | Code behavior |
| `A1Latch`, `MarkCut`, **main** and **old**, a lost lock: no mark | **main** the cancel poll sets `cancelled = true` only; **old** has no `cutTurns` | Code behavior |
| a cancel latched after the attempt's commit published (or restored a winner) marks nothing, and clears a mark already set | `session-proxy.ts` 5478-5484 (`turnSaved`, review SF-1) | Not modelled (an attempt that completes before its cancel lands); `turn-control-run-turn.test.js` 839 |
| a cancelled activity starts no run and sends nothing; the transcript-reset and live-session-lost recoveries do not run | `session-proxy.ts` 5046-5049 (before the send), 5052 `mayStillSend` (`managed-session.ts` 1700-1703 steers, 4594 corrective prompts, 4675 the initial send), 5106 and 5170 (review SF-3; SF-4's transcript reset) | Not modelled (the body's content is abstract); `turn-control-run-turn.test.js` 778, `turn-control-live.test.js` 635-668 |
| `Locked`: A holds the run-turn lock until `A1Return` | `session-proxy.ts` 2087 `withRunTurnLock` (`session-manager.ts` 2086) wraps the body and its commit; the mark is set inside it, before the lock is released | Code behavior |
| `A1Return`, `SkipCutCommit`, a lost lock or a terminal cancel: no commit, the sentinel stays dirty | `session-proxy.ts` 5294 the body returns `{ type: "cancelled" }`; 5477 `runTurnCommit`; `session-lifecycle.ts` `runTurnCommit` 438-450 (`isCancelledResult` 156) returns `unpublishedReason: "cancelled"`; `session-proxy.ts` 5486-5526 records `session.snapshot_unpublished`, whose `cancelled` message (5513-5518) promises no retry (review C-2) | Code behavior |
| `A1Return`, `SkipCutCommit`, a drain: no commit | `session-proxy.ts` 5476 `throwIfDrainCut("before the snapshot commit")` (#367, unchanged) | Code behavior |
| `A1Return`, **main** (a lost lock) and **old** (both): the cut body is saved under the turnKey with its cancelled result | **main** `session-lifecycle.ts` `runTurnCommit` commits every result but a stopped one | Code behavior |
| `A1Return`, `storeVer # 0`: nothing is written | `session-lifecycle.ts` `commitTurnSnapshot` 456-: the store reports this turnKey committed (the retry won) or a foreign version superseded the base | Code behavior |
| `SdBegin`: a graceful shutdown begins after an ordinary cut; no attempt starts on A from then on; not fair | `worker.ts` 1314 `beginDrain` (`session-manager.ts` 4349-4351); `isDraining` 4357 | Code behavior (review SF-6) |
| `SdRelease`: skip a locked session and, with `ReleaseSkip`, a marked one | `worker.ts` 1382 `releaseIdleWorkspaces`; `session-manager.ts` 4215 filters out `sessionLocks` and `_drainKeepsCut` (4390-4394: marked, and this generation drains) | Code behavior |
| `SdSweep`: skip a locked session and, while draining, a marked one (`SweepSkips`); else release its workspace, then reclaim | `worker.ts` 1402 `sweepIdleSessions(1)`; `session-manager.ts` 2128 and 2135 (`_drainKeepsCut`, before and under the session lock); the workspace release or handle destroy 2142-2149; the dir 2150-2192 | Code behavior |
| `SweepSkips`, **head** and **main**: every sweep skips a marked session | **head** `session-manager.ts` (at `2078582c`) 2125 `if (this.isTurnCut(sessionId)) continue` | Code behavior |
| `EvSweep`: without a drain the eviction sweep may reclaim A's dir once the attempt returned; live, it reclaims a marked session (`liveReclaim`, review MF-1) | `worker.ts` 1194 the eviction clock's `sweepIdleSessions(evictAfterMs)` (35 minutes by default, 1191); `_drainKeepsCut` is false on a live worker | Code behavior; the model has no time, so it claims nothing about the order of this reclaim against B's attach |
| `Blocked`: the legacy publish guard, a dirty turn sentinel or a cut mark | `session-manager.ts` `_legacyPublishBlocker` 3748-3751 (`readTurnSentinel`, `snapshot-protocol.ts` 217; `isTurnCut` 4382) | Code behavior (reviews MF-1, MF-2) |
| `ReclaimA`: delete when the dir holds a committed marker, the store chain is versioned or the dir is `Blocked`; else a legacy dehydrate publishes it; the fix clears the mark after the cleanup | `session-manager.ts` 2157-2160 (marker), 2161-2172 (`probeSnapshot`, versioned), 2173-2179 (`_legacyPublishBlocker`, `rmSync`), 2180-2184 `_dehydrateUnlocked`; `clearTurnCut` 2153 (no dir) and 2191 | Code behavior |
| `ReclaimA`'s publish rule, the dehydrate and checkpoint activities | `session-manager.ts` `_dehydrateUnlocked` 3773-3786 (refuses before the safety checkpoint and the archive, drops the warm handle, keeps the dir and the mark, returns `{ unpublished }`); `checkpoint` 4298-4302; `session-proxy.ts` 5943-5966 (the dehydrate activity records `session.snapshot_unpublished` and returns as after a dehydrate), 6174-6179 (`checkpointSession`) | Not modelled apart from the sweep (the rule is the same); `session-workspace-release.test.mjs`, `session-proxy-events.test.js` 608 |
| `markerA = ~first` (with `lc`) | the marker of the last commit stays in the dir while a turn runs (`snapshot-protocol.ts` `writeTurnSentinel` 226 does not remove it); a first turn has none | Code behavior |
| `sentA = "dirty"` with `lc` | the lifecycle protocol writes the turn sentinel before the body; a turn without it writes none, so the mark must block on its own (`fault.tc-sentinel-only-guard`) | Code behavior |
| `Destroy`: a terminal cancel or delete; releases the workspace, drops the handle, clears the mark; the dir is left to the sweep | `session-proxy.ts` 6071-6095 the `destroySession` activity; `session-manager.ts` `destroySession` 4220-4235, `clearTurnCut` 4233 (review SF-1) | Code behavior |
| `Destroy`, **head**: the mark stays | **head** `destroySession` does not touch `cutTurns` | Code behavior |
| `A2Fail`: the retry's preamble probe on A fails; the fix keeps the mark | `session-proxy.ts` 2147 `runTurnPreamble` throws before 2148 `clearTurnCut` (review MF-2) | Code behavior |
| `A2Fail`, `ProbeClears`, **head**: the mark is already cleared | **head** `session-proxy.ts` (at `2078582c`) 2085 `clearTurnCut` at the start of the run-turn lock body | Code behavior |
| `A2Start` on A: only after a lost lock, once the attempt returned, while A is live; the fix clears the mark once the preamble resolved the session | `session-proxy.ts` 2148 (lifecycle) and 2125 (without the lifecycle protocol, at once) | Code behavior; a retry on A without the lifecycle protocol is not modelled |
| `A2Start`: resolve from the store (`loc2' = storeC`) | `session-lifecycle.ts` `runTurnPreamble` 273-: a dirty sentinel (275) or no usable dir resolves from the store (`resolveFromStore` 232, called at 347 and 371) | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, `RecoverNoAdopt`: run the turn on top of it | `session-lifecycle.ts` `recoverAlreadyCommitted` 197-229: a cancelled result under this turnKey (204-214) degrades to a hydrated re-run at the stored version | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, **main** and **old**: adopt it (`dropped`) | **main** `recoverAlreadyCommitted` returns `already-committed` with the stored result; `orchestration/turn.ts` 1609-1611 `case "cancelled"` only traces and returns | Code behavior |
| `A2Commit`, `lc`, `storeVer = base2`: CAS at `base2 + 1` under the turnKey | `session-lifecycle.ts` `commitTurnSnapshot` 456-, the CAS 468 | Code behavior |
| `A2Commit`, `~lc`: a legacy publish | the retry on B runs without the lifecycle protocol and dehydrates the legacy way | Model simplification |
| `A2Commit`, `storeVer # base2`, `CommitNoAdopt`: return its own result unpublished (`residual`) | `session-lifecycle.ts` 487-508 `foreign_cancelled_winner` (review SF-2); `session-proxy.ts` 5478-5484 (the restored winner counts as saved), 5519-5522 (the message), 5565-5567 (no cursor credit, `noCarriedCredit`; `finishTurnControl` 2041) | Code behavior |
| `A2Commit`, **head**: return its own result as published | **head** `commitTurnSnapshot` returns `published: true` with no `storedResult` | Code behavior; not distinguished by the model (`residual` in both) |
| `A2Commit`, **main** and **old**: adopt the stored cancelled result (`dropped`) | **main** `commitTurnSnapshot` returns `storedResult` for any readable result under this turnKey | Code behavior |
| one retry; the retry on A never beside a retry on B; no retry on A in the upgrade modes | the orchestration runs one attempt at a time per turn; in an upgrade A runs the older release, whose retry the `"main"` and `"old"` modes cover | Model simplification |
| no worker restart | `worker.ts` 743 `startGeneration` clears every mark (`session-manager.ts` 4337-4340) | Model simplification |
| `Inv_NoCancelledCommit`, `Inv_TurnNotDropped`, `Inv_NoAbortedHandOff`, `Inv_ShutdownKeepsCut`, `Inv_DrainKeepsCut`, `Inv_NoCutPublish` | a cut attempt is never saved; the retry runs the turn from the last commit; a draining worker leaves a cut session as if its turn still ran, whether the drain cut it or it was cut before the shutdown began (review SF-6); no legacy path publishes a cut attempt's files (review MF-2) | Rule to evaluate |
| `Prop_TurnRuns`, `Prop_LiveRelease`, `Prop_EndReclaims` | a cut that is not terminal leads to the retry running the turn; a live A releases a cut session whose retry went to B (review MF-1); a destroyed session loses its local dir (review SF-1) | Rule to evaluate, under the stated fairness |

`Inv_ShutdownKeepsCut` is the rule `workspace-moves.test.js` M4 checks ("releases only what is idle"): the next worker
sees a dead holder and tells the turn its workspace may hold partial changes. 0.8.17 (`comparison.tc-main-late-shutdown`)
breaks it for a shutdown that begins after an ordinary lost-lock cut, which it never marks.

#364's shutdown cut (`session-proxy.ts` 5078-5083: a run that returns after this worker began shutting down marks the
session and throws `TURN_CUT_BY_SHUTDOWN_MESSAGE`) runs only after the manager's shutdown, after the release and the
sweep, and is not modelled. A turn that lost its Copilot runtime (#329, another branch) does not mark the session.

Bounds: one session, one turn, one cut attempt and one retry; the turn is a first or a later one, runs the lifecycle
protocol or not, and the cut comes from a drain, a lost lock or a terminal cancel (all chosen in `Init`); a shutdown
may begin after an ordinary cut; the retry's probe on A may fail once. Every case explores its full state space.

Not modelled:

- an attempt that completes before its cancel lands (`turnSaved`; unit-tested);
- the body's sends, steers and recoveries after a cancel (`lockCut`; unit-tested);
- the orchestration's retry count and timers, and a second retry;
- a retry on A while B's retry still runs, and a shutdown that begins while the retry runs on A (a second cut);
- a retry on A without the lifecycle protocol, and a terminal cancel without it;
- a worker restart or an in-process stop and start (a new generation clears every mark);
- a stopped turn (`runTurnCommit`'s stopped skip);
- the dehydrate and checkpoint activities apart from the sweep (they share its publish rule);
- the workspace provider and the partial-changes note;
- the snapshot store's CAS beyond the turnKey rule (`TurnCommit.tla`, `SnapshotWarmDrop.tla`).

Test evidence (each fails with its fix reverted and passes at this head):

- `packages/sdk/test/unit/session-workspace-release.test.mjs`: while the worker drains, a cut session is neither
  released nor swept; on a live worker the sweep reclaims a cut session without publishing it (it cancels the shells,
  releases the workspace, deletes the dir) and then clears the mark (MF-1); dehydrate, checkpoint and the sweep never
  publish a dir with a dirty turn sentinel or a cut session (MF-1, MF-2); `destroySession` clears the mark (SF-1).
- `packages/sdk/test/local/turn-control-run-turn.test.js` (the runTurn activity through `session-proxy.ts` with a real
  `FilesystemSessionStore`, review SF-5): the cut attempt commits nothing and its retry on another worker runs the turn
  from the last commit (697); a lock lost before the send starts no run (778, SF-3); an older build's cancelled commit
  that won the CAS leaves the turn unpublished, uncredited and its carried steers kept (804, SF-2); a cancellation
  latched after the commit marks nothing (839, SF-1); a retry here whose store read fails keeps the mark (867, MF-2).
- `packages/sdk/test/local/turn-control-live.test.js` 635-668: a run, a steer and a corrective prompt are not sent once
  the activity can no longer send (SF-3).
- `packages/sdk/test/local/turn-lifecycle.test.js` 507: a commit that finds an older build's cancelled attempt returns
  its own result unpublished (`foreign_cancelled_winner`, SF-2).
- `packages/sdk/test/local/session-proxy-events.test.js` 608: a dehydrate that refused to publish records
  `session.snapshot_unpublished`, not `session.dehydrated`.
