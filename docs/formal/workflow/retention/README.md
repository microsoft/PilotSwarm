# Workflow retention (issue 412): the final check, the prune and the event purge

A finished Workflow session, and every session under it, is kept while a session
above it is active (design: `docs/botdocs/issue-412/design-spec.md`). Two
deleters decide whether to delete on a state that other transactions change:

- the Sweeper's final check, `WorkflowStore.sweeperSoftDelete`, which deletes
  the target and the sessions under it (the prune, without cascade, deletes
  only the target and its Workflow children);
- the event purge, `WorkflowStore.purgeSessionEventsBefore` (the Resource
  Manager's `purge_old_events`), which keeps the events of a finished Workflow
  and of the sessions under it.

`WorkflowRetention` checks that neither commits a delete that the committed
state at its commit forbids, while a root restarts and a Workflow's run ends.
Review round 1 of the issue's change found such a race in the final check (a
root restarting between the check and the commit). The cases reproduce it, and
the event purge of round 1, as deliberate faults.

`WorkflowPrune` checks the prune (the final check without cascade), which
leaves the ordinary sessions under its target in place: it never leaves a kept
Workflow under a deleted session, where lists and the portal no longer reach it.
Review round 2 found that round 2's check missed a Workflow under an ordinary
child of the target; that case is a deliberate fault here.

## `WorkflowRetention`: what it models

Three sessions: the root `R` (ordinary), the Workflow `W` under `R`, and the
agent session `A` under `W`. Each transaction's changes become visible at its
commit. A row lock is `share` (`FOR SHARE`) or `nku` (`FOR NO KEY UPDATE`); `nku`
conflicts with both, `share` only with `nku`.

| Transaction | Steps |
|---|---|
| Sweeper | Lock the target `nku` (waits); lock the sessions it deletes with it `nku` NOWAIT (a held one: `Busy`); with `AncLock`, lock every session above the target `share` NOWAIT (a held one: `Busy`); check on the committed state (kept: refuse); commit the delete. |
| Restart | `R` ended and its orchestration was pruned; a new first message: lock `R` `nku`, set it active, commit. |
| RunEnd | `W`'s run ends: lock `W` `nku` (the writer's rule), end the run, commit. A deleted `W` ends nothing. |
| Purge | With `PurgeMode = "locked"`: hold `W` `share`, `SKIP LOCKED`, when its run has not ended (the selection may also hold a `W` whose run ended just before the lock); decide on the committed state: `W`'s and `A`'s old events go only when `W` is deleted, or held with a run that has not ended; commit. |

| Constant | Values |
|---|---|
| `Target` | `"W"` (cleanup of `W`, which deletes `A` with it) or `"A"` |
| `RInit`, `WInit` | `R` `"ended"` or `"active"`; `W`'s run `"finished"` or `"active"` |
| `Sweep`, `Restart`, `RunEnd`, `Purge` | which transactions run |
| `AncLock` | `TRUE`: the fix; `FALSE`: round 1 (`17142cd0`), which read the sessions above without a lock |
| `PurgeMode` | `"locked"`: the fix; `"nolock"`: keeps a finished `W` but decides without holding it; `"none"`: round 1, which deletes every old event |

Properties:

| Name | Meaning |
|---|---|
| `Inv_NoKeptDelete` | The Sweeper never commits a delete when the committed state keeps `W` (and `A` under it): `W`'s run finished, `W` not deleted, `R` active. |
| `Inv_NoFinishedLogPurge` | The purge never commits a delete of the old events of a finished `W` that exists. |
| `Inv_Locks`, `TypeOK` | Lock compatibility; types. |
| `Wit_*` | Witnesses, each expected to be violated: the delete, a restart after it, `Busy`, `WorkflowKept`, a purge before a run end, a kept Log before a run end. |

Every case checks deadlock: a state where every transaction is done stutters,
so any other state with no step is reported.

## `WorkflowRetention`: code binding

