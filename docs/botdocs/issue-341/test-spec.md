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

No full suite, provider matrix, integration suite or browser suite runs. No
prompt or skill text changes, so the prompt and skill size budget tests do not
apply.
