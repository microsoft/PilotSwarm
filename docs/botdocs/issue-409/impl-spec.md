# Issue 409: implementation steps

See [design-spec.md](design-spec.md) for the terms (Start, claim, admission,
orphan claim) and the reasons.

## Steps

1. **Regression tests first** (`packages/sdk/test/local/workflow-session-definitions.test.js`).
   Add one new `describe` block at the end of the file. Change no existing
   test. Details are in [test-spec.md](test-spec.md).

2. **Do not count a claim whose definition was deleted**
   (`packages/sdk/src/child-budget.ts`, function `childBudgetCountSql`).
   - In the claim branch (`c.creation_config -> 'workflow' ? 'sessionPin' AND
     NOT EXISTS (... workflow_runs ...)`), add:
     `AND NOT EXISTS (SELECT 1 FROM <schema>.session_workflow_definitions sd
     WHERE sd.definition_id = c.creation_config -> 'workflow' -> 'sessionPin' ->> 'definitionId'
     AND sd.deleted_at IS NOT NULL)`.
   - Add one sentence to the file's header comment, in the list of what is
     counted.
   - Callers are unchanged: `PgSessionCatalog.countBudgetChildren` and
     `requireChildBudgetLocked` (`cms.ts`), and `SessionDefinitionStore.runningChildren`
     and `requireChildBudgetLocked` (`session-definition-store.ts`).

3. **Keep a retry's answer when the freed slot is in use**
   (`packages/sdk/src/workflow/session-definitions.ts`, function
   `replaySessionStart`, the resumed-claim block that calls
   `requireWorkflowStartLimits`).
   - Wrap that call. When it throws `CHILD_LIMIT` and a fresh read of the pinned
     definition shows `deletedAt` set, do not throw; let the flow go on to
     `createWorkflow`, whose existing checks answer: another request under the
     same key is `WORKFLOW_EXISTS`/`OPERATION_CONFLICT`, and the admission is
     `DEFINITION_DELETED`. Rethrow every other error unchanged.

4. **Docs**: one sentence in `docs/developer/building/workflow-sessions.md`
   next to the Delete bullet, and one `CHANGELOG.md` entry under a new
   `Unreleased` heading.

5. **Report**: `docs/botdocs/issue-409/implementation-report.md`, written last.

## Out of scope

- No change to locks, transactions, session rows, error codes, migrations, the
  Web API, MCP, TUI or the portal. The only retry change is step 3.
- The orphan claim row itself stays (see the design's follow-up).