The binding is the branch `waldemort/issue-412-workflows-stop-sweeping-finished-workflo`
at the round-3 commit that adds `WorkflowPrune` (the same for both modules).

| Model | Code |
|---|---|
| `S_LockTarget` | `sweeperSoftDelete`: `SELECT ... FROM sessions WHERE session_id = $1 FOR NO KEY UPDATE` |
| `S_LockSet` | `sweeperSoftDelete`: the set from `sweeperDeleteSet`, `FOR NO KEY UPDATE NOWAIT`; SQLSTATE `55P03` throws `SweeperBusy` |
| `S_LockAncestors` | `sweeperSoftDelete`: `sweeperAncestors`, then `FOR SHARE NOWAIT` on them when the target, the set or an ancestor is a Workflow that is not a test bench (always so in this model) |
| `S_Check` | `sweeperKeptAmong` on the target and the locked set |
| `S_Commit` | `cms_soft_delete_session` of the set and the target, then the commit |
| `R_Lock`, `R_Commit` | `client.ts` `_ensureOrchestrationAndSend` (from `send` and `_startTurn`): a root in state `completed` whose orchestration reads `NotFound` starts anew, then `catalog.updateSession(sessionId, { state: "running", ... })`, one `UPDATE` |
| `E_Lock`, `E_Commit` | `lockLiveSession` (`FOR NO KEY UPDATE`) before any run write (the lock-order rule of `lockRun`), then the run's end (`endRunIn`) |
| `P_Select` | `purgeSessionEventsBefore`, phase 2: `SELECT ... FOR SHARE OF s SKIP LOCKED` on the unfinished Workflows |
| `P_Decide`, `P_Commit` | phase 2: the `DELETE` with the `kept` CTE (a new statement, so it reads the committed state under the locks), then the commit |

Not modelled:

- Phase 1 of the purge (events of sessions outside every Workflow tree). Whether
  a session is in a Workflow tree never changes while it exists. Both phases are
  one transaction; a failed statement rolls both back, and the model has no
  failures.
- A cleanup with no Workflow in or above it: it cannot delete a kept session,
  and takes no new lock.
- Deeper trees, several Workflows, and explicit deletes (unchanged). The kept
  rule's ancestor chain is reduced to one session above `W`.
- The tool-level checks before the final check (scan, `cleanup_session`,
  `prune_orchestrations`): they read without locks and only skip work; the final
  check decides.

## `WorkflowPrune`: the prune and the sessions it leaves

Three sessions: the prune target `R` (ordinary), its ordinary child `O`, and the
Workflow `W` under `O`. `O` is active (idle) or ended throughout; `R` is active
(pending, no first message) or ended. `W` exists from the start, or a creation
under `O` adds it with a run that has not ended.

| Transaction | Steps |
|---|---|
| Sweeper (prune of `R`) | Lock `R` `nku` (waits); read the sessions under `R` that the delete leaves in place (`O`, and `W` when it exists); with `Check = "locked"`, lock them `nku` NOWAIT (a held one: `Busy`) and read them again (a set that grew: `Changed`); check on the committed state; commit the delete of `R`. |
| Create | Lock `O` with `CreateMode` (`share` or `nku`, waits), insert `W` with a run that has not ended, commit. |
| RunEnd | Once `W` exists with a run that has not ended: lock `W` `nku`, end the run, commit. |

| Constant | Values |
|---|---|
| `WInit` | `"none"`, `"active"` or `"finished"` |
| `OActive`, `RActive` | whether `O` and `R` are active |
| `Create`, `CreateMode`, `RunEnd` | which other transactions run, and the creation's lock on `O` |
| `Check` | `"locked"`: the fix (refuse while a Workflow is left under `R`, under the locks); `"nolock"`: the same check without the locks; `"kept"`: refuse only while a kept Workflow is left under `R`; `"none"`: round 2 (`7824eafc`), which checked only the target and its Workflow children |

