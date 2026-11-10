# Durable session orchestration: TLA+ models

These models check parts of the durable-session orchestration of PilotSwarm:
the turn loop and its queue, the commit of a turn across retries, the timers
(wait, cron and cron_at) and their hand-off, interruption and starvation, the
delivery of child updates, and the identity of delivered prompts. A TLC pass is
a bounded check, not a proof. A FAIL is a model counterexample.

## Status: 1.0.83 is the latest version (this line); 1.0.82 is frozen

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

1.0.83 (`src/orchestration/`, the durable Workflow intake) is the latest
version: new sessions start at it, and every continue-as-new targets it. 1.0.82
is frozen in `orchestration_1_0_82/` and stays registered for the sessions still
on it. The modules that describe 1.0.82's queue and turn are bound to the line
numbers of `198ad79a`; 1.0.83 keeps that behaviour. The intake ships switched
off: no worker sets the workflowIntake capability. The intake protocol itself is modelled in
`../workflow-v2/paired/recipient/`. The 1.0.83 run-loop changes around it (the
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
| `ForcedRefresh.tla` | A turn that ends with a forced continue-as-new (turning Workflows on in a chat, `use_package`, loading or unloading an agent, a failed model switch) keeps everything the session holds, an intake write that is due included | 6 (including 3 faults) |
| `WorkerShutdown.tla` | Every worker: graceful shutdown under one deadline (drain, workspace release, release sweep, close). As written, each step is started even after the deadline, with a zero budget, and only its wait is abandoned, so later steps can overlap a still-running one and the close can cut a legacy upload; the sweep deletes only marked (committed) sessions' local copies and dehydrates unmarked legacy ones | 11 (including 2 faults, 1 comparison and 4 witnesses) |

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
| `WorkerShutdown` | `worker.ts` 1307-1404 (`gracefulShutdown`; `bounded` 1317-1338 starts every step and races it against the time left; workspace release 1374, release sweep 1394, stop 1403). Updated to `bb162ed8` in batch ws2 (`CORRESPONDENCE-bb162ed8-ws2.md`). At `0df9e8a4` the same steps are at 1310-1408 (release sweep 1397-1405, stop 1407). The release sweep is now `sweepIdleSessions(1, { final: true })` (DRR-3b `3432b239`, DR2-006 `781441bf`): a session whose close in the Copilot CLI is not confirmed (DRR-3, `4d564f47`) is still uploaded and its local copy deleted, as at `bb162ed8`, and such sessions are taken last. Without `final` (the periodic sweep) such a session is kept and evicted again later. So the model's sweep and its `closeCut` limit (a legacy upload cut by the close) are unchanged |

Bound to `bb162ed8` (`CORRESPONDENCE-bb162ed8-so5b.md`):

| Module | Code (`orchestration_1_0_83/`) |
|---|---|
| `CarriedGiveBack` | `queue.ts`: `markCarriedWork` 456 (called at 1346), `giveBackCarriedWork` 413 (same pass), `observedChronology` 485, `giveBackDroppedPromptWork` 506 (decide-merge 1589-1590, decide-fifo 1703-1705), `peekNextDispatchFifoItem` 259 and the sweep before the pop (1685-1690); `lifecycle.ts` `restorePendingChildDigest` 486-512 |

## 3. Case taxonomy and expected results

`cases.tsv` lists all 175 cases with their module; `cases.json` gives each case
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

so5b (48 cases at `bb162ed8`, with the controller idle-wake model in `../workflow-v2/idle-wake/`): 48 of 48 as
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

### tf1 (2026-11-10): a terminal turn failure reported to the Workflow (design)

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
