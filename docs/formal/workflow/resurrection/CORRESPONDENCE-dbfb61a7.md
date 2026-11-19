# SessionResurrection correspondence to dbfb61a7 (FB-046, migration 0094)

Code at `dbfb61a7`, Valkyrie's final head on `waldemort/valkyrie-resurrection-guard`, base `87621a39`. It is
`8c5ad6f6` (base `4273ca01`, bound first) rebased as `de4c274d`, plus tests and docs:
`session-resurrection-0094.ts` is byte-identical to `8c5ad6f6`, and 0094's registration is unchanged. Line numbers are
as at `8c5ad6f6`. Production change: the new migration
`packages/sdk/src/migrations/session-resurrection-0094.ts`, registered as 0094 in `cms-migrations.ts`. It redefines the
6-, 8-, 9- and 10-argument `cms_create_session` bodies and `cms_create_workflow_session`; the seven-argument shim still
delegates to the eight-argument body. Models: rs1, rs2, rs3 (17, 22 and 28 of 28 as expected). Decisions: the
coordinator's 13:52Z (absent parent allowed, soft-deleted parent refused) and 13:54Z (0094 covers the Workflow-session
create; legacy bodies stamp the root of the resurrected row only; insert-first). 

| Model | Code at 8c5ad6f6 |
|---|---|
| `ParentCheck` (T1, T2, T5, T7): lock the parent FOR SHARE, refuse a soft-deleted parent, allow one with no row | `lockParent` (11-25), the first statement of every body: the parent's root and group are read under that lock |
| `AbsentLock = "insertFirst"` (rs2) | `INSERT ... ON CONFLICT (session_id) DO NOTHING RETURNING` (74). If nothing was inserted, the row is taken `FOR UPDATE` (79); a row purged in between refuses (`SESSION_DISAPPEARED`, 81). No new advisory lock |
| A live row is never re-parented | A conflict on a live row changes nothing (the deleted branch is skipped) |
| `GuardMode = "locked"`, `WalkDeleted` (rs1) | 84-95, under the row lock: when the parent changes (`IS DISTINCT FROM`, null-safe) and any descendant at any depth is live, refuse (`SESSION_RESURRECTION_HAS_LIVE_DESCENDANTS`). The recursive scan walks every row, deleted ones included; `UNION` stops a cycle |
| `T1` root on a move | The 10-argument body sets the root from the parent (as 0082 did, on every resurrection); the 6-, 8- and 9-argument bodies set it only on a parent change (100-101). A fresh legacy insert keeps no root (the recorded pre-existing gap) |
| Lifetime reset | `cms_turn_lifetime_reset` runs after the guard passes, with the row locked, before the tombstone is cleared (97). It is a no-op for a live or missing row, so the fresh and live paths need none |
| `WfCheck` (rs3, T6) | `cms_create_workflow_session` (130-162): `lockParent` before its claiming insert; root and group from the locked parent |

## Notes

1. **Not expansion for a direct SQL caller.** A `cms_create_session` call that names a soft-deleted parent is refused
   even when its own row already exists and is live (before 0094 such a call changed nothing). The session catalog
   already refuses this case before calling the function, so no supported caller changes.
2. **Parity kept, not changed.** The 10-argument body still does not write `group_id`, as 0082's body did not; the
   metrics table per arity is as before.
3. **FB-052** (adoption under a parent id with no row) remains, by the coordinator's rule; `find.fb052-adoption` is
   its model.
4. The error texts start with their codes (`PARENT_DELETED`, `SESSION_DISAPPEARED`,
   `SESSION_RESURRECTION_HAS_LIVE_DESCENDANTS`); mapping them to client errors is outside the model.
5. Regression tests: e13e5396 (the absent-target window, rs2's `find.rs2-absent-row-lock`) and 97655fe2 (the
   live-subtree reparenting, rs1's `find.rs-no-guard`) failed before 0094 and pass with it. The final head adds the
   other ordering (the first insert wins), the hard purge (`SESSION_DISAPPEARED`), and documents note 1.

## Verdict

Bound. rs1, rs2 and rs3's design holds at `dbfb61a7` (and at `8c5ad6f6`): a parent-changing resurrection with a live descendant is
refused under the row lock; a missing row is claimed by insert first; every create path, the Workflow-session one
included, checks its parent in SQL. Model correspondence only; the code review is separate.