| Name | Meaning |
|---|---|
| `Inv_KeptShown` | Never a kept `W` (run ended, `O` active, or `R` active and not deleted) under a deleted `R`, unless `W` was created after the prune committed. Such a `W` was created by a session that the prune had already left without its parent, as every prune on `main` leaves the sessions under its target. |
| `Inv_Locks`, `TypeOK` | Lock compatibility; types. |
| `Wit_*` | Witnesses: the delete, `WorkflowBelow`, `Busy`, `Changed`, and a creation after the prune committed. |

| Model | Code |
|---|---|
| `S_LockTarget` | `sweeperSoftDelete`: `SELECT ... FROM sessions WHERE session_id = $1 FOR NO KEY UPDATE` |
| `S_Read` | `sweeperSoftDelete`, `enumerate()`: `sweeperDeleteSet` (no cascade) and `sweeperLeftBelow` |
| `S_LockLeft` | the same NOWAIT statement locks the delete set and the sessions left below; SQLSTATE `55P03` throws `SweeperBusy` |
| `S_Check` | the DR-02 re-read of both sets (`Changed`), then a live Workflow among the locked rows left below: `WorkflowBelow` |
| `S_Commit` | `cms_soft_delete_session` of the target, then the commit |
| `C_Lock`, `C_Commit` | `cms.ts` `lockLiveParent` (`FOR SHARE`, or `FOR NO KEY UPDATE` under the child budget), then the insert of the Workflow session |
| `E_Lock`, `E_Commit` | `lockLiveSession`, then the run's end |

## Results

Batch ret2, 2026-11-26, TLC 2.19 (`tla2tools.jar` v1.7.4) on OpenJDK 21.0.13,
`-workers 2`: **31 of 31 as expected**. The 18 cases of batch ret1 are
unchanged and give the same results.

| Module | Group | Cases | Result |
|---|---|---|---|
| `WorkflowRetention` | design | `ret.restart-cleanup-workflow`, `ret.runend-cleanup-agent`, `ret.restart-runend-cleanup-agent`, `ret.purge-runend`, `ret.purge-finished`, `ret.all-workflow`, `ret.all-agent` | 7 PASS; largest 299 distinct states (`ret.all-agent`) |
| `WorkflowRetention` | finding (deliberate faults) | `find.ret-r1-restart`, `find.ret-r1-runend` (`Inv_NoKeptDelete`); `find.ret-r1-purge`, `find.ret-purge-nolock` (`Inv_NoFinishedLogPurge`) | 4 violated on their named invariant |
| `WorkflowRetention` | witness | `wit.ret-deleted`, `wit.ret-restart-after-delete`, `wit.ret-busy`, `wit.ret-kept`, `wit.ret-kept-runend`, `wit.ret-purged-then-ended`, `wit.ret-kept-log-then-ended` | 7 reached |
| `WorkflowPrune` | design | `ret.prune-finished`, `ret.prune-runend`, `ret.prune-create-share`, `ret.prune-create-nku`, `ret.prune-ended` | 5 PASS; largest 42 distinct states (`ret.prune-create-share`, `ret.prune-create-nku`) |
| `WorkflowPrune` | finding (deliberate faults) | `find.ret-r2-prune`, `find.ret-prune-kept-only`, `find.ret-prune-nolock` (`Inv_KeptShown`) | 3 violated on their named invariant |
| `WorkflowPrune` | witness | `wit.ret-prune-deleted`, `wit.ret-prune-below`, `wit.ret-prune-busy`, `wit.ret-prune-changed`, `wit.ret-prune-created-after` | 5 reached |

The counterexample of `find.ret-r1-restart` is review round 1's sequence: the
Sweeper locks `W` and `A`, checks (`R` ended), `R` locks and commits active, the
Sweeper commits the delete. The counterexample of `find.ret-r2-prune` is review
round 2's: the prune locks `R`, checks, and commits its delete while the
finished `W` under the idle `O` is kept.

## Run

```bash
python3 gen-cases.py          # only after a change to the cases
./check-packet.sh
TLA_TOOLS=<folder with tla2tools.jar> ./run-tlc.sh <out-dir>
```
