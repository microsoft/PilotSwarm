# RuntimeLoss (rl2) and TurnCut (tc2) correspondence to 16e5c481

`16e5c481625cf6acff682630e21ba32a6cb1cf3b` (branch `fix/turn-cut-lost-lock`) merges main `9099aaa2` into the TurnCut
branch. Main `9099aaa2` is #376 (issue #329, a lost Copilot runtime), whose source is that of `056eb496`, where
`CORRESPONDENCE-0b338528-rl2.md` holds. The branch parent `606a4cd4` has the source and tests of `63024c6c`, where
`CORRESPONDENCE-63024c6c-tc2.md` holds. So both fixes are now in one head, and both models are bound to it here.

Neither model changed in the merge: `RuntimeLoss.tla` and `OwnedRetry.tla` are main's, `TurnCut.tla` is the branch's,
and every record of the merged `cases.json` (233 cases) equals its record in the parent it came from. The merge
resolved `session-lifecycle.ts` (the union of the unpublished reasons), `session-manager.ts` (`_legacyPublishBlocker`
returns `"dirty_turn"` or `"turn_cut"`) and `session-proxy.ts` (the unpublished messages, and two comments that now name
a lost runtime among the turns that are not saved). Every line below was re-read at `16e5c481`. All 233 cases were
re-run at this head (folder README, §4).

The rl2 and tc2 files stay as the record of those batches. This file supersedes their code columns; the model rows and
labels are theirs, unchanged.

## Merge interactions

The two fixes meet in five places. None needs a model change: in each, a RuntimeLoss scenario reduces to rl2's binding
and a TurnCut scenario to tc2's.

1. **The commit's skips.** `runTurnCommit` (`session-lifecycle.ts` 403) skips a stopped turn (419-431), then a cancelled
   result (440-452, TurnCut's `SkipCutCommit`), then a transport loss (463-475, RuntimeLoss's `SkipCommitOnLoss`). Each
   skip publishes nothing and leaves the sentinel dirty, so the order only picks the reported reason.
2. **A loss and a cut in one attempt.** A transport loss alone sets no cut mark: neither the transport-loss block
   (`session-proxy.ts` 5291-5301) nor the body's lost-runtime throw (5575-5590) calls `markTurnCut`. A cancel latched
   during the loss marks the session (`latchCancelled` 4457-4461). The transport-loss block runs first and drops the
   warm handle through `invalidateWarmSession` (`session-manager.ts` 4395), which does not touch the mark; the body
   then returns `cancelled` (5432), and the commit skips it as a cut. Both models' rules hold for it; neither model has
   both events in one attempt.
3. **The publish blocker.** `_legacyPublishBlocker` (`session-manager.ts` 3878-3881) returns `"dirty_turn"` for a dirty
   sentinel (rl2's review M1) and otherwise `"turn_cut"` for a marked session (tc2's MF-1 and MF-2). It is TurnCut's
   `Blocked`. RuntimeLoss sets no mark, so there it is rl2's dirty-turn guard.
4. **The sweep's cut skip.** rl2's head skipped every cut session; this head skips one only while its generation drains
   (`_drainKeepsCut` 4535-4539, at 2231 and 2238). RuntimeLoss models no cut, so its `Sweep` is unchanged. The live
   reclaim of a cut session is TurnCut's `EvSweep`.
5. **A lost runtime during a drain.** `runBody` (5567-5595) tests the drain cut (5571-5574) before the lost-runtime
   throw (5575-5590), so a body that fails while its worker drains is a drain cut (TurnCut), not a transport loss.

tc2's note that a turn which lost its Copilot runtime does not mark the session ("#329, another branch") is now code
on this branch, and still holds (2 above).

TurnCut's mode `"main"` stays bound to `ac86a39e`, which 0.8.18 (`1f6af957`) equals in the modelled paths. Main
`9099aaa2` lies between mode `"main"` and this head: it has #376's dirty-turn publish guard, but not #382's marks for a
lost lock or a terminal cancel, the cut-mark publish guard, the cancelled skip or the retry's re-run. It is not a mode of
its own; a release cut from it before #382 lands is not covered.

## RuntimeLoss rows

Mode `"main"` stays bound to `ac86a39e` (`CORRESPONDENCE-f4ef5cd8-rl1.md`); its rows say "as in rl1".

