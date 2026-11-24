# RuntimeLoss (rl2) correspondence to dd1029c6

Batch rl2 extends `RuntimeLoss` with the store's head before the turn and with the two legacy publish paths: the
eviction sweep, and the dehydrate activity together with the safety checkpoint. Batch rl1 did not model a first
turn with an empty store. Review M1 of #376 found that there the eviction sweep could archive the lost turn's
dirty local dir over the store, after the activity had reported that turn unpublished.

The code is `dd1029c6`, branch `fix/329-dead-runtime`: the #329 fix `261ea6c7` plus the review fixes of #376, on main
`ac86a39e` (0.8.17), with `@github/copilot-sdk` 1.0.34 (runtime `@github/copilot` 1.0.112). Mode `"main"` stays
bound to `ac86a39e`, as in `CORRESPONDENCE-261ea6c7-rl1.md`.

The two commits after `dd1029c6` on the branch change only `pg-migrator.ts`, its test and the docs, so this binding
also holds for them. `orchestration/turn.ts` and `orchestration/utils.ts` are unchanged since `ac86a39e`.

This file supersedes the rl1 table for the model's current text: every rl1 row is re-bound below to the lines at
`dd1029c6`. The rl1 file stays as the record of batch rl1.

| Model | Code | Label |
|---|---|---|
| `Head`, `head`: the store's head before the turn. `"versioned"` is a committed chain (the dir's committed marker, or the store's versioned probe); `"none"` is an empty store, where `"base"` stands for the empty conversation of a first turn; `"legacy"` is an unversioned snapshot | `session-store.ts` `probeSnapshot` 720 (an unversioned snapshot is version 0, `legacy`); `session-manager.ts` `readSnapshotMarker` in the sweep 2236 | Code behavior |
| `Start`: the preamble hydrates (and drops the warm handle) when `sentinel = "dirty"` or `local = "none"` | `session-lifecycle.ts` `runTurnPreamble` 247-346: `localTrusted` 270; an empty store with a dirty or unusable dir starts fresh, after dropping the warm handle and removing the dir (292-312); otherwise `resolveFromStore` 206-233 drops the warm session at 211, then hydrates | Code behavior |
| `Start`: `sentinel' = "dirty"` | `session-proxy.ts` 2849 `writeTurnSentinel`, after `getOrCreate`, before the turn body | Code behavior |
| `Start`, `w = "live"`: the live warm handle is reused | `session-manager.ts` `_getOrCreateUnlocked` 2426, the warm branch from 3572 (`else if (existing)`) | Code behavior |
| `Start`, `w = "dead"`, `DropDeadWarm`: the dead handle is dropped and the session resumes on a client | `session-manager.ts` 3561-3571: `existing?.runtimeLost && turnIndex !== 0` destroys and forgets it; turn 0 resets any warm handle. The spawn and workflow capture paths treat a dead handle as absent (`usableWarmSession` 3768-3771, review S9) | Code behavior |
| `Start`, `w = "dead"`, **main** | as in rl1 (**main** `session-manager.ts` 3451-3452) | Code behavior |
| `Start`, `OTHER`, `pooled /\ rt = "dead"` (`deadClientUse`) | as in rl1 (**main** `ensureClient`, `ensureClientForKey`, SDK `getStartedConnection` 2695-2709) | Code behavior |
| `Start`, `OTHER`, otherwise: a fresh client and runtime (`rt' = "live"`, `pooled' = TRUE`) | `session-manager.ts` `ensureClient` 1794-1795 and `ensureClientForKey` 2038-2039 evict a lost client and create another. `_startClient` 1862-1891 refuses a lost client (1868-1870) and starts it inside the monitor's claim (1871). A start that fails because its runtime exited is reported as a transport loss (1880-1887, review S6) | Code behavior |
| `Die`: `rt' = "dead"`, and with `EvictDeadClient` `pooled' = FALSE` | `copilot-runtime-monitor.ts` per-child `exit` listener 234-253 calls `onUnexpectedExit` (an exit during a start is decided when the start settles, `decideDeferred` 219-228). `session-manager.ts` `_onRuntimeLost` 1914-1928 logs the pid, code, signal and the in-flight and idle warm sessions, counts `pilotswarm.copilot_runtime.exits` (review S8), `_evictClient` 1898-1902, then `forceStop` in the background | Code behavior |
| `Die`: `warm' = "dead"` | `managed-session.ts` `runtimeLost` 1857 reads the watch bound at creation (`bindRuntimeWatch` 1852; `session-manager.ts` `_bindRuntimeWatch` 1946, called at 3721 and 3952) | Code behavior |
| `Die` during a turn: `local'` is `local` or `Torn(local)` | the runtime may have written events of the turn to the session's local dir before it died | Model simplification |
| `Die` between turns (`AllowIdleLoss`) | the same exit listener, with no turn running; the warm handle is dropped at its next `getOrCreate`, spawn or workflow capture | Code behavior |
| `Finish` | the turn reaches `session.idle` on a live runtime | Model simplification |
| `SettleOnExit` (`ExitWatch`) | `managed-session.ts` `_runTurnInner`: the turn races `runtimeWatch.onExit` (4651-4659) with its timeout and inactivity guards. Its catch returns `copilotRuntimeExitMessage` with the typed `transportLoss: true` flag (4979-4987). The outer guard returns the same flag when the native-subagent settle or the turn fails on a lost runtime (1743-1766, reviews S2 and S3) | Code behavior |
| `SettleByWatchdog` | `managed-session.ts` inactivity watchdog 4626 (`DEFAULT_TURN_INACTIVITY_TIMEOUT_MS` 779, 300 s); **main** as in rl1 | Code behavior |
| no `SettleByWatchdog` with `ExitWatch` | the exit event arrives within milliseconds of the kill; the watchdog is 300 s | Model simplification (timing assumption) |
| `Postamble`, `res = "ok"`: commit, `sentinel' = "clean"`, `head' = "versioned"` | `session-lifecycle.ts` `runTurnCommit` 429 `commitTurnSnapshot`, a versioned CAS commit that clears the sentinel on publish | Code behavior |
| `Postamble`, `res = "loss"`, `DropDeadWarm` | `session-proxy.ts` 5224-5235: the typed `transportLoss` flag (review S1; never the message text) drops the warm session (`invalidateWarmSession`, `TRANSPORT_LOSS_DESTROY_DEADLINE_MS` 664) and appends the connection-closed wording (`transportLossMessage`). A body that threw on a lost runtime does the same, then throws (`runBody` 5495-5519, review S3) | Code behavior |
| `Postamble`, `res = "loss"`, `SkipCommitOnLoss`: no commit, the sentinel stays dirty | `session-lifecycle.ts` `runTurnCommit` 417-428 returns `unpublishedReason: "transport_loss"` for the typed flag only; `session-proxy.ts` 5566-5590 emits `session.snapshot_unpublished` | Code behavior |
| `Postamble`, `res = "loss"`, **main** | as in rl1 (**main** `runTurnCommit` 371-404) | Code behavior |
| `att' = "retry"` after a loss | `orchestration/utils.ts` `isCopilotConnectionClosedError` 298; `orchestration/turn.ts` `handleConnectionClosedRetry` 128-213 (unchanged) | Code behavior |
| `Move` (once, `AllowMove`) | `orchestration/turn.ts` `releaseAffinity(runtime, "error")` before the 15 s retry timer (unchanged) | Code behavior |
| `Sweep` (`AllowSweep`): only when no attempt holds the session lock | `session-manager.ts` `sweepIdleSessions` 2209: a session with a held lock or a cut turn is skipped (2224-2225); the rest runs under `_withSessionLock(sessionId, "eviction")` (2232) | Code behavior |
| `Sweep`: `warm' = "none"`, `local' = "none"` | 2239-2246 destroys and forgets the warm session (or releases its workspace); every branch below removes the dir | Code behavior |
| `Sweep`, `head = "versioned"`: the dir is a cache and is deleted | 2252-2255 (the dir's committed marker) and 2262-2267 (the store's versioned probe) | Code behavior |
| `Sweep`, `PublishGuard /\ sentinel = "dirty"`: the dir is deleted, the store is unchanged (`sweptDirty`) | 2268-2273: `_legacyPublishBlocker` 3862-3864 (`readTurnSentinel`) returns `"dirty_turn"`, and the dir is removed with a warning trace (review M1) | Code behavior |
| `Sweep`, otherwise: `store' = local`, `head' = "legacy"` | 2274-2277: `_dehydrateUnlocked(sessionId, "eviction")`, then the store's legacy archive (`session-store.ts` `dehydrate` 896, past its versioned fence 898-906). **Before the guard** (`Fault = "no-publish-guard"`, the code at `ce74d928`) the archive excluded the sentinel and published a dirty dir | Code behavior |
| `LegacyPublish`, `dehydrate` = TRUE, guarded and dirty: the warm handle is dropped, the dir and the store are kept (`publishRefused`) | `session-manager.ts` `_dehydrateUnlocked` 3866, the guard 3885-3900: `invalidateWarmSession` with `UNPUBLISHED_DESTROY_DEADLINE_MS`, a warning, `_forgetTurnState`, and `{ unpublished: "dirty_turn" }`. `session-proxy.ts` 6015-6030 records `session.snapshot_unpublished { reason: "dirty_turn" }` and the `unpublished` dehydration result; the orchestration's dehydrate step is not failed | Code behavior |
| `LegacyPublish`, `dehydrate` = FALSE, guarded and dirty: nothing changes (`publishRefused`) | `session-manager.ts` `checkpoint` 4414, the guard 4421-4425 returns `{ unpublished }`; `session-proxy.ts` 6246-6249 traces it | Code behavior |
| `LegacyPublish`, otherwise, `head = "versioned"`: a dehydrate only releases the dir, a checkpoint writes nothing | `session-store.ts` `dehydrate` 898-906 and `checkpoint` 963-970 (the versioned fences); `blob-store.ts` 252 and 400 do the same | Code behavior |
| `LegacyPublish`, otherwise, no versioned head: `store' = local`, `head' = "legacy"`; a dehydrate then removes the dir | `session-manager.ts` `_dehydrateUnlocked` the pre-dehydrate checkpoint 3902-3916, the destroy, then `sessionStore.dehydrate`; `checkpoint` 4426 | Code behavior |
| `Sweep` and `LegacyPublish` are not in `Fairness` | an idle session may never be swept or dehydrated | Model simplification |
| one `LegacyPublish` action for the dehydrate activity, the drain's dehydrate and the checkpoint | the guard runs in the same place for each caller (`_dehydrateUnlocked` for the activity and the sweep's legacy branch; `checkpoint` for the checkpoint activity) | Model simplification |
| `MaxTries` bounds the attempts; the lossy hand-off is not modelled | as in rl1 (`OwnedRetry.tla`) | Model simplification |
| `Inv_NoDirtyPublish` | review M1: no legacy path publishes a dir holding an uncommitted turn, torn or not | Rule to evaluate |
| `Inv_StoreNeverTorn`, `Inv_NoDeadWarmReuse`, `Inv_NoDeadClientUse`, `Inv_PromptSettle`, `Inv_LossLeavesSentinelDirty`, `Prop_TurnCommits` | the requirements of issue #329 (as in rl1) | Rule to evaluate |

