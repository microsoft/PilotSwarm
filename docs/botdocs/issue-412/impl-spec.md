# Issue 412: implementation specification

See [design-spec.md](design-spec.md) for the terms (finished Workflow session,
active session, kept session) and the rule. The steps are in the order they are
made. Each step names the file, the function and the change.

## Step 1. `packages/sdk/src/workflow/store.ts`: find kept sessions

1. Import `WORKFLOW_TEST_BENCH_KIND` from `./test-bench.js` (a module with no
   imports, so no cycle).
2. Export the result type:

   ```ts
   export interface SweeperKeptSession {
       sessionId: string;          // the kept session the delete would remove
       workflowSessionId: string;  // the finished Workflow that keeps it (itself or an ancestor)
       ancestorSessionId: string;  // an active session above that Workflow
       ancestorState: string;      // that session's state
   }
   ```

3. Move the body of `enumerate` in `sweeperSoftDelete` into a private method
   `sweeperDeleteSet(client, sessionId, cascade): Promise<string[]>`, unchanged:
   with `cascade`, `cms_get_descendant_session_ids(sessionId)`; without, the
   Workflow children of the session and their Workflow children.
   `sweeperSoftDelete` calls it for its first read and its second read.
4. Add a private method `sweeperKeptAmong(client, sessionIds): Promise<SweeperKeptSession | null>`.
   One statement: a recursive CTE `chain` walks from each id up
   `parent_session_id` to the root, carrying `start_id`, `depth`,
   `session_kind`, `service_kind`, `state` and `deleted_at`. It joins the chain
   to itself on `start_id` and selects a row `w` that is a finished Workflow
   session (not deleted; `session_kind = 'workflow'`; `service_kind` is not
   `WORKFLOW_TEST_BENCH_KIND`; a run with `mode = 'live'` exists; no run has a
   status in `ACTIVE_RUN_STATUSES`) and a row `a` above it (`a.depth > w.depth`)
   that is active (`deleted_at IS NULL` and `state` not in
   `SWEEPER_ENDED_SESSION_STATES`). Order by `w.depth, a.depth, start_id`;
   `LIMIT 1`. Null when no row; an empty list returns null without a query.
5. Add the public method
   `sweeperKeptSession(input: { sessionId: string; cascade: boolean }): Promise<SweeperKeptSession | null>`:
   `sweeperKeptAmong(pool, [sessionId, ...sweeperDeleteSet(pool, sessionId, cascade)])`.
6. In `sweeperSoftDelete`, after the second read of the set (the `added`
   check) and before the owner outcome is recorded, call
   `sweeperKeptAmong(client, [input.sessionId, ...locked])`. When it finds one,
   return `{ refused: { status: "WorkflowKept", detail, kept } }` and delete
   nothing. Add `"WorkflowKept"` to the refusal status union, and `kept` as an
   optional field. Add the rule to the method's doc comment.

## Step 2. `packages/sdk/src/sweeper-tools.ts`: apply the rule on every path

1. Add `readKept(sessionId, cascade)`: calls
   `catalog.workflowStore().sweeperKeptSession(...)`. Returns `{ kept }`
   (null when the catalog has no Workflow store or the store has no such
   method: a test double deletes as before), or `{ unreadable }` when the read
   throws.
2. Add `keptReason(sessionId, kept)`: the refusal words. They name the target,
   how it relates to the finished Workflow (it is the Workflow, it belongs to
   it, or its cleanup would delete it), the active ancestor and its state, and
   say that the Workflow and the sessions under it are kept while any session
   above it is active, are cleaned with them once all have ended, and that an
   explicit delete removes them at once.
3. `evaluateCleanupEligibility`: when the target is terminal and stale, call
   `readKept(sessionId, true)` before it answers eligible. Kept: answer
   `{ eligible: false, status: "WorkflowKept", reason: keptReason(...) }`.
   Unreadable: answer `Unreadable`, as a failed status read does.
4. `scan_completed_sessions`: for a stale terminal candidate, call
   `readKept(sessionId, true)`. Kept: do not list it. Unreadable: add it to
   `unreadable`.
5. `prune_orchestrations`, session pass: after the `NotFound` check and before
   `softDeleteChecked`, call `readKept(sessionId, false)`. Kept: skip it
   silently. Unreadable: count it in `cmsUnreadable` and log a warning, as a
   failed status read does.
6. `finalCheckRefusal`: add the case `WorkflowKept`: `Refusing to clean session
   <id>: <detail>. Nothing was deleted; ...`. The final check's detail is
   `keptReason`'s middle part, built by the store from the same fields.
7. Tool descriptions of `scan_completed_sessions`, `cleanup_session` and
   `prune_orchestrations`: replace "Finished live Workflow sessions are cleaned
   like other terminal children" and its variants with the rule: a finished
   live Workflow, and every session under it, is kept while any session above
   it is active, and is cleaned with them once all have ended.

## Step 3. Sweeper agent instructions

- `packages/sdk/plugins/mgmt/agents/sweeper.agent.md`, maintenance loop step 2:
  replace "A finished live Workflow is eligible after its full terminal result
  is saved under its owner" with the rule, and say that a `WorkflowKept`
  refusal is expected and is not retried.
