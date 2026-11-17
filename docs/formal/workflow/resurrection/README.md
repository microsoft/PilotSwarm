# Session resurrection (FB-046): design model

`cms_create_session` resurrects a soft-deleted session id: its conflict branch applies only where
`deleted_at IS NOT NULL`, and it takes the requested parent and root. It moves nothing below the row. A live session
below the resurrected one (left by deletion's best-effort cascade) then keeps the old root, so visibility and
authorization resolve through the wrong owner; a Workflow below it can land under another Workflow's step. The fix:
refuse a resurrection that changes the parent while any descendant is live, walking through deleted rows, decided
under the row's lock.

## What it models

`P1` and `P2` are top-level live sessions. `X` is soft-deleted, under `P1`; `Y` is its child and `D` its grandchild;
every stored root starts at `P1`. `T1` resurrects `X` under `NewParent`. It may race with `T2`, which resurrects `Y`
or `D` under its own parent, and with `T3` and `T4` (`Churn`), which resurrect `X` under `P1` and then delete it
again (the cascade leaving its children). Each transaction locks a parent FOR SHARE and its row FOR UPDATE.

| Constant | Meaning |
|---|---|
| `NewParent` | `P2` (a new parent), `P1` (the same), `Y` (its own child) |
| `DLive`, `YLive` | `D` or `Y` is live at the start |
| `GuardMode` | `locked` (the design: under `X`'s row lock), `preread` (read before any lock), `none` (the code today) |
| `WalkDeleted` | The guard's scan goes through deleted rows |
| `ParentCheck` | Every resurrection locks its parent FOR SHARE and refuses a deleted one (`lockLiveParent`) |
| `Churn`, `T2Target` | The concurrent transactions above |
| `WfCreate`, `WfCheck`, `Adopt`, `AdoptParent` | rs3: the Workflow-session create and its parent check; a create under a parent id with no row (`X`, later created, or `Q`, never) |
| `XAbsent`, `AbsentLock` | rs2: `X` missing at the start, with `T5`; how a missing row is locked (`none`, `advisory`, `insertFirst`) |

## Code binding

`CORRESPONDENCE-dbfb61a7.md` binds Valkyrie's final head `dbfb61a7` (migration 0094, identical to `8c5ad6f6`) against rs1, rs2 and rs3.

## Rules

| Rule | Predicate |
|---|---|
| Every live session's stored root is the root its parent chain reaches | `Inv_NoStaleSubtree` |
| No live session is in a parent cycle | `Inv_NoCycle` |

The guard needs no lock on ancestors or descendants. It relies on one rule for every writer: a session becomes live
only under a parent it has locked and seen live (`ParentCheck`). Then nothing can become live below a deleted `X`
while `T1` holds `X`'s lock; a resurrection of `X`'s child waits for that lock. Without the rule, a resurrection under a
deleted parent makes a stale subtree after the move (`find.rs-no-parent-check`) and allows a cycle
(`find.rs-no-parent-check-cycle`).

## Batch rs2: a row that does not exist yet (Valkyrie, 2026-11-13)

`SELECT ... FOR UPDATE` on a missing row locks nothing. If `X` does not exist when `T1` starts (`XAbsent`), `T5` can
create `X` under `P1`, create a live child `Y` under it and delete `X`, each in its own transaction, between `T1`'s
read and its upsert. The upsert's conflict branch then resurrects `X` under `P2` without the guard
(`find.rs2-absent-row-lock`). `AbsentLock` closes it in one of two ways:
- `advisory`: every creator of an id first takes a transaction-scoped lock on the id (as the `refuseDeleted` path
  already does with `pg_advisory_xact_lock`), then the parent, then the row (`rs2.absent-advisory`);
- `insertFirst`: `INSERT ... ON CONFLICT DO NOTHING` first; if the row already existed, lock it and run the guard
  (`rs2.absent-insert-first`).
The same hole is in `cms_turn_lifetime_reset`, which locks the target row before the upsert.

A Workflow session created by direct SQL (`cms_create_workflow_session` checks no parent) is a writer without the
parent rule: rs1's `find.rs-no-parent-check` is that case.

## Batch rs3: the Workflow-session create path, and adoption (FB-052)

The coordinator widened 0094 (2026-11-13 13:54Z) to `cms_create_workflow_session`: it must check the parent in SQL
(absent allowed, soft-deleted refused), so the guard does not rest on its one caller. `T6` (`WfCreate`) creates the
Workflow session `W` under `X` while `T1` resurrects `X`. With the check (`WfCheck`) it locks `X` FOR SHARE: it is
refused while `X` is deleted, or comes after the move with the new root (`rs3.wf-create-checked`,
`rs3.wf-create-checked-churn`, `wit.rs3-wf-created`). The function today reads `X`'s root with no lock, so `W` can be
inserted with the old root after the move (`find.rs3-wf-create-unchecked`).

A parent id with no row is allowed (the coordinator's rule, 13:52Z); the session's root is then itself. `T7`
(`Adopt`) creates `Z` under such an id. If the id is never created, every rule holds
(`rs3.absent-parent-never-created`). If it is created later, `Z` is adopted with a stale root
(`find.fb052-adoption`), with the whole FB-046 design on. That is FB-052, filed separately; a lock cannot be taken
on a row that does not exist, so FB-046 cannot close it. A session whose parent has no row resolves to itself
(`ChainRoot`), as `cms_create_session` stamps it.

## Cases (batches rs1, 17, rs2, 5, and rs3, 6; the rs3 packet runs all 28)

| Group | Cases | Expected |
|---|---|---|
| design | `rs.design-live-grandchild`, `rs.design-live-child`, `rs.design-t2-child`, `rs.design-t2-grandchild`, `rs.design-churn`, `rs.design-full`, `rs.design-same-parent`, `rs.design-own-child`, `rs.design-own-deleted-child` | PASS |
| finding | `find.rs-no-guard`, `find.rs-no-walk`, `find.rs-preread`, `find.rs-no-parent-check` (`Inv_NoStaleSubtree`), `find.rs-no-parent-check-cycle` (`Inv_NoCycle`) | violation |
| witness | `wit.rs-new-parent-moves`, `wit.rs-same-parent-moves` (`W_NotMoved`), `wit.rs-refused` (`W_NotRefused`) | violation (reachable) |
| rs2 design | `rs2.absent-advisory`, `rs2.absent-insert-first` | PASS |
| rs2 finding | `find.rs2-absent-row-lock` (`Inv_NoStaleSubtree`) | violation |
| rs2 witness | `wit.rs2-absent-created` (`W_NotCreated`), `wit.rs2-absent-refused` (`W_NotRefused`) | violation (reachable) |
| rs3 design | `rs3.wf-create-checked`, `rs3.wf-create-checked-churn`, `rs3.absent-parent-never-created` | PASS |
| rs3 finding | `find.rs3-wf-create-unchecked`, `find.fb052-adoption` (`Inv_NoStaleSubtree`) | violation |
| rs3 witness | `wit.rs3-wf-created` (`W_WfNotCreated`) | violation (reachable) |

## Not modelled

- Workflow placement as such (a Workflow under another Workflow's step); it follows from the stale chain.
- Deletion's own locks and its cascade beyond leaving children live.
- Roots repaired or children moved by the resurrection (the fix refuses instead).

## Results

| Batch | Run | Result |
|---|---|---|
| rs1 | 2026-11-13 05:54Z (packet sha256 `63ba171c`), `-workers 2 -Xmx2g` | 17 of 17 as expected. `rs.design-churn` 89 states; `rs.design-full` 79; `find.rs-preread` 101. The four stale-subtree findings violate `Inv_NoStaleSubtree`; `find.rs-no-parent-check-cycle` violates `Inv_NoCycle`; the three witnesses are reachable |
| rs2 | 2026-11-13 13:54Z (packet sha256 `78d76105`), as rs1 | 22 of 22 as expected. `find.rs2-absent-row-lock` violates `Inv_NoStaleSubtree` (31 states); `rs2.absent-advisory` 24 and `rs2.absent-insert-first` 25 pass; both rs2 witnesses reachable; the 17 rs1 cases as before |
| rs3 | 2026-11-13 14:00Z (packet sha256 `80157888`), as rs1 | 28 of 28 as expected. `rs3.wf-create-checked` 12 states, `rs3.wf-create-checked-churn` 290 and `rs3.absent-parent-never-created` 75 pass; `find.rs3-wf-create-unchecked` (16) and `find.fb052-adoption` (35) violate `Inv_NoStaleSubtree`; `wit.rs3-wf-created` reachable; the 22 rs1 and rs2 cases as before |
