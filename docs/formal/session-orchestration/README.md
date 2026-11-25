# Durable session orchestration: TLA+ models

These models check parts of the durable-session orchestration of PilotSwarm:
the turn loop and its queue, the commit of a turn across retries, the timers
(wait, cron and cron_at) and their hand-off, interruption and starvation, the
delivery of child updates, and the identity of delivered prompts. A TLC pass is
a bounded check, not a proof. A FAIL is a model counterexample.

## Status: 1.0.86 is the latest version; 1.0.85 is frozen

1.0.85 is frozen in `orchestration_1_0_85/` as release 0.8.12 shipped it; 1.0.86
is the live `orchestration/`. `CORRESPONDENCE-latest-1086.md` records why: a
spawn's child workspace selection and a Workflow sub-agent's system message
changed what the orchestration passes to its spawn activities. The 1.0.85 to
1.0.86 hand-off is the same continue-as-new shape; no model changes.
The sections below describe the earlier lines.

## Earlier status: 1.0.85 is the latest version (Release C); 1.0.84 is frozen

1.0.84 is frozen in `orchestration_1_0_84/`; 1.0.85 is the live `orchestration/`.
`CORRESPONDENCE-latest-1085.md` records titles (FB-036/FB-040) and the FB-076
revert to main's delete behavior. The 1.0.84 to 1.0.85 hand-off is the
continue-as-new shape of the latest-1.0.83 batch below; no earlier model changes.
The sections below describe the earlier lines.

## Earlier status: 1.0.83 is the latest version (this line); 1.0.82 is frozen

In this line orchestration 1.0.83 becomes the latest version on every worker: its code moved from
`orchestration_1_0_83/` to `orchestration/`, and 1.0.82 is frozen in `orchestration_1_0_82/` (the same code as
`orchestration/` before, except the version literal). Live 1.0.82 sessions move to 1.0.83 at their next
continue-as-new. Models and batches below name the paths of the commit they were bound to; the latest-1.0.83 batch
(section 4) maps every earlier 1.0.83 binding to the new paths by byte identity.