| Model | Code at `16e5c481` | Label |
|---|---|---|
| `Head`, `head` | `session-store.ts` `probeSnapshot` 720; `session-manager.ts` `readSnapshotMarker` in the sweep 2243 | Code behavior |
| `Start`: the preamble hydrates (and drops the warm handle) when `sentinel = "dirty"` or `local = "none"` | `session-lifecycle.ts` `runTurnPreamble` 275-374: `localTrusted` 298; an empty store with a dirty or unusable dir starts fresh (319-340); otherwise `resolveFromStore` 234-262 drops the warm session at 239, then hydrates (called at 349 and 373) | Code behavior |
| `Start`: `sentinel' = "dirty"` | `session-proxy.ts` 2860 `writeTurnSentinel` | Code behavior |
| `Start`, `w = "live"` | `session-manager.ts` `_getOrCreateUnlocked` 2436, the warm branch from 3587 | Code behavior |
| `Start`, `w = "dead"`, `DropDeadWarm` | `session-manager.ts` 3575-3586 (the workspace shells are cancelled at 3584); `usableWarmSession` 3782-3785 (review S9) | Code behavior |
| `Start`, `w = "dead"`, **main** | as in rl1 | Code behavior |
| `Start`, `OTHER`, `pooled /\ rt = "dead"` | as in rl1 | Code behavior |
| `Start`, `OTHER`, otherwise: a fresh client and runtime | `session-manager.ts` `ensureClient` 1776 (the lost check 1797) and `ensureClientForKey` 2039 (2041); `_startClient` 1865-1900 refuses a lost client (1871-1873), claims (1874-1878), and reports a start that failed on an exited runtime as a loss (1884-1892, review S6) | Code behavior |
| `Die`: `rt' = "dead"`, `EvictDeadClient` | `copilot-runtime-monitor.ts` 234-253 (`decideDeferred` 221-228, unchanged); `session-manager.ts` `_onRuntimeLost` 1917-1930, `_evictClient` 1903-1907 | Code behavior |
| `Die`: `warm' = "dead"` | `managed-session.ts` `runtimeLost` 1877, `bindRuntimeWatch` 1872; `session-manager.ts` `_bindRuntimeWatch` 1949, called at 3735 and 3971 | Code behavior |
| `Die` during a turn: `local'` is `local` or `Torn(local)` | as in rl2 | Model simplification |
| `Die` between turns (`AllowIdleLoss`) | as in rl2 | Code behavior |
| `Finish` | as in rl2 | Model simplification |
| `SettleOnExit` (`ExitWatch`) | `managed-session.ts` the exit race 4694-4702; the catch 5071-5087 (and 5132); the outer guard 1763-1786 (reviews S2, S3) | Code behavior |
| `SettleByWatchdog` | `managed-session.ts` the inactivity watchdog 4666-4669 (`DEFAULT_TURN_INACTIVITY_TIMEOUT_MS` 791) | Code behavior |
| no `SettleByWatchdog` with `ExitWatch` | as in rl2 | Model simplification (timing assumption) |
| `Postamble`, `res = "ok"` | `session-lifecycle.ts` `runTurnCommit` 403, `commitTurnSnapshot` called at 476 | Code behavior |
| `Postamble`, `res = "loss"`, `DropDeadWarm` | `session-proxy.ts` 5291-5301 (`TRANSPORT_LOSS_DESTROY_DEADLINE_MS` 664); `runBody` 5575-5590 (review S3) | Code behavior |
| `Postamble`, `res = "loss"`, `SkipCommitOnLoss` | `session-lifecycle.ts` 463-475 (`"transport_loss"`, the typed flag only); `session-proxy.ts` 5644-5692 `session.snapshot_unpublished` (the message 5683-5684) | Code behavior |
| `Postamble`, `res = "loss"`, **main** | as in rl1 | Code behavior |
| `att' = "retry"` after a loss | `orchestration/utils.ts` 298; `orchestration/turn.ts` 128-213 (unchanged) | Code behavior |
| `Move` | `orchestration/turn.ts` `releaseAffinity` (unchanged) | Code behavior |
| `Sweep`: only when no attempt holds the session lock | `session-manager.ts` `sweepIdleSessions` 2212: a held lock is skipped (2227), a cut session only while draining (2231, interaction 4); the rest runs under `_withSessionLock(sessionId, "eviction")` 2234 | Code behavior |
| `Sweep`: `warm' = "none"`, `local' = "none"` | 2245-2252 (the workspace release or the destroy); every branch below removes the dir (no dir: 2253-2259) | Code behavior |
| `Sweep`, `head = "versioned"` | 2260-2263 (the committed marker) and 2264-2275 (the versioned probe) | Code behavior |
| `Sweep`, `PublishGuard /\ sentinel = "dirty"` | 2276-2282, `_legacyPublishBlocker` 3878-3881 returns `"dirty_turn"` (interaction 3) | Code behavior |
| `Sweep`, otherwise | 2283-2287 `_dehydrateUnlocked(sessionId, "eviction")`; `session-store.ts` `dehydrate` 896, fence 898-907 | Code behavior |
| `LegacyPublish`, `dehydrate` = TRUE, guarded and dirty | `session-manager.ts` `_dehydrateUnlocked` 3883, the guard 3897-3919 (`invalidateWarmSession` 3906, `{ unpublished }` 3918); `session-proxy.ts` 6105-6131 | Code behavior |
| `LegacyPublish`, `dehydrate` = FALSE, guarded and dirty | `session-manager.ts` `checkpoint` 4436, the guard 4441-4447; `session-proxy.ts` 6339-6345 | Code behavior |
| `LegacyPublish`, otherwise, `head = "versioned"` | `session-store.ts` 898-907 and 964-971; `blob-store.ts` 252 and 400 (unchanged) | Code behavior |
| `LegacyPublish`, otherwise, no versioned head | `session-manager.ts` the pre-dehydrate checkpoint 3921-3938; `checkpoint` 4448 | Code behavior |
| `Sweep` and `LegacyPublish` are not in `Fairness`; one `LegacyPublish` action; `MaxTries` | as in rl2 | Model simplification |
| `Inv_NoDirtyPublish`, `Inv_StoreNeverTorn`, `Inv_NoDeadWarmReuse`, `Inv_NoDeadClientUse`, `Inv_PromptSettle`, `Inv_LossLeavesSentinelDirty`, `Prop_TurnCommits` | as in rl2 | Rule to evaluate |

