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