| Item | Value |
|---|---|
| Code the models are bound to | `198ad79a32084cd06d23b00083fa136a05709b3f` (PilotSwarm 0.8.6, durable-session orchestration 1.0.82) |
| Same code at | main `7f81d217` and `e76a6133`: `packages/sdk/src/orchestration/` (the registered latest, 1.0.82) is byte-identical |
| Last full TLC run | 2026-10-27 |
| Result | 38 cases: 21 PASS, 17 FAIL, 0 VOID, 0 not run |
| Batch so2 (2026-11-08, `e76a6133`) | 16 cases of `RehydrationNotice` and `SnapshotWarmDrop`: 16 of 16 as expected, one code finding (`rn.late-cancel`) |
| Batch so3 (2026-11-08, `e76a6133`) | 35 cases of `OwnedRetry`, `IntakeDrain`, `WorkerShutdown` and the late-cancel fix: 36 of 36 as expected in the run (with `rn.late-cancel` again), two design limits, no new code finding |
| Batch ws2 (2026-11-08, `bb162ed8`) | `WorkerShutdown` with steps started after the deadline and overlapping (final review): 11 of 11 as expected; the overlap breaks no invariant |
| Re-run on v0.8.10 (2026-11-08, `8aaf5435`, `packages/sdk/src` identical to `bb162ed8`) | so2 16 of 16, so3 36 of 36, so5b 48 of 48 as expected (and fork-join fj3 91 of 91) |
| Latest-1.0.83 batch (2026-11-08, `5d8eaa46` to `4ffbf909`) | 50 cases of `VersionHandoff`, `RollingDeploy`, `DigestWindow`, `MergeRule`, `ForcedRefresh` and `IntakeDrain` with 1.0.83 as the latest version: every case as expected across seven runs (TLC 2.19, two workers, an isolated machine); no new code finding open |
| Batches so4b, so5, so5b (2026-11-08) | The late-cancel give-back fixes in 1.0.83 (`CarriedGiveBack`): so4b found three gaps, so5 and so5b check their fixes; so5b, 48 cases at `bb162ed8` (`packages/sdk/src` identical at `8aaf5435` on v0.8.10): 48 of 48 as expected |
| Batch rl1 (2026-11-23 at `936bd2a2`; re-run 2026-11-24 at `261ea6c7`, then at `f4ef5cd8` on main `1f6af957`) | 15 cases of `RuntimeLoss` (issue #329: the Copilot runtime child dies during a turn or between turns): 15 of 15 as expected (3 PASS, 12 expected violations); the fix holds, and the four defects of main (`45a01a81`; the same paths at `ac86a39e`) are reproduced; no orchestration change |
| Batch rl2 (2026-11-24, `dd1029c6`; re-run at `0b338528` on main `1f6af957`) | 8 more cases of `RuntimeLoss` for review M1 of #376 (the store's head before the turn, the eviction sweep and the legacy publish guard): 23 of 23 as expected with rl1; the sweep that published a lost first turn's dirty dir is reproduced on the code before the guard and holds with it |
| Batches tc1 and tc2 (2026-11-24, `f9b958c1` and `63024c6c` on main `1f6af957`) | `TurnCut` (a turn cut by a drain, a lost activity lock or a terminal cancel): tc1 15 of 15 as expected; tc2, with the review of #382, 26 of 26 (5 PASS, 21 expected violations) |
| Combined re-run (2026-11-25, `16e5c481`: main `9099aaa2` with #376, merged into #382) | every case of the folder: 233 of 233 as expected (89 PASS, 144 expected violations), 0 PARTIAL, 0 VOID; `RuntimeLoss` and `TurnCut` re-bound to the merged head with unchanged results and PASS state counts |

1.0.83 (`src/orchestration/`, the durable Workflow intake) is the latest
version: new sessions start at it, and every continue-as-new targets it. 1.0.82
is frozen in `orchestration_1_0_82/` and stays registered for the sessions still
on it. The modules that describe 1.0.82's queue and turn are bound to the line
numbers of `198ad79a`; 1.0.83 keeps that behaviour. The intake ships switched
off: no worker sets the workflowIntake capability. The intake protocol itself is modelled in
`../workflow/paired/recipient/`. The 1.0.83 run-loop changes around it (the
owned retry, the intake write as a drain deadline, the carried arrival flag,
the refused continue-as-new at the history cap, the continue-as-new target and
the turn routing) are modelled here by `OwnedRetry` and `IntakeDrain`, and the
worker's graceful shutdown under one deadline (every worker) by
`WorkerShutdown`, all bound to `e76a6133` (`CORRESPONDENCE-e76a6133-so3.md`). The late-cancel give-back added to
1.0.83 afterwards (the rehydration notice and the carried child digest of a queued prompt dropped by a cancel) is
modelled by `CarriedGiveBack`, bound to `bb162ed8` (`CORRESPONDENCE-bb162ed8-so5b.md`). The hydration-adjacent changes of this line
(a given-up hydration records an intake attempt in 1.0.83; the warm session is
dropped before the snapshot commit after an unsettled aborted run) are modelled
by `RehydrationNotice` and `SnapshotWarmDrop`, bound to `e76a6133`
(`CORRESPONDENCE-e76a6133.md`).

## 1. What the models cover

| Module | Models | Cases |
|---|---|---|
| `TurnLoop.tla` | The turn loop: a FIFO of mixed inputs (user, session, agent, answer, kickoff), batching and arrival order, the bootstrap boundary, cancellation tombstones, the queue capacity, timer accounting; finite-input progress | 5 (3 + 2 deliberate faults) |
| `TurnCommit.tla` | One turn across a crash and a retry: the snapshot key, a model call at most once, adoption of a saved result | 3 (1 hold, 1 fault, 1 limit) |
| `TimerGeneration.tla` | A due timer that waits behind a prompt, when the prompt's turn replaces or cancels the schedule: the old fire and the new schedule | 7 (including 2 comparisons) |
| `TimerHandoff.tla` | Release of an active timer for queued work and its restore when no turn runs (wait, cron, cron_at, budget and workspace gates) | 2 (1 hold, 1 fault) |
| `TimerInterrupt.tla` | A prompt that interrupts a wait or a cron or cron_at timer: the remaining time, `Math.round` to seconds, the release rule, a handling delay | 5 (including 3 comparisons) |
| `TimerStarvation.tla` | People run before timers: progress with finite input, with gaps and with a continuous backlog | 4 (including 1 comparison) |
| `ChildDelivery.tla` | The pending digest of child updates: first report, rank of final and terminal updates, a cancelled carrier, the digest owner | 7 (including 1 fault and 2 comparisons) |
| `DeliveryIdentity.tla` | Client message ids and the 20-id recent window: duplicates, recency refresh, eviction, a session retry | 5 |
| `RehydrationNotice.tla` | The rehydration notice of a lossy hand-off: taken by a `shouldRehydrate` timer or an interrupting prompt, given back when its prompt is not queued in the same drain pass, carried across continue-as-new; a compact timer item keeps `shouldRehydrate`; in 1.0.83 a given-up hydration records an intake attempt and sends nothing | 11 (including 2 cases for the late-cancel fix) |
| `SnapshotWarmDrop.tla` | One turn's snapshot step: after a model run aborted following an unsettled turn-control failure, the warm session is dropped before the snapshot commit; a failed drop fails the attempt, which saves nothing and is retried | 7 |
| `OwnedRetry.tla` | 1.0.83: a failed turn's retry is owned apart from the pending prompt; it runs before any other turn, alone reuses the thrown attempt's key and is carried by every continue-as-new; a lossy hand-off's retry is fresh (no key); while it is owed an armed wait is released and an agent wait is kept, its poll queued after the retry | 12 (including 4 faults and 1 comparison) |
| `IntakeDrain.tla` | 1.0.83: no continue-as-new while an intake write is due; one intake call per wake; the arrival flag is carried; a refused continue-as-new at the history cap fails the execution; no continue-as-new to an older version; 1.0.83 turns only on workers with the intake routing | 15 (including 5 faults, 1 comparison; 3 with 1.0.83 as the latest version) |
| `CarriedGiveBack.tla` | 1.0.83: a queued prompt that took the child digest and the rehydration notice carries them as markers; a cancel that drops it at dispatch, or in the same drain pass, gives them back: child entries merged by observation time and rank, nothing a later queued prompt carries, the notice only once; a `set_model` in the pre-dispatch sweep keeps the prompt queued | 33 (including 5 faults, 10 references to earlier code, 3 design limits) |
| `VersionHandoff.tla` | A live 1.0.82 session continues as new into 1.0.83: the KV FIFO prompt (no give-back markers), the pending prompt (plain, a returned error's retry, a thrown turn's retry with its key, a lossy hand-off with its notice), unread queue messages (prompts and a `set_model`; duroxide carries at most 100), the child digest, the notice and the cron schedule; an in-flight 1.0.82 history replays on its recorded version | 19 (including 6 faults, 3 design limits) |
| `RollingDeploy.tla` | A deploy that makes 1.0.83 the latest: duroxide has no version routing, so an old worker abandons a 1.0.83 item with backoff and fails it past 10 attempts; a stop-upgrade-start (recreate) deploy never reaches that | 2 |
| `DigestWindow.tla` | The child-update batch window with the late give-back: a given-back digest is delivered once, never after a newer entry, and no later than its entry's arrival plus the window; the digest's own turn runs only after queued prompts | 5 (including 1 fault) |
| `MergeRule.tla` | decide's prompt batching with the rule that a person's words never share a turn with an agent's or the runtime's prompt, decided by the sender (every runtime enqueue stamps one; a client cannot set one); a prompt with no sender that starts with a runtime header (a runtime prompt queued on 1.0.82, or a person's words quoting one) is of unknown author and merges with nothing | 15 (including 5 references to earlier code, 1 design limit) |
| `ForcedRefresh.tla` | A turn that ends with a forced continue-as-new (turning Workflows on in a session, `use_package`, loading or unloading an agent, a failed model switch) keeps everything the session holds, an intake write that is due included | 6 (including 3 faults) |
| `WorkerShutdown.tla` | Every worker: graceful shutdown under one deadline (drain, workspace release, release sweep, close). As written, each step is started even after the deadline, with a zero budget, and only its wait is abandoned, so later steps can overlap a still-running one and the close can cut a legacy upload; the sweep deletes only marked (committed) sessions' local copies and dehydrates unmarked legacy ones | 11 (including 2 faults, 1 comparison and 4 witnesses) |
| `RuntimeLoss.tla` | Issue #329: the Copilot runtime child behind a pooled client dies during a turn or between turns. The turn settles at the child's exit, not at the inactivity watchdog; the lost turn's local dir is not committed and its turn sentinel stays dirty, so the retry hydrates the last commit; the dead warm session and the dead client are dropped, so the retry starts a fresh runtime, on this worker or on another one; the turn commits when there are fewer deaths than attempts. Batch rl2 adds the store's head before the turn (none, legacy or versioned), the eviction sweep and the legacy publish paths (dehydrate and checkpoint) with the guard that refuses to publish a dir whose turn sentinel is dirty | 23 (including 4 faults, 7 comparisons and 5 witnesses) |
| `TurnCut.tla` | A runTurn attempt cut by a drain or a lost activity lock, and its retry under the same turnKey on another worker or the same one: the cut attempt is never saved, the retry never adopts a saved cancelled result (from an earlier release too) and runs from the last committed snapshot, a graceful shutdown neither releases the cut session's workspace nor reclaims its dir (also after a lost-lock cut that came before it), no legacy dehydrate, checkpoint or sweep publishes a cut attempt's files, a live worker reclaims a cut session whose retry ran elsewhere, and a session that ends clears its mark; v0.6.0-0.8.15, 0.8.16/0.8.17, the branch before its review, and upgrades from v0.6.0-0.8.15 and 0.8.16/0.8.17 | 26 (including 11 faults, 6 comparisons, 5 witnesses) |

## 2. The code these models are bound to

At `198ad79a`, `packages/sdk/src/orchestration.ts` is a thin entry point; the
implementation is in `packages/sdk/src/orchestration/` and is selected by
`packages/sdk/src/orchestration-registry.ts`. Line numbers refer to
`198ad79a` (`git show 198ad79a:<path>`), not to the current head.

| Module | Code (`packages/sdk/src/orchestration/`) |
|---|---|
| `TurnLoop` | `queue.ts`: FIFO (`appendToFifo` 169, `popNextDispatchFifoItem` 234), `drain` 653-1156, `sweepMessagesBeforePromptDispatch` 1157-1297, `decide` 1387-1552; `turn.ts` `processPrompt` 357-769 |
| `TurnCommit` | `turn.ts`: `handleGenericRetry` 304-356 (`retryCount`, `thrownTurnKey`), the turn key and the snapshot 504-570 |
| `TimerGeneration` | `queue.ts` `nextTimerCandidate` 433-474, `releaseTimerForQueuedWork` 529-580; `turn.ts` `processTimer` 1648; `lifecycle.ts` timer state (`activeTimer` 713, 1146-1167) |
| `TimerHandoff` | `queue.ts` `releaseTimerForQueuedWork` 529-580 and `settleQueuedWorkAfterDecide` 618-652 (the restore of `interruptedWaitTimer` at 641) |
| `TimerInterrupt` | `queue.ts` 975-1060 (a prompt interrupts a wait, cron or cron_at timer; `interruptedWaitTimer`, `Math.round`); `lifecycle.ts` 1146-1167 |
| `TimerStarvation` | `queue.ts` `shouldRunQueuedWorkNow` 503-528 and `decide` 1387-1552 (people before timers) |
| `ChildDelivery` | `lifecycle.ts` 442-470 (the pending child digest); `agents.ts` 349-352 (the digest becomes ready); `queue.ts` `processPendingChildDigest` 1553 and `hasReadyPendingChildDigest` 475 |
| `DeliveryIdentity` | `state.ts` `RECENT_CLIENT_MESSAGE_ID_LIMIT = 20` 440, `touchRecentClientMessageIds` 485; `queue.ts` `duplicateClientMessageIds` 398-432 and the duplicate check in `drain` 933-945 |

Bound to `e76a6133` (`CORRESPONDENCE-e76a6133.md`):

| Module | Code |
|---|---|
| `RehydrationNotice` | 1.0.82 `orchestration/queue.ts`: `compactTimerItem` 97-112, `giveBackCarriedWork` 377-396, the carried record 1126-1135, the dispatch-time drops `decide-merge` 1365 and `decide-fifo` 1443; `orchestration/lifecycle.ts` `wrapWithResumeContext`, `dropCancelledPrompt` 413-421, the carry across continue-as-new; 1.0.83 `orchestration_1_0_83/turn.ts` 512 (a given-up hydration records an intake attempt) and 194-196 (the lossy hand-off) |
| `SnapshotWarmDrop` | `session-proxy.ts` 5244-5261 (the drop) and 5604-5611 (`runTurnCommit`); `managed-session.ts` 990-993, 1697-1741 (`takeUnsettledRun`); `session-manager.ts` 3633-3649 (`invalidateWarmSession`) |

Bound to `e76a6133` (`CORRESPONDENCE-e76a6133-so3.md`, which maps each module to the inventory rows H05, I05, I08, N01,
N02, N04-N07 and N10):

| Module | Code |
|---|---|
| `OwnedRetry` | `orchestration_1_0_83/state.ts` 255-410 (`ownedRetry`), 759-761; `queue.ts` 620-629, 749-760 (`releaseTimerForOwnedRetry`), 1495-1517 (`decide`); `turn.ts` 159, 194, 364, 549-553; `lifecycle.ts` 733-740 |
| `IntakeDrain` | `orchestration_1_0_83/queue.ts` 482-520, 797-812; `runtime.ts` 253-278, 303; `lifecycle.ts` 724-776; `intake-state.ts` 534-545; `intake-wiring.ts` 326, 584; `state.ts` 804; `orchestration-version.ts` 15, 33; `activity-routing.ts` 10-22, 93-128; `session-proxy.ts` 5778 |
| `WorkerShutdown` | `worker.ts` 1307-1404 (`gracefulShutdown`; `bounded` 1317-1338 starts every step and races it against the time left; workspace release 1374, release sweep 1394, stop 1403). Updated to `bb162ed8` in batch ws2 (`CORRESPONDENCE-bb162ed8-ws2.md`). At `3766b346` the same steps are at 1263-1360 (`bounded` 1273-1293, release sweep 1349-1358, stop 1359). The worker never asks the Copilot CLI to close a session (the close of DRR-3 `4d564f47`, DRR-3b `3432b239`, DR2-006 and D3-002 is reverted to main's behaviour by `d002b3ad`), so the release sweep is `sweepIdleSessions(1)` again, as at `bb162ed8`: it deletes the local copy of a committed session and uploads, then deletes, an unmarked legacy one (it now also forgets the session's in-memory turn state, which is not modelled). So the model's sweep and its `closeCut` limit (a legacy upload cut by the worker's `stop()`) are unchanged |

Bound to `bb162ed8` (`CORRESPONDENCE-bb162ed8-so5b.md`):

| Module | Code (`orchestration_1_0_83/`) |
|---|---|
| `CarriedGiveBack` | `queue.ts`: `markCarriedWork` 456 (called at 1346), `giveBackCarriedWork` 413 (same pass), `observedChronology` 485, `giveBackDroppedPromptWork` 506 (decide-merge 1589-1590, decide-fifo 1703-1705), `peekNextDispatchFifoItem` 259 and the sweep before the pop (1685-1690); `lifecycle.ts` `restorePendingChildDigest` 486-512 |

Bound to `f4ef5cd8` (`CORRESPONDENCE-f4ef5cd8-rl1.md`, on main `1f6af957`, 0.8.18; mode `"main"` is bound to main `ac86a39e`,
0.8.17, and `1f6af957` changes none of the code it models):

| Module | Code (`packages/sdk/src/`) |
|---|---|
| `RuntimeLoss` | `copilot-runtime-monitor.ts` (the spawn claim and the per-child exit watch 185-201); `session-manager.ts` `ensureClient` 1779-1781, `_startClient` 1847-1869, `_evictClient` 1872, `_onRuntimeLost` 1886, the warm-session drop 3503-3515; `managed-session.ts` the turn's race with the exit 4592-4605 and its catch 4917-4932; `session-proxy.ts` the transport-loss drop 5139-5152 and `snapshot_unpublished` 5462-5474; `session-lifecycle.ts` `runTurnPreamble` 248-365 and `runTurnCommit` 376 (the transport-loss skip 415-427); `orchestration/turn.ts` `handleConnectionClosedRetry` 128-213 (unchanged); `@github/copilot-sdk` 1.0.34 |

Bound to `0b338528` (`CORRESPONDENCE-0b338528-rl2.md`, which re-binds every rl1 row; mode `"main"` stays bound to
`ac86a39e`). The later commits `bc339020` (the control-bridge fence, review S5), `a62fc500` (a test), `d74443b0`
(these notes), `fc898539` (a merge of main), `a108c67d` (the canvas fence recheck) and `056eb496` (a merge of main
bringing in #405, whose model-step continuation races the same runtime-exit guard; it moves the cited
`managed-session.ts` lines, as the correspondence file records) change no modelled path:

| Module | Code (`packages/sdk/src/`) |
|---|---|
| `RuntimeLoss` (rl2) | `session-manager.ts` `sweepIdleSessions` 2209 (a locked or cut session is skipped 2224-2225; the committed marker 2252-2255 and the versioned probe 2262-2267 delete a cache; the guard deletes a dirty dir 2268-2273; otherwise the legacy dehydrate 2274-2277), `_legacyPublishBlocker` 3866, `_dehydrateUnlocked` 3870 (the guard 3889-3904), `checkpoint` 4418 (the guard 4425-4429); `session-proxy.ts` `snapshot_unpublished { reason: "dirty_turn" }` 6015-6038; `session-store.ts` the versioned fences of `dehydrate` 898-907 and `checkpoint` 964-971; the rl1 paths at their `0b338528` lines |

Bound to `63024c6c` (`CORRESPONDENCE-63024c6c-tc2.md`; mode `"head"` to `f9b958c1`, the branch before its review,
whose binding is `CORRESPONDENCE-f9b958c1-tc1.md`; mode `"main"` to `ac86a39e`, 0.8.17; main `1f6af957`, 0.8.18, changes
no modelled code):

| Module | Code |
|---|---|
| `TurnCut` | `session-lifecycle.ts` `runTurnCommit` 438-450 (the cancelled skip), `recoverAlreadyCommitted` 197-229 and `commitTurnSnapshot` 456-508 (no adoption of a cancelled result; `foreign_cancelled_winner` 487-508); `session-proxy.ts` `latchCancelled` 4337-4341 and `lockCut` 4345-4351, `clearTurnCut` 2125 and 2148 (after the preamble), the drain cut 1737-1742 and 5433, `turnSaved` 5478-5484; `session-manager.ts` `markTurnCut`/`clearTurnCut`/`isTurnCut`/`_drainKeepsCut` 4373-4398, `_legacyPublishBlocker` 3752-3755 (used by `_dehydrateUnlocked` 3777-3790, `checkpoint` 4302-4306 and the sweep 2173-2179), the sweep's drain skip 2128 and 2135 and its clears 2153 and 2191, `releaseIdleWorkspaces` 4219, `destroySession` 4237; `worker.ts` 1194, 1314, 1382 and 1402 |

Both fixes in one head: `16e5c481` merges main `9099aaa2` (#376, the source of `056eb496`) into the TurnCut branch
(`606a4cd4`, the source and tests of `63024c6c`). `RuntimeLoss` and `TurnCut` are bound to it by
`CORRESPONDENCE-16e5c481-rltc.md`, which re-binds every rl2 and tc2 row and records where the two fixes meet (the
commit's skips, a loss and a cut in one attempt, the shared publish blocker, the sweep's drain-only cut skip, a lost
runtime during a drain). The models did not change; RuntimeLoss's mode `"main"` stays bound to `ac86a39e`, and
TurnCut's modes `"head"`, `"main"` and `"old"` keep their tc2 bindings:

| Module | Code at `16e5c481` |
|---|---|
| `RuntimeLoss` | `session-manager.ts` `ensureClient` 1776, `_startClient` 1865-1900, `_evictClient` 1903, `_onRuntimeLost` 1917, `ensureClientForKey` 2039, `sweepIdleSessions` 2212 (the cut skip only while draining 2231; the committed marker 2260-2263 and the versioned probe 2264-2275 delete a cache; the guard deletes a dirty dir 2276-2282; otherwise the legacy dehydrate 2283-2287), the warm-session drop 3575-3586, `_legacyPublishBlocker` 3878-3881, `_dehydrateUnlocked` 3883 (the guard 3897-3919), `checkpoint` 4436 (the guard 4441-4447); `managed-session.ts` the exit race 4694-4702 and its catch 5071-5087; `session-proxy.ts` the transport-loss drop 5291-5301, `runBody` 5567-5595, `snapshot_unpublished` 5644-5692 and 6105-6131; `session-lifecycle.ts` `runTurnPreamble` 275-374 and `runTurnCommit` 403 (the transport-loss skip 463-475) |
| `TurnCut` | `session-lifecycle.ts` `runTurnCommit` 440-452 (the cancelled skip), `recoverAlreadyCommitted` 199-231 and `commitTurnSnapshot` 481-533 (`foreign_cancelled_winner` 512-533); `session-proxy.ts` `latchCancelled` 4457-4461 and `lockCut` 4465-4472, `clearTurnCut` 2177 and 2200 (after the preamble), the drain cut 1789-1794 and 5571-5574, `turnSaved` 5637-5643; `session-manager.ts` `markTurnCut`/`clearTurnCut`/`isTurnCut`/`_drainKeepsCut` 4514-4539, `_legacyPublishBlocker` 3878-3881, the sweep's drain skip 2231 and 2238 and its clears 2256 and 2294, `releaseIdleWorkspaces` 4340, `destroySession` 4366; `worker.ts` 1194, 1314, 1382 and 1402 (unchanged) |

## 3. Case taxonomy and expected results

`cases.tsv` lists all 233 cases with their module; `cases.json` gives each case
its `mode`, expected result, `meaning`, constants, invariants and properties.
`expected` is `PASS`, or `safety` or `liveness` when a violation is expected.

| Mode | Cases | Meaning |
|---|---|---|
| `reviewed`, meaning `confirmed` | 13 | The code as written holds the property (expected PASS). |
| `reviewed`, meaning `candidate-defect` | 7 | A counterexample to the code as written: a likely bug (7 cases for six likely bugs). |
| `reviewed`, meaning `design-limit` | 5 | A counterexample that shows a limit of the design (for example the bounded 20-id window, timers behind a continuous backlog, a model call that can repeat after a crash). |
| `deliberate` | 5 | A planned break of one protection, expected to fail (`fault.*`). |
| `comparison`, meaning `proposed-fix` | 8 | A proposed fix, model-checked only (expected PASS). |

Case ids are `<group>.<name>` with the groups `loop`, `turn`, `timer`,
`progress`, `delivery`, `child`, `fault` and `comparison`.

The 16 cases of `RehydrationNotice` and `SnapshotWarmDrop` (batch so2) use the same modes: `reviewed` holds and
witnesses, `comparison` cases for earlier code (1.0.82 without the intake record; main before the warm-session drop)
and a proposed fix, and `deliberate` faults that must fail (a send while hydrating; a commit before the drop; a
failed drop ignored). `rn.late-cancel` is a reviewed case expected to fail (a candidate defect, below).

The 35 cases of batch so3 add two modes: `design-limit` cases for 1.0.83 and the worker shutdown
(`id.e76a6133-refused`, `ws.legacy-cut`), and `impl` cases (`impl.rn-late-give-back-83`, `-live`) that model the
proposed late-cancel fix in 1.0.83 and are to be bound to the fix's commit once it is written. Comparisons model
1.0.82 (`comparison.or-1-0-82`, `comparison.id-1-0-82-swallow`) and the shutdown before its deadline
(`comparison.ws-no-deadline`). `cases.json` gives each so3 case the inventory rows it covers.

The 34 `CarriedGiveBack` cases and the two `impl.rn-late-give-back-83` cases come from batch so5b. `impl` cases are
bound to `bb162ed8`; `ref.*` cases model earlier code (`67fe212c`, `3eebc211`) and must fail; `cg.old-code*` model the
code before any give-back; design limits are the markers dropped for size and the accepted older-notice case.

The 15 `RuntimeLoss` cases (batch rl1) are `rl.*` holds (PASS), `comparison.rl-main-*` cases that model main
`ac86a39e` (meaning `code-main`) and must fail on the rule each names, `fault.rl-*` cases that remove one protection of
the fix, and `wit.rl-*` witnesses that show a recovery is reachable.

The 8 `RuntimeLoss` cases of batch rl2 use the same modes. `comparison.rl-pr-*` cases model the #376 code before
review M1's guard (`deb02556`, before the rebase `ce74d928`; meaning `code-before-fix`) and must fail; the `rl.*` holds and the `wit.rl-*`
witnesses run with the store's head set to none (a first turn), legacy or versioned, and the sweep and the legacy
publish paths turned on.

The 26 `TurnCut` cases come from batch tc2, which replaced tc1's 15. `tc.*` are `impl` cases of the fix (PASS), alone
and as the second worker of an upgrade from 0.8.16/0.8.17 (`upgrade-main`) or v0.6.0-0.8.15 (`upgrade-old`);
`comparison.tc-main*` model 0.8.17 (a lost lock drops the turn; the shutdown already keeps a drain-cut session, but
not one cut by a lost lock before the shutdown began); `comparison.tc-head*` model the branch before its review
(`f9b958c1`: a legacy sweep publishes the cut files once the retry's failed probe cleared the mark, a live worker
never releases a cut session whose retry ran elsewhere, a destroyed session keeps its mark and dir); the eleven
`fault.tc-*` remove one protection each and must fail; the five `wit.tc-*` witnesses show reachable behavior: the cut
body returning before the shutdown's release, the upgrade residual (after 0.8.17 saved the cancelled attempt, the
retry on the fix runs the turn on top of the saved cut content, or leaves that content in the store), an ordinary
lost-lock cut, a shutdown that begins after a lost-lock cut, and the live reclaim of a cut session. tc1's
`wit.tc-lingering-mark` (A keeps the mark and its local copy after the retry ran on B) is retired to
`cases-retired.json`: the live sweep now reclaims that copy.

## 4. Results

Last full run: 2026-10-27 (about 43 s in all), TLC 2.19 (`-workers 1`, `-seed 1`,
Java 21, a limit of 120 s per case, heap 1.5 GiB), 8 modules and 38 cases. SANY
accepted all modules.

| Outcome | Cases |
|---|---|
| PASS | 21 (13 confirmed holds, 8 proposed fixes) |
| FAIL (a violation was found) | 17 |
| PARTIAL (timeout) | 0 |
| VOID | 0 |

Of the 17 FAIL cases, 12 describe the code of that commit: 7 point at likely
bugs (six bugs) and 5 show design limits. The other 5 are deliberate faults.
All 38 results matched their predictions. The runs explored 29,346 states in
all (10,820 distinct). The 7 likely-bug cases were reproduced in a code harness
at `198ad79a` (the real orchestration code with a fake durable context; one
case on a local worker with a scripted model; one case needs a 200 ms handling
delay in the harness); no test ran in a deployed cluster. Four design-limit
cases were confirmed by tests; `turn.model-call-once` was not run in code. The
proposed fixes were only model-checked.

A PASS holds only inside each model's small limits (a few inputs, one session,
one timer).

### Batch so2 (2026-11-08, bound to `e76a6133`)

16 cases, TLC 2.19, two workers, on an isolated machine: 16 of 16 as expected (7 PASS, 9 expected violations), no
PARTIAL, no VOID. The existing 38 cases were not run again: their code is unchanged.

One code finding: `rn.late-cancel` violates `Inv_NoticeAccounted` in 5 steps. After a lossy hand-off, a user prompt
interrupts a `shouldRehydrate` wait and takes the rehydration notice into its text; it is queued; it is cancelled at
its dispatch (`decide-merge` or `decide-fifo`). The give-back runs only within the drain pass that stashed the prompt,
so the notice is lost and the model is never told about the hand-off. This is the code of 1.0.82, which every session
runs (`orchestration/queue.ts` 1365, 1443), and of 1.0.83 (`orchestration_1_0_83/queue.ts` 1459, 1561). The proposed
fix, giving the notice back at those drops too, passes (`comparison.rn-late-give-back`). The defect is not yet
reproduced in code.

### Batch so3 (2026-11-08, bound to `e76a6133`)

36 cases (the 35 added here and `rn.late-cancel` again), TLC 2.19, two workers, on an isolated machine: 36 of 36 as
expected (13 PASS, 23 expected violations), no PARTIAL, no VOID. All four modules parsed. No new code finding.

- `OwnedRetry`, `IntakeDrain` and `WorkerShutdown` hold in their PASS cases (safety and liveness); each deliberate
  fault fails on its named invariant; the six witnesses are reached.
- `comparison.or-1-0-82` (the thrown key stays for the next turn) and `comparison.id-1-0-82-swallow` (a refused
  continue-as-new is swallowed and the history grows past the cap) show what 1.0.83 changes.
- `comparison.ws-no-deadline` fails `Prop_WorkerExits`: without the deadline a hung step blocks the exit.
- Design limit `id.e76a6133-refused`: the latest version is 1.0.82 at `e76a6133`, so a 1.0.83 session's first
  continue-as-new is refused by `assertIntakeContinueAsNewTarget` and fails the execution. Accepted as a known
  limit: 1.0.83 is unreleased and exists only behind the test gate; failing loudly is safer than a silent
  downgrade; unit tests cover the refusal (`orchestration-intake-1-0-83.test.mjs` 310-311, 475-476). Before 1.0.83
  becomes the default, make it the latest version and run `id.e76a6133-refused` again (then expected PASS).
- Design limit `ws.legacy-cut`: when the deadline cuts the dehydrate of an unmarked legacy session and the
  worker-local folder does not survive the exit, that session's local state is lost. Committed (marked) sessions
  stay recoverable in every case (`ws.committed`, `ws.live`). Accepted as a known limit: the default deadline is
  75 s (60 s drain, `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS`, plus 15 s grace, `PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS`),
  below the worker pod's `terminationGracePeriodSeconds` of 90 s (`deploy/k8s/worker-deployment.yaml` 24); without
  the deadline Kubernetes killed a hung shutdown at 90 s and the same session could be lost. Keep the default
  deadline below the pod's grace period.
- `impl.rn-late-give-back-83` and `-live` pass: the proposed late-cancel fix in 1.0.83 (give the notice back at the
  dispatch cancels) keeps the notice and still delivers it. They model the fix, not written code; batch so5b binds
  them to `bb162ed8`.

### Batches so4b, so5 and so5b (2026-11-08, the late-cancel give-back in 1.0.83)

so4b (25 cases at `67fe212c`, the first give-back): 23 of 25 as expected; the 2 mismatches and 4 predictions were
code findings, all fixed in 1.0.83 in place:

- Two cancels lost a child's newest update: the second give-back counted the restored, older pending entry as newer
  (`restorePendingChildDigest` was called with no chronology). Fixed by ordering by `observedAtMs`.
- After one cancel, an older child entry or an older rehydration notice could reach the model after a newer one that a
  later queued prompt carried. Fixed by not giving back what a later queued prompt carries (for a child entry, only
  when the later one ranks at least as high, so a finish is never dropped for a later progress note).
- A `set_model` command in the pre-dispatch sweep continued as new while `decide` held the popped prompt, so the prompt
  and what it carried were lost. Main's 1.0.82 has the same shape (`orchestration/queue.ts` 1431, 1438; `lifecycle.ts`
  820) and keeps it as a known issue until the next live version. Fixed in 1.0.83 by sweeping before the pop.

