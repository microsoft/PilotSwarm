# Issue 409: test specification

See [design-spec.md](design-spec.md) for the terms (Start, claim, admission,
orphan claim).

All commands run on the dev builder pod, in the task worktree, against a
disposable local PostgreSQL 16 on a free port. Ambient `PG*` and `AZURE_*`
variables are unset first.

```bash
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE \
      AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_FEDERATED_TOKEN_FILE AZURE_AUTHORITY_HOST
export PS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/pilotswarm
export DATABASE_URL=$PS_TEST_DATABASE_URL
cd packages/sdk
```

## New regression tests

File: `packages/sdk/test/local/workflow-session-definitions.test.js`, new block
`a Start and a Delete of the same definition (issue 409)`. The tests use the
file's existing harness and its SQL hook (`openWorkflowStore().control.hook`)
to force one order of the two transactions.

The "budget count" below is `PgSessionCatalog.countBudgetChildren(session)`,
the count that `spawn_agent` and a Start use.

| Test | What it forces | Expected after the fix | Expected on main (must fail) |
|---|---|---|---|
| `a Start whose admission meets a committed Delete is refused with no run and holds no child slot; its retry is refused the same` | The delete commits after the Start's claim and before the admission locks the definition. | Start refused `DEFINITION_DELETED` with `hn-top-watch was deleted. Nothing was started.`; no Workflow copy of the definition; budget count 0; a retry of the same Start is refused with the same words, count still 0. | Budget count is 1 (the orphan claim). |
| `a Start interrupted after its claim holds a child slot until its definition is deleted; its retry in a full session is refused DEFINITION_DELETED` | Two Starts (of two definitions) stop with an injected error just before their admission; then only the first definition is deleted; then 49 sub-agents fill the session to 50; then the first Start is retried. | Count 2 before the delete; 1 after it (the live definition's claim still counts); 50 after the fill (the freed slot is usable); the retry is refused `DEFINITION_DELETED` with the admission's words, not `CHILD_LIMIT`, and the count stays 50. | Count stays 2 after the delete. With only the budget change (no retry change), the retry is refused `CHILD_LIMIT`. |

Command (new tests only):

```bash
node ../../node_modules/vitest/vitest.mjs run test/local/workflow-session-definitions.test.js -t "issue 409"
```

## Existing tests that cover the touched code

| File | Why |
|---|---|
| `packages/sdk/test/local/workflow-session-definitions.test.js` (whole file) | Start, Run again, the delete refusal while a Workflow runs (R6), replay of a Start by operation id and by key, spawn, budget. |
| `packages/sdk/test/local/workflow-definitions-step-guard.test.js` | Delete and Start through the definition tool and the management client. |
| `packages/sdk/test/local/workflow-start-review.test.js` | The shared child budget on PostgreSQL: the 50-child refusal, a Start's claim as its reservation, a resumed Start not counted against itself. |
| `packages/sdk/test/local/workflow-migration-0088.test.js` | The budget count's query plan uses the sessions parent index (no sequential scan). |
| `packages/sdk/test/unit/workflow-child-budget.test.mjs` | The budget SQL's required parts and its use under the session lock. |
| `packages/sdk/test/unit/workflow-session-definitions.test.mjs` | Unit rules of session definitions (no database). |

Commands:

```bash
node ../../node_modules/vitest/vitest.mjs run test/local/workflow-session-definitions.test.js test/local/workflow-definitions-step-guard.test.js \
  test/local/workflow-start-review.test.js test/local/workflow-migration-0088.test.js
npm run build && npm run test:unit
```

Repository check for the new documents (from the repository root):

```bash
node scripts/check-repository-privacy.mjs
```

`npm run test:unit` (`node --test test/unit/*.test.mjs`, the SDK quick suite)
runs `test/unit/workflow-session-definitions.test.mjs` and the
repository-wide doc and size budget checks, which matter because this change
edits a developer doc.

## Not run

The full local suite, the all-providers matrix and live HorizonDB (the change
is one predicate in an existing query, with no schema or migration change; the
storage tests above run on the local PostgreSQL 16), browser and live-model
suites.
