# Issue #341 — test spec

All commands run on the dev builder, in the worktree
`/workspace/tasks/pilotswarm-issue-341`, after `source /workspace/env.sh`
(Node 24.22.1; it unsets `PG*` and `AZURE_*`). Unit tests read `dist/`, so
build first:

```bash
cd packages/sdk && npm run build
```

## New regression tests

| ID | File | Test name | Before the fix | After the fix |
|---|---|---|---|---|
| T1 | `packages/sdk/test/unit/cms-migrations-shape.test.mjs` | `the Decision-era migrations 0096-0103 quote-escape the schema name; 0098's SQL is unchanged for a plain name` | **Fails**: with schema `pilot"swarm`, migration 0098 contains `"pilot"swarm"` | Passes |
| T2 | `packages/sdk/test/unit/workflow-definition-test-gaps.test.mjs` | `a Decision call's fixture skeleton is an answer the parser takes; noul carries only noul, as the live service sends it` | **Fails**: the `noul` skeleton carries `probabilities` | Passes |
| T3 | `packages/sdk/test/unit/workflow-agent-models.test.mjs` | `a request map names at most 64 nodes; a stored map at most WORKFLOW_MAX_NODES, read back the same way` | Passes | Passes |
| T4 | `packages/sdk/test/local/provider-decision-default.test.js` | `0098 installs and its setter runs in a schema whose name contains a double quote` | **Fails** on PostgreSQL 16: `syntax error at or near "<tag>_q"` | Passes |

T1 details. `CMS_MIGRATIONS('pilot"swarm')`: every migration from 0096 to 0103
contains `"pilot""swarm".` and never `"pilot"swarm"`. `CMS_MIGRATIONS("shape_check")`:
the SHA-256 of 0098's SQL is
`8652d2f979958aea2f2e18b8f00f3ef660ec71516a55e45960d3f76e3cf48441`, the value
on main before the change. This second check passes before and after: it shows
that the SQL for an ordinary schema name does not change.

T2 details. For a `choice`, a `noul` and a `score` Decision state,
`definitionTestFixtureSkeleton({ operation: "decision" }, node, state)` gives a
`response.value` that `normalizeDecisionResponse(question, value)` accepts.
The `noul` value is exactly `{ answers: { decision: { type: "noul", noul: 1 } } }`.

T3 is a guard, not a regression test. Item 3 folds two parameters of a
module-private function into one and changes no behavior, so no test can fail
before it. T3 pins the limits that the change must keep:
`parseWorkflowAgentModels` and `parseWorkflowDecisionModels` refuse 65 entries;
`parseWorkflowAgentModels(map, { stored: true })` and `readStoredAgentModels`
take 100 entries and refuse 101. No existing test covers the stored limit.

T4 details. T1 reads the SQL text; T4 runs it on a real database. The test
runs the CMS migrations through 0097 in a schema with a plain name
(`decision_<tag>_q`), because the migrations before 0096 do not escape the
schema name. It then renames the schema to `decision"<tag>_q` and runs the
0098 SQL for that name. The four new columns exist and are null. The setter
`cms_provider_set_cluster_decision_default` refuses a non-administrator with
`PROVIDER_FORBIDDEN`, stores `team` / `team:decision-model` for an
administrator, and clears both. The test drops the schema at the end. Before
the fix, the 0098 SQL contains `"decision"<tag>_q"` and PostgreSQL rejects it.

Item 5 adds a comment and items 6 and F14 add release notes; they have no
behavior to test. Items 2 and 4 make no change.

## Commands

1. Build and type check:

   ```bash
   cd packages/sdk && npm run build && npm run lint
   ```