so5 (33 cases at `3eebc211`): 32 of 33 as expected; the mismatch was the same-pass give-back restoring an older notice,
which blocked the newer one. Fixed in `b8aa360f` (the same-pass give-back leaves to a later stash prompt what it
carries).

ws2 (11 cases at `bb162ed8`, final review): `bounded` starts every step even past the deadline and abandons
only its wait, so after a late drain the workspace release, the release sweep and the close can run at the same
time, and the close can cut a legacy upload (its local copy stays). `WorkerShutdown` now models that; 11 of 11 as
expected: committed sessions stay recoverable, only marked copies are deleted, the worker exits; the legacy loss at
exit stays the accepted limit (`ws.legacy-cut`). A unit test records the same order of starts.

so5b (48 cases at `bb162ed8`, with the controller idle-wake model in `../workflow/idle-wake/`): 48 of 48 as
expected. Known limits, accepted: a marker dropped because the item would be too large cannot be given back; and when
an older queued prompt carries a rehydration notice, the pass's newer notice is kept back (the older notice is already
in that prompt's text, so the model is told once and nothing is lost).

### Latest-1.0.83 batch (2026-11-08)

Bound to `5d8eaa46` (handoff, rolling deploy, digest window, intake), `4ffbf909` (merge rule) and `91def26a`
(forced refresh); `CORRESPONDENCE-latest-1083.md` maps each model to code and gives the byte-identity of
every earlier binding at `91def26a`.

