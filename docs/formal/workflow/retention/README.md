# Workflow retention (issue 412): the final check and the event purge

A finished Workflow session, and every session under it, is kept while a session
above it is active (design: `docs/botdocs/issue-412/design-spec.md`). Two
deleters decide whether to delete on a state that other transactions change:

- the Sweeper's final check, `WorkflowStore.sweeperSoftDelete`, which deletes
  the target and the sessions under it;
- the event purge, `WorkflowStore.purgeSessionEventsBefore` (the Resource
  Manager's `purge_old_events`), which keeps the events of a finished Workflow
  and of the sessions under it.

This model checks that neither commits a delete that the committed state at its
commit forbids, while a root restarts and a Workflow's run ends. Review round 1
of the issue's change found such a race in the final check (a root restarting
between the check and the commit). The cases reproduce it, and the event purge
of round 1, as deliberate faults.

## What it models

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

## Code binding

The binding is the branch `waldemort/issue-412-workflows-stop-sweeping-finished-workflo`
at the round-2 commit that adds this folder.

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
  a session is in a Workflow tree never changes while it exists.
- A cleanup with no Workflow in or above it: it cannot delete a kept session,
  and takes no new lock.
- Deeper trees, several Workflows, and explicit deletes (unchanged). The kept
  rule's ancestor chain is reduced to one session above `W`.
- The tool-level checks before the final check (scan, `cleanup_session`,
  `prune_orchestrations`): they read without locks and only skip work; the final
  check decides.

## Results

Batch ret1, 2026-11-26, TLC 2.19 (`tla2tools.jar` v1.7.4) on OpenJDK 21.0.13,
`-workers 2`: **18 of 18 as expected**.

| Group | Cases | Result |
|---|---|---|
| design | `ret.restart-cleanup-workflow`, `ret.runend-cleanup-agent`, `ret.restart-runend-cleanup-agent`, `ret.purge-runend`, `ret.purge-finished`, `ret.all-workflow`, `ret.all-agent` | 7 PASS; largest 299 distinct states (`ret.all-agent`) |
| finding (deliberate faults) | `find.ret-r1-restart`, `find.ret-r1-runend` (`Inv_NoKeptDelete`); `find.ret-r1-purge`, `find.ret-purge-nolock` (`Inv_NoFinishedLogPurge`) | 4 violated on their named invariant |
| witness | `wit.ret-deleted`, `wit.ret-restart-after-delete`, `wit.ret-busy`, `wit.ret-kept`, `wit.ret-kept-runend`, `wit.ret-purged-then-ended`, `wit.ret-kept-log-then-ended` | 7 reached |

The counterexample of `find.ret-r1-restart` is review round 1's sequence: the
Sweeper locks `W` and `A`, checks (`R` ended), `R` locks and commits active, the
Sweeper commits the delete.

## Run

```bash
python3 gen-cases.py          # only after a change to the cases
./check-packet.sh
TLA_TOOLS=<folder with tla2tools.jar> ./run-tlc.sh <out-dir>
```