## TurnCut rows

Mode `"fix"` is this head. Modes `"head"`, `"main"` and `"old"` keep their tc2 bindings (`f9b958c1`, `ac86a39e`,
v0.6.0 to 0.8.15).

| Model | Code at `16e5c481` | Label |
|---|---|---|
| `A1Cancel` | `worker.ts` 1360 `runtime.shutdown(drainBudgetMs)` (unchanged) | Code behavior; not fair (review C-5) |
| `term => lc /\ ~drain` | the `destroySession` activity, `session-proxy.ts` 6236 | Model simplification |
| `A1Latch`: `localA' = "cut"` | as in tc2 | Model simplification |
| `A1Latch`, `MarkCut` | `session-proxy.ts` `latchCancelled` 4457-4461 (the mark at 4460, `session-manager.ts` `markTurnCut` 4514-4516); its callers `lockCut` 4465-4472 and the cancel poll 4473-4475; the sends and recoveries that read `lockCut` 5154, 5166, 5172, 5226, 5308 | Code behavior |
| `A1Latch`, `MarkCut`, a drain | `session-proxy.ts` `throwIfDrainCut` 1789-1794; `runBody` 5571-5574 | Code behavior |
| `A1Latch`, `MarkCut`, **main** and **old** | as in tc2 | Code behavior |
| a cancel latched after the commit published marks nothing and clears a mark | `session-proxy.ts` 5637-5643 (`turnSaved` 5641, the clear 5642, review SF-1) | Not modelled; `turn-control-run-turn.test.js` 1004 |
| a cancelled activity starts no run and sends nothing | `session-proxy.ts` 5166-5169 (before the send), 5172 `mayStillSend` (`managed-session.ts` 1727-1733 steers, 4740 the corrective prompt, 4847 the initial send), 5226 and 5308 (reviews SF-3, SF-4) | Not modelled; `turn-control-run-turn.test.js` 943, `turn-control-live.test.js` 635-668 |
| `Locked` | `session-proxy.ts` 2139 `withRunTurnLock` (`session-manager.ts` 2189) | Code behavior |
| `A1Return`, `SkipCutCommit`, a lost lock or a terminal cancel | `session-proxy.ts` 5432 the body returns `{ type: "cancelled" }`; 5636 `runTurnCommit`; `session-lifecycle.ts` 440-452 (`isCancelledResult` 158); `session-proxy.ts` 5644-5692, the `cancelled` message 5677-5682 (review C-2) | Code behavior |
| `A1Return`, `SkipCutCommit`, a drain | `session-proxy.ts` 5635 `throwIfDrainCut("before the snapshot commit")` | Code behavior |
| `A1Return`, **main** and **old** | as in tc2 | Code behavior |
| `A1Return`, `storeVer # 0` | `session-lifecycle.ts` `commitTurnSnapshot` 481- | Code behavior |
| `SdBegin` | `worker.ts` 1314 `beginDrain` (`session-manager.ts` 4494-4496); `isDraining` 4502-4504 | Code behavior (review SF-6) |
| `SdRelease` | `worker.ts` 1382; `session-manager.ts` `releaseIdleWorkspaces` 4340, the filter 4348 (`_drainKeepsCut` 4535-4539) | Code behavior |
| `SdSweep` | `worker.ts` 1402; `session-manager.ts` 2231 and 2238; the release or destroy 2245-2252; the dir 2253-2295 | Code behavior |
| `SweepSkips`, **head** and **main** | as in tc2 | Code behavior |
| `EvSweep` | `worker.ts` 1194 (the clock, 1191); `_drainKeepsCut` is false on a live worker | Code behavior |
| `Blocked` | `session-manager.ts` `_legacyPublishBlocker` 3878-3881 (`readTurnSentinel`, `snapshot-protocol.ts` 217; `isTurnCut` 4527-4529) | Code behavior (reviews MF-1, MF-2) |
| `ReclaimA` | `session-manager.ts` 2260-2263 (marker), 2264-2275 (versioned), 2276-2282 (`_legacyPublishBlocker`), 2283-2287 `_dehydrateUnlocked`; `clearTurnCut` 2256 (no dir) and 2294 | Code behavior |
| `ReclaimA`'s publish rule, the dehydrate and checkpoint activities | `session-manager.ts` `_dehydrateUnlocked` 3897-3919; `checkpoint` 4441-4447; `session-proxy.ts` 6105-6131, 6339-6344 | Not modelled apart from the sweep; `session-workspace-release.test.mjs`, `session-proxy-events.test.js` 608 |
| `markerA = ~first` | `snapshot-protocol.ts` `writeTurnSentinel` 226 | Code behavior |
| `sentA = "dirty"` with `lc` | as in tc2 | Code behavior |
| `Destroy` | `session-proxy.ts` 6236-6261; `session-manager.ts` `destroySession` 4353-4368, `clearTurnCut` 4366 (review SF-1) | Code behavior |
| `Destroy`, **head** | as in tc2 | Code behavior |
| `A2Fail` | `session-proxy.ts` 2199 `runTurnPreamble` throws before 2200 `clearTurnCut` (review MF-2) | Code behavior |
| `A2Fail`, `ProbeClears`, **head** | as in tc2 | Code behavior |
| `A2Start` on A | `session-proxy.ts` 2200 (lifecycle) and 2177 (without it) | Code behavior |
| `A2Start`: resolve from the store | `session-lifecycle.ts` `runTurnPreamble` 275- (the sentinel 277); `resolveFromStore` 234, called at 349 and 373 | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, `RecoverNoAdopt` | `session-lifecycle.ts` `recoverAlreadyCommitted` 199-231 (206-216) | Code behavior |
| `A2Start`, `storeKey = "cancelled"`, **main** and **old** | as in tc2 (`orchestration/turn.ts` 1609-1611, unchanged) | Code behavior |
| `A2Commit`, `lc`, `storeVer = base2` | `session-lifecycle.ts` `commitTurnSnapshot` 481-, the CAS 493 | Code behavior |
| `A2Commit`, `~lc` | as in tc2 | Model simplification |
| `A2Commit`, `storeVer # base2`, `CommitNoAdopt` | `session-lifecycle.ts` 512-533 `foreign_cancelled_winner` (review SF-2); `session-proxy.ts` 5637-5643 (counted as saved), 5685-5688 (the message), 5728-5732 (`noCarriedCredit`; `finishTurnControl` 2093) | Code behavior |
| `A2Commit`, **head**, **main** and **old** | as in tc2 | Code behavior |
| one retry; no worker restart | as in tc2 (`worker.ts` 743, `session-manager.ts` `startGeneration` 4482-4486) | Model simplification |
| `Inv_NoCancelledCommit`, `Inv_TurnNotDropped`, `Inv_NoAbortedHandOff`, `Inv_ShutdownKeepsCut`, `Inv_DrainKeepsCut`, `Inv_NoCutPublish`, `Prop_TurnRuns`, `Prop_LiveRelease`, `Prop_EndReclaims` | as in tc2 | Rule to evaluate |

