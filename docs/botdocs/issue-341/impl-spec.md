# Issue #341 — implementation spec

Base: `origin/main` at b79be29d (release 0.8.19). Branch:
`waldemort/issue-341-decision-node-small-cleanups-and-release`. All paths are
relative to the repository root. Do the steps in order; the tests of step 1
must fail before steps 2-6.

## Step 1: failing tests first

Write the new tests named in `test-spec.md` (T1, T2, T3), build the SDK, and
confirm that T1 and T2 fail for the stated reason and that T3 passes (T3
guards limits that must not change).

## Step 2: escape the schema name in migration 0098 (item 1)

File: `packages/sdk/src/migrations/cluster-decision-default-0098.ts`, function
`clusterDecisionDefaultMigration`, line 3.

```diff
-    const s = `"${schema}"`;
+    const s = `"${schema.replace(/"/g, '""')}"`;
```

File: `packages/sdk/test/fixtures/composition-migrations.json`, the entry with
`"path": "src/migrations/cluster-decision-default-0098.ts"`. Set `blob` to the
output of `git hash-object packages/sdk/src/migrations/cluster-decision-default-0098.ts`
after the edit. Change no other entry.

## Step 3: one limit parameter in agent-models.ts (item 3)

File: `packages/sdk/src/workflow/agent-models.ts`.

1. `parseWorkflowModels`: replace the parameters
   `(value, decisionAlias, max = WORKFLOW_AGENT_MODELS_MAX, allowProvenance = true, stored = false)`
   with `(value, decisionAlias, limit, allowProvenance = true)`. Delete the
   line `const limit = stored ? WORKFLOW_MAX_NODES : max;`. The rest of the
   body already reads `limit`.
2. `parseWorkflowAgentModels(value, options)`: call
   `parseWorkflowModels(value, false, options.stored === true ? WORKFLOW_MAX_NODES : WORKFLOW_AGENT_MODELS_MAX)`.
3. `parseWorkflowDecisionModels(value)`: call
   `parseWorkflowModels(value, true, WORKFLOW_AGENT_MODELS_MAX)`.
4. `readStoredAgentModels(value)`: call
   `parseWorkflowModels(<parsed value>, false, WORKFLOW_MAX_NODES, false)`.

No exported name or signature changes.

## Step 4: the noul fixture skeleton (item 7)

File: `packages/sdk/src/workflow/definition-test.ts`, function
`decisionFixtureValue`, the `noul` branch.

```diff
-        return { answers: { decision: { type: "noul", noul: 1, probabilities: { true: 1, false: 0 } } } };
+        return { answers: { decision: { type: "noul", noul: 1 } } };
```

## Step 5: the deliberate copies note (item 5)

File: `packages/sdk/src/workflow/runtime.ts`. Insert two comment lines directly
above the first `import { WORKFLOW_EFFECT_1_0_0_NAME, ...` statement:

```ts
// Each frozen effect module keeps its own copy of the error redaction and clipping (about 110 lines) on purpose: a
// shared helper could change in a later release and alter the error text an old history replays. Do not merge them.
```

Do not touch `workflow/effect_1_0_0`, `effect_1_1_0` or `effect_1_2_0`.

## Step 6: CHANGELOG (items 6 and F14, and this change)

File: `CHANGELOG.md`.

1. Insert directly under `# Changelog` an `## Unreleased` section:
   `**Upgrade: deploy the workers.** No migration and no orchestration version.`
   and one subsection on the `noul` skeleton and the 0098 escaping.
2. In the `## 0.8.14 — 2026-11-21` section, after `### Workflow controller
   1.2.0` and before `## 0.8.13`, add `### Other changes in this release` with
   one bullet each for: the portal `foundry-wif` rule (item 6),
   `applyWorkflowUpdate` receipt-first replay, the test bench claim and replay,
   `resolveProviderCredential`, and `buildRuntimeRegistry` (F14).

## Step 7: verify and commit

Run every command in `test-spec.md` and commit on the branch with the bot
identity. Item 2 (guidance) and item 4 (the 1.1.0 comment) have no code step;
`design-spec.md` gives the reasons.