2. New and existing unit tests for the touched code:

   ```bash
   cd packages/sdk && node --test \
     test/unit/cms-migrations-shape.test.mjs \
     test/unit/workflow-definition-test-gaps.test.mjs \
     test/unit/workflow-agent-models.test.mjs \
     test/unit/workflow-decision-models.test.mjs \
     test/unit/workflow-branches.test.mjs \
     test/unit/workflow-decision-provider.test.mjs \
     test/unit/workflow-decision-runtime.test.mjs \
     test/unit/workflow-effect-freeze-1-0-0.test.mjs \
     test/unit/workflow-decision-docs.test.mjs
   ```

   - `workflow-decision-models`, `workflow-branches`: other callers of the
     agent-models parsers.
   - `workflow-decision-provider`, `workflow-decision-runtime`: the Decision
     parser and test-mode Decision fixtures.
   - `workflow-effect-freeze-1-0-0`: proves the frozen effect files are
     unchanged.
   - `workflow-decision-docs`: reads `CHANGELOG.md`.

3. The migration inventory (no database; it reads files):

   ```bash
   cd packages/sdk && node ../../node_modules/vitest/vitest.mjs run test/local/tool-composition-historical.test.js
   ```

4. Migration 0098 against a disposable local PostgreSQL 16 (storage change).
   Start a PG16 cluster under `/workspace/pg/pilotswarm-issue-341` on a free
   port, then:

   ```bash
   cd packages/sdk && PS_TEST_DATABASE_URL=postgresql://<user>@127.0.0.1:<port>/postgres \
     node ../../node_modules/vitest/vitest.mjs run test/local/provider-decision-default.test.js
   ```

   This runs every CMS migration, 0098 included, on a fresh schema and sets,
   clears and refuses the Cluster Decision Default through the 0098 setter.
   It also upgrades a schema from 0097 to 0098, re-runs 0098, and runs T4.
   To run T4 alone against the code before the fix, restore the old 0098 file
   and add `-t "double quote"`:

   ```bash
   git show origin/main:packages/sdk/src/migrations/cluster-decision-default-0098.ts \
     > packages/sdk/src/migrations/cluster-decision-default-0098.ts
   cd packages/sdk && PS_TEST_DATABASE_URL=postgresql://<user>@127.0.0.1:<port>/postgres \
     node ../../node_modules/vitest/vitest.mjs run test/local/provider-decision-default.test.js -t "double quote"
   cd ../.. && git checkout -- packages/sdk/src/migrations/cluster-decision-default-0098.ts
   ```

5. Repository privacy:

   ```bash
   node scripts/check-repository-privacy.mjs
   ```

No prompt or skill text changes, so the prompt and skill size budget tests do
not apply.

## Migration verification and the pull request gates

The change edits the SQL of a numbered CMS migration, so this section states
what proves it and where each part runs.

| Evidence | What it shows | Where it runs |
|---|---|---|
| T1 | 0096-0103 escape the schema name. For a plain name, the SHA-256 of the 0098 SQL is the value on `main` before the change. | This step (unit) |
| T4 | The changed SQL (a name with `"`) installs and works on PostgreSQL 16. | This step (local PostgreSQL 16) |
| `provider-decision-default.test.js` | Fresh install, upgrade from 0097, re-run of 0098 and the setter, on PostgreSQL 16. | This step (local PostgreSQL 16) |
| Full SDK unit suite: `npm run test:unit --workspace=pilotswarm-sdk` | Every SDK unit test on the pull request head. | `pr-checks.yml`, Linux and Windows, on every push to the pull request |
| `./scripts/run-tests.sh --all-providers`: the PostgreSQL baseline plus live HorizonDB | The full suite on PostgreSQL and the HorizonDB contracts on the pull request head. | `tests.yml`, started by a maintainer's `/test all` comment on the pull request |

This implementation step does not run the last two rows. The Workflow that
runs it allows only targeted tests, a local PostgreSQL 16 and no HorizonDB.
The two gates run on the pull request instead. For every schema name without
`"`, HorizonDB receives the same 0098 SQL bytes that 0.8.14 to 0.8.19 already
sent (T1); only T4 uses a name with `"`. A database that recorded 0098 does not
run it again.
