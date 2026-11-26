# Issue 412: test specification

See [design-spec.md](design-spec.md) for the terms (finished Workflow session,
active session, kept session, final check).

All commands run on the dev builder pod, in the task worktree, against a
disposable local PostgreSQL 16 on a free port. Ambient `PG*` and `AZURE_*`
variables are unset first. These suites call no model, but their shared
preflight (`test/helpers/local-env.js` `preflightChecks`) refuses to start
without a model credential, so a placeholder `GITHUB_TOKEN` is set.

```bash
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE \
      AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_FEDERATED_TOKEN_FILE AZURE_AUTHORITY_HOST
export PS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/pilotswarm
export DATABASE_URL=$PS_TEST_DATABASE_URL
export GITHUB_TOKEN=unused-by-sweeper-tests
npm run build
cd packages/sdk
```

## New regression tests

Each test fails on `main` at its first "kept" assertion, because `main` lists or
cleans the finished Workflow (or its owner).

### `packages/sdk/test/local/sweeper-cleanup-guard.test.js`

New block `finished Workflows kept while an ancestor is active (issue 412)`. The
tests use the file's harness: a real CMS catalog and Workflow store, and a stub
duroxide client whose statuses the test sets. Session states are set with SQL,
as a session's end sets them.

| Test | Setup | Expected after the fix |
|---|---|---|
| `a finished Workflow of an idle owner, and its agent session, are kept by scan, cleanup, prune and the final check` | Owner `O` idle (`session-O` Running). Finished Workflow `W` of `O` (one live run, `completed`; controller `Completed`). Agent session `A` under `W`, state `completed`. All rows 60 minutes old. | The scan lists neither `W` nor `A`. `cleanup_session` refuses `W` and `A`, at the default grace and at 0, with status `WorkflowKept`; the words name `W`, `O` and the state `idle`. The final check called directly on `W` refuses `WorkflowKept`. After their orchestrations read `NotFound` (as after the prune's bulk pass), `prune_orchestrations` keeps both, with `cmsRefused` 0. `W` is not deleted and its state is `completed` (the session list's Terminated row). |
| `an ended owner that holds a finished Workflow is kept while the owner's parent is active, then cleaned with it` | Parent `P` idle (Running). Owner `O` under `P`, state `completed`, controller `Completed`. Finished `W` under `O`, agent session `A` under `W`. | The scan lists none of `O`, `W`, `A`. `cleanup_session(O)` refuses `WorkflowKept` naming `W` and `P`. The final check on `O` (cascade) refuses `WorkflowKept`. With `O` reading `NotFound`, the prune keeps `O` and `W`. Then `P` ends (state `completed`, `Completed`): `cleanup_session(P)` succeeds and `P`, `O`, `W`, `A` are deleted; `W`'s definition is a tombstone. |
| `the owner and its Workflow are cleaned once the owner and every ancestor have ended` | Root owner `O` idle. Finished `W`, agent session `A`. | While `O` is idle, `cleanup_session(W)` refuses `WorkflowKept`. After `O` ends (state `completed`, `Completed`), the scan lists `O`, and `cleanup_session(O)` deletes `O`, `W` and `A`; `W`'s ended run stays `completed`. |
| `deleting the owning session, or the Workflow, deletes a kept Workflow at once` | Owner `O` idle. Finished `W1` and `W2`. | `cleanup_session(W1)` refuses `WorkflowKept`. An explicit delete of `W2` (`catalog.softDeleteSession`) deletes it at once. An explicit delete of `O` deletes `W1` at once (owner trigger), and `W1`'s definition is a tombstone. |

### `packages/sdk/test/local/workflow-sweeper-recover.test.js`

The file's real runtime (duroxide PostgreSQL provider, production Workflow
registrations, a real controller).

| Test | Setup | Expected after the fix |
|---|---|---|
| `issue 412: a finished Workflow of an idle owner stays Terminated through every Sweeper pass, with its graph, steps, Log and variables` | Owner idle (its stand-in orchestration Running). A real two-step Workflow started with the variable `topic`, run to `completed`; its row 60 minutes old. | The scan does not list it. `cleanup_session` refuses `WorkflowKept` at the default grace and at 0. `prune_orchestrations` at cutoffs 5 and 0 deletes the ended controller instance for real (it reads `NotFound` after) and keeps the session. The row is not deleted, its state is `completed`, and it is in the session list. `read_workflow` (as the owner) returns the full model: a graph, the run `completed` with output `{ "n": 2 }`, the three step visits (`first`, `second`, `done`) with their outputs, and the variable `topic`. The session's Log events are readable. |