- `packages/sdk/plugins/mgmt/skills/sweeper/SKILL.md`, step 1: the same rule in
  one sentence.

## Step 4. Documentation

- `docs/developer/building/workflow-sessions.md`: the paragraph on the
  finished live Workflow's owner result and the Sweeper (lines 1244-1254), the
  model bullet (line 1321), the table "When the session ... Its finished
  Workflows and their results" (lines 1336-1340) and the "Only an active run is
  cancelled" bullet (line 1366): a finished Workflow and its sessions are kept,
  shown in the owner's Terminated row and fully readable, while any ancestor is
  active; the Sweeper cleans them with their ancestors once all have ended;
  `read_workflow` falls back to the owner's retained result only after that
  cleanup or an explicit delete.
- `docs/user-guide/workflows.md`, "When the session ends" (lines 262-271): the
  same rule in user words.
- `docs/proposals/workflows/data-model.md`, the "Sweeper cleanup" row (line
  115): the final check also refuses when it would delete a kept session.
- `CHANGELOG.md`: an `## Unreleased` section with one entry (no migration, no
  version change).

## Step 5. Tests

As [test-spec.md](test-spec.md) says: the new regression tests first (they fail
on `main`), then the changes to the existing tests that assert the replaced
behavior.

## Round 2 (review round 1)

Steps 6 to 9 answer the findings of review round 1 (design-spec.md §3.5, §3.6,
§7). Their regression tests come first, as in step 5.

## Step 6. `packages/sdk/src/workflow/store.ts`: hold the sessions above the target

1. Add a module function `sweeperLiveWorkflowRow(row)`: `session_kind =
   'workflow'` and `service_kind` is not `WORKFLOW_TEST_BENCH_KIND`.
2. Add a private method `sweeperAncestors(client, sessionId): Promise<Row[]>`:
   one recursive CTE up `parent_session_id` from the session's parent to the
   root; it returns `session_id`, `session_kind` and `service_kind` of each.
3. In `sweeperSoftDelete`:
   - the first `SELECT ... FOR NO KEY UPDATE` of the target also reads
     `service_kind`;
   - the NOWAIT lock of the set also reads `session_kind` and `service_kind`, and
     notes whether one of them is a live Workflow (`lockedWorkflow`);
   - after the `added` check and before `sweeperKeptAmong`: read the ancestors.
     When the target, a locked session or an ancestor is a live Workflow, lock
     every ancestor: `SELECT session_id FROM sessions WHERE session_id =
     ANY($1) ORDER BY session_id FOR SHARE NOWAIT`. SQLSTATE `55P03` throws
     `SweeperBusy` (the existing `Busy` refusal).
   - The doc comment names the new locks.

## Step 7. `packages/sdk/src/workflow/store.ts`: the event purge

Add the public method `purgeSessionEventsBefore(cutoff: Date): Promise<number>`
(design-spec.md §3.6):

1. Phase 1, on the pool: `WITH RECURSIVE workflow_trees AS (...)`: the Workflow
   sessions that are not deleted and not test benches, then their sessions that
   are not deleted, down `parent_session_id`. `DELETE FROM session_events e
   WHERE e.created_at < $cutoff AND NOT EXISTS (workflow_trees w WHERE
   w.session_id = e.session_id)`.
2. Phase 2, in `this.transaction`:
   - `SELECT s.session_id FROM sessions s WHERE` (a Workflow, not deleted, not a
     test bench) `AND NOT` (finished: a live run exists and no run has a status
     in `ACTIVE_RUN_STATUSES`) `ORDER BY s.session_id FOR SHARE OF s SKIP
     LOCKED`: the held Workflows.
   - `WITH RECURSIVE workflow_trees AS (...), kept AS (...)`: `kept` starts at
     the Workflow sessions (not deleted, not test benches) that are finished or
     not held, and goes down to their sessions that are not deleted. `DELETE
     FROM session_events e WHERE e.created_at < $cutoff AND e.session_id` is in
     `workflow_trees` and not in `kept`.
3. Return the sum of both phases' row counts.

## Step 8. `packages/sdk/src/resourcemgr-tools.ts`: `purge_old_events`

1. When `catalog.workflowStore?.()` returns a store, call
   `store.purgeSessionEventsBefore(cutoff)`; otherwise keep the old `DELETE`.
   The result keeps its fields.
2. The description adds: the events of a finished Workflow session, and of the
   sessions under it, are kept; they are its Log, readable until the session is
   deleted.

## Step 9. Formal model and documents

1. `docs/formal/workflow/retention/`: `WorkflowRetention.tla`, `gen-cases.py`
   (writes `cases.tsv`, `cases.json`, `tlc-templates.json`), the shared
   `run-tlc.sh` and `check-packet.sh`, `SHA256SUMS`, and a README with the code
   binding and the results. A row in `docs/formal/README.md`.
2. `docs/developer/building/workflow-sessions.md` and `docs/user-guide/workflows.md`:
   the event purge keeps a finished Workflow's Log.
3. `CHANGELOG.md`: the same in the Unreleased entry.
