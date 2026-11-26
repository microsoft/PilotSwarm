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
| `issue 412: a finished Workflow of an idle owner stays through every Sweeper pass and the event purge, with its graph, steps, Log and variables` | Owner idle (its stand-in orchestration Running). A real two-step Workflow started with the variable `topic`, run to `completed`; its row 60 minutes old. | The scan does not list it. `cleanup_session` refuses `WorkflowKept` at the default grace and at 0. `prune_orchestrations` at cutoffs 5 and 0 deletes the ended controller instance for real (it reads `NotFound` after) and keeps the session. The row is not deleted and its state is `completed`. Its events are then aged 2 days and `purge_old_events` runs. `read_workflow` (as the owner) returns the full model: a graph, the run `completed` with output `{ "n": 2 }`, the three step visits (`first`, `second`, `done`) with their outputs, and the variable `topic`. The Log still holds the `workflow.state_completed` event of the step `second`, with its run id, outcome `ok` and output `{"n":2}`. (Round 2 replaced the round-1 checks "in the raw catalog list" and "any event starts with `workflow.`", which review round 1, finding 3, called proxies.) |

### `packages/sdk/test/local/sweeper-final-check.test.js` (round 2)

The file's concurrency harness: real PostgreSQL connections, a gate that stops a
transaction at a named statement, and the lock graph (`pg_blocking_pids`) as the
proof of order, never a sleep. "Restart" is the client's own write when an ended
root accepts a new first message: `catalog.updateSession(root, { state:
"running", ... })` (`client.ts:1070-1076`).

| Test | Setup | Expected after the fix | On round 1 (`17142cd0`) |
|---|---|---|---|
| `issue 412 (cleanup)` and `(prune): a Sweeper that holds its final transaction first makes an ended root's restart wait until the Workflow is deleted` | Root `R` completed; finished Workflow `W` under it; both 60 minutes old. The Sweeper (`cleanup_session` on `W`, or `prune_orchestrations` with `W` reading `NotFound`) stops at `W`'s soft delete. | The restart waits on the Sweeper's backend. After the gate opens, the cleanup succeeds; when the restart returns, `W` is already soft-deleted; `R` is `running`. | Fails: the restart does not wait. |
| `issue 412 (cleanup)` and `(prune): an ended root's restart that holds the root first makes the Sweeper refuse at once (Busy); then the Workflow is kept` | As above. Another transaction has updated `R` to `running` and not committed. | The Sweeper never waits for it and refuses `Busy` (prune: `cmsRefused` at least 1); `W` stays. After the commit, a cleanup refuses `WorkflowKept` naming `W`, `R` and `running` (prune deletes nothing). | Fails: `W` is deleted. |
| `issue 412: a Workflow above the target that ends its run while the Sweeper cleans its agent session is serialized: a held run end makes the cleanup refuse (Busy)` | Owner idle; Workflow `W` running; its agent session `A` completed. Another transaction holds `W`'s row, ends its run and sets `W` completed, not committed. | `cleanup_session(A)` never waits and refuses `Busy`; `A` stays. After the commit, it refuses `WorkflowKept`. | Fails: `A` is deleted. |
| `issue 412: a cleanup with no Workflow in or above it does not lock the sessions above it (a held parent does not refuse it)` | Parent `P` and completed child `C`, both ordinary. Another transaction is updating `P`. | `cleanup_session(C)` succeeds. | Passes (a guard for the compatibility claim, design-spec.md §5). |
| `issue 412: purge_old_events keeps the old events of a finished Workflow and of the sessions under it, and purges every other old event as before` | Owner idle; finished `W` with agent session `A` and a running child Workflow; a running Workflow with an agent session; a draft; a test bench with a session; an ordinary session. Each has one event 2 days old and one new. | The old events of `W`, `A` and `W`'s child Workflow stay; every other old event is deleted; every new event stays. After `W` is deleted, the next purge deletes the old events of `W`, `A` and its child. | Fails: `W`'s old event is deleted. |
| `issue 412: a run end that holds an active Workflow keeps its old events for that purge (the purge never waits); once ended, they are kept` | A running Workflow with an old event. Another transaction holds its row and ends its run, not committed. | The purge never waits and keeps the old event. After the commit, the next purge keeps it (finished). | Fails: the old event is deleted. |
| `issue 412: a purge that holds an active Workflow first makes its run end wait until the old events are gone` | As above. The purge stops at its delete of the Workflow trees' events. | The run's end waits on the purge's backend; after the gate opens, the old event is deleted and then the run ends. | Fails (times out): round 1 has no such transaction. |

### `packages/sdk/test/local/workflow-kept-terminated.test.js` (new file, round 2)

A real worker; the agent state is answered by a scripted model (no model is
called).

| Test | Setup | Expected after the fix | On round 1 |
|---|---|---|---|
| `is grouped under its owner's Terminated row, and its agent node Log and steps stay readable` | A real owner session made idle by one turn. A Workflow with one agent state `verify` (`session: new`) whose agent answers with a marker text and completes the state `unverified`; the run ends `blocked`. The agent session's orchestration ends. The rows are aged 60 minutes and every event 2 days. Then the scan, `cleanup_session` (default grace and 0) on the Workflow and on the agent session, `prune_orchestrations` (5 and 0), and `purge_old_events`. | The scan lists neither; every cleanup refuses `WorkflowKept`. The owner's old events are purged. The management client's `listSessions`, grouped by the session list's own `buildSessionTree`, puts the Workflow in the owner's Terminated row and the agent session in the Workflow's Terminated row; the owner is `idle`. `getSessionEvents` of the agent session still holds the agent's `assistant.message` with the marker; the Workflow's events hold `workflow.state_completed` for `verify` with outcome `unverified` and the marker in its output. `read_workflow` returns the graph and the `verify` visit with its output. | Fails: the agent's Log is empty after the purge. |

Command (the new tests only; each has these words in its name, or is the new file):

```bash
node ../../node_modules/vitest/vitest.mjs run test/local/sweeper-cleanup-guard.test.js test/local/workflow-sweeper-recover.test.js \
  test/local/sweeper-final-check.test.js -t "issue 412"
node ../../node_modules/vitest/vitest.mjs run test/local/workflow-kept-terminated.test.js
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
  test/local/sweeper-final-check.test.js test/local/sweeper-queued-start.test.js test/local/facts.test.js \
  test/local/workflow-kept-terminated.test.js test/local/resourcemgr-tools.test.js
npm run test:unit
```

`resourcemgr-tools.test.js` checks the Resource Manager tools against a fake
pool; its catalog has no Workflow store, so `purge_old_events` keeps its old
`DELETE` there.

Formal model (design-spec.md §3.5, §3.6), from
`docs/formal/workflow/retention/`, with Java 17 or later and `tla2tools.jar`
v1.7.4 in `$TLA_TOOLS`:

```bash
./check-packet.sh
TLA_TOOLS=<folder with tla2tools.jar> ./run-tlc.sh <out-dir>
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

These gates apply (design-spec.md §7) but are not run in this step. Its rules
allow only the targeted tests above and forbid HorizonDB, and it has no model
access.

- The `--all-providers` matrix with live HorizonDB. The new SQL (recursive CTEs,
  `FOR SHARE NOWAIT`, `FOR SHARE OF s SKIP LOCKED`, a `DELETE` with CTEs) runs
  only on the local PostgreSQL 16.
- Positive and negative live-model checks of the Sweeper's edited instructions.

Also not run: the full local suite, browser suites and integration suites.