Command (new tests only; both files have tests with these words in the name):

```bash
node ../../node_modules/vitest/vitest.mjs run test/local/sweeper-cleanup-guard.test.js test/local/workflow-sweeper-recover.test.js -t "issue 412"
```

## Existing tests changed

Each change replaces an assertion of the behavior the issue replaces: a
finished Workflow cleaned while its owner is active, or an owner treated as
ended when only its orchestration ended (the issue defines an ended session by
its state).

| File, test | Change | Why |
|---|---|---|
| `sweeper-cleanup-guard.test.js`, `finished live Workflows are swept while their full owner outcome and test-bench policy remain` | The two finished live Workflows of the running owner are now asserted kept: not listed, `cleanup_session` refuses `WorkflowKept`, the prune keeps them. The title says they are kept. The test-bench, active, draft and mixed assertions are unchanged. | The issue: never clean a finished Workflow while an ancestor is active. |
| `sweeper-cleanup-guard.test.js`, `all runs ended: live Workflows are cleaned; test benches follow controller status and retention` | The finished live Workflow of the running owner is now asserted kept (not listed, refused `WorkflowKept`, its controller not deleted). The title says so. The test-bench assertions are unchanged. | Same. |
| `sweeper-cleanup-guard.test.js`, `a finished owner session's cleanup removes its Workflow sessions with it` | The owner's state is set to `completed` before its Workflows are created, so the owner has ended as the issue defines it. The assertions are unchanged. | On `main` the fixture's owner ended only in its orchestration status; its state stayed `pending`, which the issue counts as active. |
| `workflow-sweeper-recover.test.js`, `every Sweeper pass preserves active Workflow recovery, cleans finished live Workflows, and lets ancestor deletion remove retained test benches` | The completed Workflow of the running owner is now asserted kept (`WorkflowKept`, not deleted, its owner outcome saved). When the owner's stand-in orchestration ends, its state is set to `completed`, as a session's end sets it; the owner's cleanup then also removes the completed Workflow. The title says so. | Both reasons above. |

## Existing tests that cover the touched code

| File | Why |
|---|---|
| `packages/sdk/test/local/sweeper-cleanup-guard.test.js` (whole file) | Scan, cleanup and prune rules: live roots, terminal children, batches, Workflow sessions by their runs, failed reads, test benches. |
| `packages/sdk/test/local/workflow-sweeper-recover.test.js` | Every Sweeper pass on the real runtime with active, lost, dead and finished runs. |
| `packages/sdk/test/local/sweeper-final-check.test.js` | The final check under concurrency: lock order, `Busy`, `Changed`, the subtree re-read, `StartUnresolved`. The new check runs inside this transaction. |
| `packages/sdk/test/local/sweeper-queued-start.test.js` | A queued start kept by scan, cleanup and prune. |
| `packages/sdk/test/local/facts.test.js` | The Sweeper's cleanup of descendants' facts. |

```bash
node ../../node_modules/vitest/vitest.mjs run test/local/sweeper-cleanup-guard.test.js test/local/workflow-sweeper-recover.test.js \
  test/local/sweeper-final-check.test.js test/local/sweeper-queued-start.test.js test/local/facts.test.js
npm run test:unit
```

`npm run test:unit` (`node --test test/unit/*.test.mjs`, the SDK quick suite)
holds the prompt and skill size budget tests and the repository-wide document
checks; this change edits the Sweeper's agent file, its skill and developer
documents.

Repository check for the new documents (from the repository root):

```bash
node scripts/check-repository-privacy.mjs
```

## Not run

The full local suite, the all-providers matrix and live HorizonDB (no schema or
migration change; the new SQL is one read query, run above on the local
PostgreSQL 16), browser and live-model suites, and a formal model (no new lock,
state or message; see design-spec.md §3.5 and §7).