#364's shutdown cut (`session-proxy.ts` 5198-5203) is not modelled, as in tc2.

## Bounds and what is not covered

The bounds and case tables are rl2's and tc2's, unchanged. Not modelled: everything listed in both files, and an
attempt that both loses its runtime and is cut (interaction 2; each rule holds for it in the code, but no model has
both events). A pooled client shared by sessions of both kinds is covered by test only.

## Test evidence at `16e5c481`

- `packages/sdk/test/local/turn-lifecycle.test.js`: issue 329, not committed (556); review S1 (592); review M1 (610);
  issue 329, the retry hydrates (711); SF-2 `foreign_cancelled_winner` (508).
- `packages/sdk/test/local/turn-control-run-turn.test.js`: the cut attempt commits nothing and its retry runs (862);
  SF-3 (943); SF-2 (969); SF-1 (1004); MF-2 (1032).
- `packages/sdk/test/local/turn-control-live.test.js` 635-668 (SF-3).
- `packages/sdk/test/local/session-proxy-events.test.js` 608: a refused dehydrate records `session.snapshot_unpublished`
  for both `dirty_turn` and `turn_cut`.
- `packages/sdk/test/unit/session-workspace-release.test.mjs` (MF-1, MF-2, SF-1) and
  `packages/sdk/test/local/runtime-loss.test.js` (the real runtime killed mid-turn, review M2), unchanged.