Runs, each case once, all as expected, no PARTIAL, no VOID:

| Run | Head | Cases | What it showed |
|---|---|---|---|
| design | none (before the code) | 26 | The hand-off and deploy models behave as designed. |
| interim | `5d8eaa46` | 29, and 202 earlier cases re-run | The hand-off keeps everything; the version checks above hold; with 1.0.83 latest its continue-as-new targets itself (the earlier limit that a 1.0.83 session failed at its first continue-as-new is closed); a stop-upgrade-start deploy passes and a rolling flip can fail a session. Two digest-window cases failed on a model error (the digest's own turn may not run before queued prompts); corrected and re-run. |
| digest window | `0b031b03` (comment-only change) | 5 | A given-back digest is delivered once, in order, within its window. |
| merge rule | `c9b23671` | 7 | The merge rule held only for prompts that carry a sender; two code findings: several agent and runtime prompts carried none, and a client event could set one. |
| merge rule, fixed | `2422c33e` | 8 | With every runtime prompt stamped and client senders dropped, a person's words never share a turn with another prompt. |
| final | `91def26a` | 17 | The forced continue-as-new keeps everything, an intake write that is due included; a prompt queued on 1.0.82 without a sender is told apart by its runtime header. |
| merge barrier | `4ffbf909` | 15 | With the barrier, a person's words never share a turn with another's prompt, also when they quote a runtime header or when runtime prompts queued on 1.0.82 are drained; at `91def26a` such quoted text merged with an agent's prompt (`ref.mr-91def26a-quoted-header`). |

Code findings from this batch, all fixed in 1.0.83: the registry entry for 1.0.82 had to point at the frozen code and
stamp its own version (checked before binding); agent and runtime prompts with no sender; a client-set sender; a
person's text with no sender that quotes a runtime header was taken for runtime traffic and could merge with an agent's
prompt (now of unknown author, a merge barrier).

Known limits, accepted:

- A rolling deploy that flips the latest version worker by worker can fail a session: an old worker that fetches a
  1.0.83 item backs off and, past 10 attempts (about 5 minutes), fails it. Deploy by stopping every worker, upgrading,
  then starting them (`rd.one-phase`, `rd.recreate`).
- A prompt queued on 1.0.82 and cancelled at its dispatch on 1.0.83 has no give-back markers, so what it took is not
  given back, as on 1.0.82 (`vh.legacy-late-cancel`).
- Duroxide carries at most 100 unread queue messages across a continue-as-new (`vh.carry-cap`).
- 1.0.82's `set_model` in the pre-dispatch sweep can still drop the prompt it popped, until that session moves to
  1.0.83 (`vh.82-sweep-set-model`).
- A parent agent's plain message queued on 1.0.82 without a sender still counts as a person's
  (`mr.legacy-parent-plain`).
- A forced continue-as-new can happen while an intake write is due; the carried intake state keeps the write, which
  the next execution makes (`wit.fr-forced-while-due`, `fr.live`). The rule that no continue-as-new happens while a
  write is due holds for the idle continue-as-new only.
- A given-back digest that holds only a newer entry waits out that entry's batch window (`dw.*`).

### tf1 (2026-11-10): a terminal turn failure reported to the Workflow (bound to 069eca30)

Runs (2026-11-10, TLC 2.19, two workers, 600 s per case): the design run, 63 of 63 as expected (the three findings of the code before the fix violate their liveness property; every fix case passes), and the run with the drop on success, 72 of 72 as expected.

The code binding of this fix (all three models) is `../workflow/orchestration/CORRESPONDENCE-tf1-069eca30.md`.

1.0.83 is changed in place (it is deployed nowhere). `OwnedRetry` gains `AllowExhaust` (the retry fails with its
retries spent: the turn is terminal and the session goes idle with an error) and `Report` (`"none"`: the code before
the fix; `"fix"`: a turn that carries a Workflow visit owes the store a failure report, a durable activity, carried
across continue-as-new); the actions `RetryExhausted` and `ReportSend`; the rules `Inv_NoReportBeforeTerminal`,
`Inv_ReportNotLost`, `Inv_ReportOnce` and `Prop_TerminalReported`; the faults `report-early` and
`drop-report-at-can`. `AllowLaterSuccess` (`LaterSuccess`): a later turn that succeeds while the report is owed drops
it, as `d3230de4` does; `or.terminal-report-later-success` checks `Prop_TerminalSettled` (sent or dropped) and a
witness shows the drop. Cases (batch tf1): `or.terminal-no-report` (the code before the fix: violated),
`or.terminal-report`, `or.terminal-report-safety-wait`, `-agent` (PASS), the two faults and a witness. `TurnLoop` is
unchanged: the report is an activity before the session idles, and it changes no queue order.

### Reverts at `3766b346` (2026-11-11): no Copilot CLI close, no fenced first start

`d002b3ad` removes the Copilot CLI session close and `ca1a86f8` the fenced first start; both return to main's
behaviour. No model, case or expected verdict changes, and no TLC run is needed: no model contains the CLI close
(`WorkerShutdown` is bound to `bb162ed8`, before it; see its row in section 2), and no model took the fenced start
(`../workflow/continued-session/CORRESPONDENCE-069eca30.md`).

Known limit, as on main (not modelled: no model contains the Sweeper): a first message starts the session's
orchestration, then updates its row (`state` running, `orchestration_id`), then enqueues. A Sweeper that read the
orchestration as NotFound and makes its final check anywhere from the first message's initial read of the live row and
lineage to its row update (before or after the start) finds the same row version and no `orchestration_id`, so it
soft-deletes the session; the update defeats the cleanup only if it lands before that final locked check. The row update that follows leaves `deleted_at`
set (`cms_update_session` does not write it). A 1.0.83 turn on a worker with the Workflow store reads the row's
deletion first and runs no model and no tool (review DR2-001, `session-proxy.ts` 2517-2535), so that first message is
dropped; a frozen version's turn, or a worker without the Workflow store, has no such guard. For a Workflow agent session the same guard is checked by
`fix.cc-dr2-001-*` and `impl.cc-final-live` in `../workflow/continued-session/`.

### Batch rl1 (2026-11-23, bound to `f4ef5cd8`): a Copilot runtime that dies (issue #329)

First run on 2026-11-23 at `936bd2a2` (main `45a01a81`). Re-run on 2026-11-24 after the rebase onto main `ac86a39e`
(0.8.17), with the code bound to `261ea6c7`: the same 15 results and the same state counts. #367 moved the bound
lines and did not change the modelled paths. Re-run again on 2026-11-24 after the rebase onto main `1f6af957` (#392,
0.8.18), with the code bound to `f4ef5cd8` (`261ea6c7` rebased): the same 15 results and the same PASS state counts.
`1f6af957` changes no modelled code: it gives a session without native tasks an empty `customAgents` list (session
configuration), which moves the later `session-manager.ts` lines by 4, and edits doc comments in `types.ts`
(`CORRESPONDENCE-f4ef5cd8-rl1.md`).

15 cases of `RuntimeLoss`, TLC 2.19 (tla2tools v1.7.4), Java 21, `-workers 2 -Xmx2g`, 300 s per case: 15 of 15 as
expected, no PARTIAL, no VOID. SANY accepted the module.

| Case | Result |
|---|---|
| `rl.safety`, `rl.live`, `rl.live-one-worker` | PASS (107, 107 and 63 distinct states) |
| `comparison.rl-main-torn`, `-dead-warm`, `-watchdog`, `-sentinel` | safety violation, as expected: main commits the torn dir, reuses the dead warm session, settles at the watchdog and clears the sentinel |
| `comparison.rl-main-live` | liveness violation, as expected: on one worker, main's retries reuse the dead warm session and the turn never commits |
| `fault.rl-commit-on-loss`, `-reuse-warm`, `-keep-dead-client`, `-no-exit-watch` | safety violation, as expected: each protection of the fix is needed |
| `wit.rl-turn-loss-recovered`, `-moved-recovery`, `-idle-loss-recovered` | witness reached, as expected |

Bounds: at most 4 attempts and 3 deaths, a death between turns allowed, at most one move to another worker; one
session and one turn after a committed one. Fairness: weak fairness on `Start`, `Finish`, `SettleOnExit`,
`SettleByWatchdog` and `Postamble`; deaths and moves are free.

Not covered: the orchestration's retry count and its lossy hand-off (`OwnedRetry`; the fix does not change them), a
runtime that hangs without exiting (it still settles at the 300 s watchdog), the bounded wait for the dead session's
destroy, a first turn with an empty store (batch rl2 covers it), a session that returns to the worker it left, and other sessions on the
same client (in main a single session's retry reaches its dead warm session before the pool, so the pool rule is
checked by `fault.rl-keep-dead-client`).

Not changed by the model, and reported with the fix: on one worker the lossy hand-off at `turn.ts` 165-213 resets
`retryCount` to 0, so a runtime that dies on every attempt is retried without end (each round a lossy hand-off). With
the fix a death no longer repeats by itself, because each retry starts a fresh runtime.

### Batch rl2 (2026-11-24, bound to `0b338528`): the legacy publish guard (review M1 of #376)

Batch rl1 left out a first turn with an empty store. There the eviction sweep found no committed marker and no
versioned snapshot, so it took the legacy path and archived the lost turn's dirty local dir over the store, after
the dehydrate activity had reported the turn unpublished (review M1). The legacy archive excludes the turn sentinel,
so the next hydration found a clean dir and resumed the torn turn. The fix, `_legacyPublishBlocker`, refuses every
legacy publish (the sweep, the dehydrate activity, the drain's dehydrate and the safety checkpoint) while the
session's turn sentinel is dirty; the sweep deletes such a dir and the store keeps its last commit
(`CORRESPONDENCE-0b338528-rl2.md`).

8 new cases of `RuntimeLoss`, run with the 15 of rl1 under the same settings (TLC 2.19, tla2tools v1.7.4, Java 21,
`-workers 2 -Xmx2g`, 300 s per case): 23 of 23 as expected, no PARTIAL, no VOID. SANY accepted the module. The rl1
cases keep their results and state counts. First run at `dd1029c6` on main `ac86a39e`; re-run on 2026-11-24 after the
rebase onto main `1f6af957`, bound to `0b338528` (`dd1029c6` rebased): the same 23 results, each violation on the same
invariant, and the PASS cases keep their state counts (an exhaustive search). A violation's or a witness's count is
where the two-worker search stopped, so it varies by a few states from run to run (9 of the 19 differ from the first
run; `comparison.rl-pr-sweep-publishes`, for example, gave 52, and five more runs gave 50 to 51, where one worker
gives 38 every time). The branch's later commits change no modelled path: `bc339020` adds the control-bridge fence
checks (review S5; an inline control-tool effect, not modelled), `a62fc500` adds a test, `fc898539` merges main,
`a108c67d` rechecks the fence before each canvas write (the same unmodelled effect) and `056eb496` merges main (#405;
its continuation races the same runtime-exit guard).

| Case | Result |
|---|---|
| `rl.first-turn-safety`, `rl.legacy-head-safety`, `rl.versioned-head-sweep-safety` | PASS (754, 446 and 248 distinct states) |
| `rl.first-turn-live` | PASS (754 distinct states; `Prop_TurnCommits`) |
| `comparison.rl-pr-sweep-publishes` | safety violation, as expected: before the guard the sweep publishes a lost first turn's dir over an empty store (`Inv_StoreNeverTorn`, 50 to 53 distinct states with two workers, 38 with one) |
| `comparison.rl-pr-publish-dirty` | safety violation, as expected: before the guard a dehydrate or checkpoint publishes a dirty dir over a legacy head (`Inv_StoreNeverTorn`, 43 distinct states) |
| `wit.rl-first-turn-swept`, `wit.rl-refused-publish-recovered` | witness reached, as expected: a swept dirty first turn and a refused publish both still lead to a commit |

Bounds: as rl1 (at most 4 attempts and 3 deaths, a death between turns, at most one move; no move in
`wit.rl-first-turn-swept`), with the sweep and the legacy publish allowed at any moment the session lock is free.

Not covered: the sweep's idle clock, a sweep with no session store, the drain's turn cut (a cut session is not
swept), the blob store's own steps (it keeps the same versioned fences as the filesystem store), and the rest of rl1's
list apart from the first turn. Other sessions on the killed runtime's client and a capture after the parent's
runtime died are covered by `runtime-loss.test.js` and `orchestration-composition-rebuild.test.js`, not by the
model.

### Batch tc1 (2026-11-24, bound to `f9b958c1`): a turn whose activity lock was lost

0.8.16 (#367) stopped saving a turn the worker's drain cuts and marks the session cut so the shutdown leaves it held.
A lost lock outside a drain still saved the cancelled attempt under the turn's key, and the retry adopted it: the
orchestration ended the turn without running it. The fix skips that commit, never adopts a stored cancelled result,
and marks the session until its next attempt starts here. `TurnCut.tla` models 0.8.15, 0.8.17 and the fix, alone and
in an upgrade, with one session, one turn, one cut attempt and one retry (a first or a later turn; a drain or a lost
lock).

Run (2026-11-24, TLC 2.19, `-workers 2 -Xmx2g`, 300 s per case, every case under 10 s): 15 of 15 as expected.
5 PASS (`tc.safety`, `tc.live` with `Prop_TurnRuns` under the stated fairness, `tc.upgrade-main`, `tc.upgrade-old`,
`comparison.tc-main-release`); 10 expected violations (`comparison.tc-main` and the faults `adopt-recover` and
`adopt-commit` violate `Inv_TurnNotDropped`; `commit-cut` `Inv_NoCancelledCommit`; `no-lock-mark`
`Inv_NoAbortedHandOff`; `no-release-skip` and `no-sweep-skip` `Inv_ShutdownKeepsCut`; the three witnesses their
`W_*` predicate); 0 unexpected, 0 PARTIAL, 0 VOID. The adopt-commit trace adopts at `A2Commit` after A's 0.8.17 body
saved the cancelled attempt, the adopt-recover trace at `A2Start`.

First run at `2078582c` (main `ac86a39e`). Re-run on 2026-11-24 after the rebase onto main `1f6af957` (0.8.18), with
the code bound to `f9b958c1` and the model and cases from `35a68656` (byte-identical to the first run's): the same 15
results. The PASS cases found 122 (`tc.safety`, `tc.live`), 140 (`tc.upgrade-main`), 196 (`tc.upgrade-old`) and 136
(`comparison.tc-main-release`) distinct states; the first run recorded no counts. 0.8.18 moved the bound
`session-manager.ts` lines and changed no modelled path (`CORRESPONDENCE-f9b958c1-tc1.md`).

Not covered: a second retry, the orchestration's retry count, an attempt that completes before its cancel lands, a
worker restart, a turn that lost its Copilot runtime, and #364's late shutdown cut (see the correspondence file).

### Batch tc2 (2026-11-24, bound to `63024c6c`): the review of the lost-lock fix

The review of #382 found that a cut session's files could still be published, and that a live worker kept them. A
legacy dehydrate, checkpoint or eviction sweep published a session whose retry's probe on this worker failed (the
mark was cleared before the probe) or whose turn ran without the lifecycle protocol (no turn sentinel), and the live
eviction sweep skipped a cut session forever, so the worker kept its workspace and local copy (MF-1, MF-2). A
shutdown that began after a lost-lock cut released the session cleanly, as 0.8.17 does (SF-6). A destroyed session
kept its mark (SF-1). An older build's cancelled commit that wins the CAS against the fix's retry was reported as
the retry's publish (SF-2). The fix adds a publish guard (`_legacyPublishBlocker`: a dirty turn sentinel or the cut
mark) to the legacy dehydrate, the checkpoint and the sweep, keeps the sweep's skip only while the worker drains, lets
the live sweep release a cut session and delete its dir, clears the mark only after the retry's preamble resolved the
session and when the session is destroyed, and returns a retry beaten by an older build's cancelled commit unpublished
(`foreign_cancelled_winner`). `TurnCut.tla` adds a terminal cancel, a shutdown that begins after an ordinary cut, a
failing probe on the retry, the destroy, the publish guard and the live eviction sweep, and a fourth mode, `"head"`,
for the branch before its review. Mode `"old"` is now v0.6.0, the first versioned-snapshot release, to 0.8.15.
`A1Cancel` and `SdBegin` are not fair (review C-5): a cut and a shutdown are external events, so `Prop_TurnRuns` asks
only that a cut that happened leads to the retry running the turn.

Run (2026-11-24, TLC 2.19, `-workers 2 -Xmx2g`, 300 s per case, every case under 10 s): 26 of 26 as expected.
5 PASS (`tc.safety` and `tc.live`, 632 distinct states each, `tc.live` with `Prop_TurnRuns`, `Prop_LiveRelease` and
`Prop_EndReclaims` under the stated fairness; `tc.upgrade-main` 862; `tc.upgrade-old` 1,006;
`comparison.tc-main-release` 842); 17 expected safety violations (`comparison.tc-main` `Inv_TurnNotDropped`;
`comparison.tc-main-late-shutdown` `Inv_ShutdownKeepsCut`; `comparison.tc-head` `Inv_NoCutPublish`; the faults
`commit-cut`, `adopt-recover`, `adopt-commit`, `no-lock-mark`, `no-release-skip`, `no-sweep-skip`, `no-publish-guard`,
`sentinel-only-guard` and `clear-before-probe` on their rules; the five witnesses on their `W_*` predicates); 4
expected liveness violations (`comparison.tc-head-live` and `fault.tc-sweep-skip-undrained` `Prop_LiveRelease`;
`comparison.tc-head-end` and `fault.tc-no-destroy-clear` `Prop_EndReclaims`); 0 unexpected, 0 PARTIAL, 0 VOID.
Every counterexample was read and fails for its intended reason.

First run before the rebase, on main `ac86a39e`. Re-run on 2026-11-24 after the rebase onto main `1f6af957` (0.8.18),
with the code bound to `63024c6c`: the same 26 results and violated rules, and the same distinct-state counts for every
PASS and liveness case. A safety violation's count moves by a few states between runs, because two TLC workers reach
the first violating state in a different order. 0.8.18 moved the bound `session-manager.ts` lines and changed no
modelled path (`CORRESPONDENCE-63024c6c-tc2.md`).

Bounds: one session, one turn, one cut attempt and one retry; the scenario (a first or later turn, with or without
the lifecycle protocol, cut by a drain, a lost lock or a terminal cancel) is chosen in `Init`; full state space.
Not covered: an attempt that completes before its cancel lands, and the body's sends after a cancel (both
unit-tested); a second retry and the retry count; a retry on A beside B's, or a shutdown during it; a retry on A, or
a terminal cancel, without the lifecycle protocol; a worker restart or an in-process stop and start; the dehydrate
and checkpoint activities apart from the sweep, whose publish rule they share (see the correspondence file).

### Combined re-run (2026-11-25, bound to `16e5c481`): RuntimeLoss and TurnCut in one head

`16e5c481` merges main `9099aaa2` (#376, the RuntimeLoss fix) into the TurnCut branch, so both fixes run in one head
for the first time. The merge changed no model and no case: `RuntimeLoss.tla` and `OwnedRetry.tla` are main's,
`TurnCut.tla` is the branch's, and every record of the merged `cases.json` equals the record of the parent it came
from. `CORRESPONDENCE-16e5c481-rltc.md` re-binds every rl2 and tc2 row to the merged lines and records the five places
where the fixes meet; in each, a RuntimeLoss scenario reduces to rl2's binding and a TurnCut scenario to tc2's.

Run of the whole folder (2026-11-25, TLC 2.19, tla2tools v1.7.4, Java 21, `-workers 2 -Xmx2g`, 300 s per case, the
longest case 18 s): SANY accepted all 21 modules; 233 of 233 cases as expected. 89 PASS, 134 expected safety
violations and 10 expected liveness violations, each on the rule its record names; 0 unexpected, 0 PARTIAL, 0 VOID.
`RuntimeLoss` (23 cases) and `TurnCut` (26) give rl2's and tc2's results, and their PASS cases keep their distinct-state
counts: `rl.first-turn-safety` and `rl.first-turn-live` 754, `rl.legacy-head-safety` 446,
`rl.versioned-head-sweep-safety` 248; `tc.safety` and `tc.live` 632, `tc.upgrade-main` 862, `tc.upgrade-old` 1,006,
`comparison.tc-main-release` 842. A violation's count is where the two-worker search stopped (for example
`comparison.rl-pr-publish-dirty` stopped at 37 distinct states, where rl2 recorded 43).

Not covered, beyond rl2's and tc2's lists: an attempt that both loses its Copilot runtime and is cut. Neither model
has both events in one attempt; the code skips its commit as cut, after dropping the dead warm handle (the
correspondence file, interaction 2). A release cut from main `9099aaa2` before #382 lands is not a mode of `TurnCut`.

## 5. How to run

Java 17 or later is required.

```sh
TLA_TOOLS=<dir with tla2tools.jar> ./check-packet.sh
TLA_TOOLS=<dir with tla2tools.jar> ./run-tlc.sh [out]
```

`run-tlc.sh` pins `tla2tools.jar` v1.7.4 by SHA-256, runs SANY on every module
named in `cases.tsv`, then TLC on every case (`-workers 2 -Xmx2g`, a limit of
`TLC_CASE_SECONDS` per case, default 300 s). Read `<out>/executions.tsv` and
each case's `tlc.log`. Exit code 0 means no violation in the bounded search,
12 a safety violation, 13 a liveness violation, 124 a timeout (PARTIAL, never
PASS); other codes are setup or model errors. The 38 settings files of the
2026-10-27 run state `CHECK_DEADLOCK FALSE`, so a finished run is a final
state. The so2 and so3 cases that expect PASS or a witness state
`CHECK_DEADLOCK TRUE`: their modules have an explicit final stutter, so a
deadlock there is a model error. The recorded run above used one worker; the
runner uses two, which can change the state counts of cases that stop at a
violation but not the verdicts. `SHA256SUMS` pins every file named above. The settings files are generated from `cases.json` and
`tlc-templates.json` (`../tlc_cases.py`) and are not committed.