Bounds: `MaxTries` 4, `MaxLoss` 3, `AllowIdleLoss` TRUE, `AllowMove` TRUE (FALSE in `wit.rl-first-turn-swept`).
One session and one turn on top of `base`. The rl1 cases are unchanged: `Head` `"versioned"`, `AllowSweep` and
`AllowPublish` FALSE.

| Case | `Head` | `AllowSweep` | `AllowPublish` | `Fault` | Expected |
|---|---|---|---|---|---|
| `rl.first-turn-safety` | `"none"` | TRUE | TRUE | `"none"` | PASS |
| `rl.legacy-head-safety` | `"legacy"` | TRUE | TRUE | `"none"` | PASS |
| `rl.versioned-head-sweep-safety` | `"versioned"` | TRUE | TRUE | `"none"` | PASS |
| `rl.first-turn-live` | `"none"` | TRUE | TRUE | `"none"` | PASS (`LiveSpec`, `Prop_TurnCommits`) |
| `comparison.rl-pr-sweep-publishes` | `"none"` | TRUE | FALSE | `"no-publish-guard"` | safety: `Inv_StoreNeverTorn` (review M1's chain) |
| `comparison.rl-pr-publish-dirty` | `"legacy"` | FALSE | TRUE | `"no-publish-guard"` | safety: `Inv_StoreNeverTorn` |
| `wit.rl-first-turn-swept` | `"none"` | TRUE | TRUE | `"none"` | witness: a first turn lost, its dirty dir swept, the turn still commits |
| `wit.rl-refused-publish-recovered` | `"none"` | TRUE | TRUE | `"none"` | witness: a refused dehydrate or checkpoint, the turn still commits |

Not modelled:

- the sweep's idle clock and its `lastTouched` bookkeeping: any moment without the session lock may sweep;
- a sweep with no session store (it leaves the dir alone);
- the drain's turn cut (`isTurnCut`, #367): a cut session is not swept;
- the blob store's own steps: the filesystem store's fences stand for every store, and `blob-store.ts` keeps the same
  fences;
- the orchestration's retry count, its reset and its lossy hand-off (`OwnedRetry.tla`);
- a runtime that hangs without exiting: it keeps the 300 s watchdog;
- the bounded wait for the dropped session's destroy;
- a session that returns to the worker it left;
- other sessions on the same client, apart from `deadClientUse`. They are covered by test, not by the model:
  `runtime-loss.test.js` kills a pooled runtime while co-tenant sessions are idle (review S10), and
  `orchestration-composition-rebuild.test.js` covers a capture after the warm parent's runtime died (review S9);
- an inline control-tool or worker-tool effect after the loss (reviews S4 and S5): the fence is checked by
  `inline-control-tools.test.js` and `tool-binding-reads.test.js`;
- a worker shutdown during a turn, as in rl1.

Test evidence (each review-M1 test fails on `ce74d928`, the code before the guard, and passes at `dd1029c6`):

- `packages/sdk/test/local/turn-lifecycle.test.js`, `review M1 (#376): the legacy publish paths never publish an
  uncommitted turn`:
  - the sweep deletes a first turn's dirty dir instead of publishing it over an empty store
    (`comparison.rl-pr-sweep-publishes`);
  - the sweep leaves a legacy head byte for byte unchanged when the turn on top of it was lost;
  - dehydrate and checkpoint refuse a dirty dir and publish a clean one (`comparison.rl-pr-publish-dirty`);
- the same file, `issue 329: the retry of a transport-loss turn hydrates the last committed snapshot and commits on
  top of it` (from rl1; it passes on both heads), the recovery of `wit.rl-refused-publish-recovered`;
- the same file, `review S1`: an error that only quotes a disconnect phrase commits;
- `packages/sdk/test/local/runtime-loss.test.js` (real Copilot CLI): one worker, the runtime child SIGKILLed mid-turn,
  its pid read from the OS and not from the runtime monitor (review M2). The turn settles within seconds, the failed
  attempt returns a transport loss, the retry commits on a fresh runtime, and there is no `session.lossy_handoff`.
  This test fails on `ac86a39e`;
- `packages/sdk/test/unit/copilot-runtime-monitor.test.mjs`: spawn claims, deferred exits during a start, exit
  watches, `isLost`, `markStopping`, the unclaimed binding (review S7) and the message classifiers.
