# Issue #341 — Decision node: small cleanups and release-note items from the #328 review

## Problem

The final review of PR \#328 (the Workflow Decision node) left seven small
items and one release-note finding (F14). None of them blocks anything. This
change checks each item against the code on `origin/main` (b79be29d, release
0.8.19) and fixes the ones that are still open.

Terms used below:

- **Migration**: a function in `packages/sdk/src/migrations/` that returns the
  SQL for one CMS schema version. It runs once per database, recorded by its
  version number (for example `0098`).
- **Schema name escaping**: PostgreSQL writes an identifier in double quotes.
  A double quote inside the name is written twice. The schema `a"b` is written
  `"a""b"`. Written `"a"b"`, it is a syntax error.
- **Frozen effect module**: `packages/sdk/src/workflow/effect_1_0_0`,
  `effect_1_1_0` and `effect_1_2_0`. Each holds one released version of the
  Workflow effect orchestration. Old histories replay against them, so they
  never change. `test/unit/workflow-effect-freeze-1-0-0.test.mjs` pins the
  SHA-256 of each file (the **freeze pin**).
- **Fixture skeleton**: when a Workflow test run meets a call that has no
  prepared answer, the test report includes a ready-to-fill fixture for that
  call (`definitionTestFixtureSkeleton` in `workflow/definition-test.ts`).

## Item by item: current behavior and decision

| # | Item | Current behavior on main (evidence) | Decision |
|---|---|---|---|
| 1 | 0098 schema name not quote-escaped | `migrations/cluster-decision-default-0098.ts:3` builds ``const s = `"${schema}"` ``. Every other migration added with the Decision work (0096, 0097, 0099-0103) uses `schema.replace(/"/g, '""')`. With the schema `a"b`, 0098 emits `"a"b".provider_cluster_settings`. | **Fix.** Escape like its siblings. |
| 2 | Guidance names `workflows.decision.available` | Already gone. `workflow/guidance.ts:5-10` has one static line, `WORKFLOW_DECISION_GUIDANCE`. PR \#355 (release 0.8.15) removed the availability wording. | **No change** (already fixed). |
| 3 | `agent-models.ts`: `max` ignored when `stored` is true | `parseWorkflowModels(value, decisionAlias, max, allowProvenance, stored)` (`workflow/agent-models.ts:173-179`) computes `limit = stored ? WORKFLOW_MAX_NODES : max`, so a caller that passes both loses `max` without a word. Callers: `parseWorkflowAgentModels` (line 228: 64, or 100 when stored), `parseWorkflowDecisionModels` (line 233: 64), `readStoredAgentModels` (lines 350-351: passes 100 and `stored: true`). | **Fix** without a behavior change: one `limit` parameter that each caller sets. |
| 4 | `effect_1_1_0/index.ts:88` says "the released 1.1.0 error projection" | When \#328 was in review, the handler was not released yet. \#328 shipped in 0.8.14 (tag `v0.8.14` contains c577d2694), so the sentence is now true. The file is frozen and byte-pinned (`workflow-effect-freeze-1-0-0.test.mjs:31-35, 71`). `effect_1_2_0/index.ts:88` uses the same wording for its own version. | **No change.** The sentence is now true, and the file is a byte-pinned released module. |
| 5 | `effect_1_0_0` and `effect_1_1_0` duplicate about 110 lines of redaction | Both files already give the reason (`effect_1_0_0/index.ts:77-78`, `effect_1_1_0/index.ts:88-89`): "Keep its redaction and clipping here, rather than importing ... helpers whose later releases must not change old histories." `effect_1_2_0` has a third copy. | **Add one comment** where the three modules are imported, `workflow/runtime.ts:2-10`: the copies are deliberate and must not be merged. The frozen files stay untouched. |
| 6 | `selectors.js` gained `foundry-wif` | `packages/app/ui/core/src/selectors.js:67-69` returns true for `anthropic-wif` or `foundry-wif`; \#328 added `foundry-wif`. The SDK rule (`model-providers.ts:143-145`) already had both. The 0.8.14 notes do not mention it. | **Release note** in the 0.8.14 section of `CHANGELOG.md`. |
| 7 | `noul` fixture skeleton includes `probabilities` | `workflow/definition-test.ts:205-206` suggests `{ type: "noul", noul: 1, probabilities: { true: 1, false: 0 } }`. The live service answers `noul` with only `noul` (comment at `decision-provider.ts:598`); the parser derives yes and no from it (`decision-provider.ts:599-600`). | **Fix.** Suggest `{ type: "noul", noul: 1 }`. |
| F14 | \#328 touched paths that do not involve a Decision | (a) `applyWorkflowUpdate` (`workflow/service.ts:1149-1200`): publish, publish-and-start and start read the stored receipt with the operation id and the request hash (`readOperationReceipt`) and replay a receipt stored for the same request before they check the Decision catalog again; the same id with a different request is refused with `OPERATION_CONFLICT`, and a start on a deleted Workflow without a Decision is refused before the read. (b) `definitionTestBench` claim and replay in `definition-test.ts`: a repeat reuses the claimed definition, revision and `expect`, and refuses another with `WORKFLOW_EXISTS`. (c) `resolveProviderCredential` (`provider-catalog.ts:425-433`) returns null for a model that the type catalog does not list. (d) `buildRuntimeRegistry` (`provider-catalog.ts:205-280`) keeps a configured default only when it is a resolvable chat model of a shared instance; otherwise it uses the first shared runtime model. | **Release notes** in the 0.8.14 section of `CHANGELOG.md`. |

## Chosen design

### Item 1: escape the schema name in 0098

Change line 3 of `cluster-decision-default-0098.ts` to

```ts
const s = `"${schema.replace(/"/g, '""')}"`;
```

For every schema name without a double quote, the generated SQL is byte for
byte the same as before. Example: for `shape_check` the SHA-256 of the SQL
stays `8652d2f979958aea2f2e18b8f00f3ef660ec71516a55e45960d3f76e3cf48441`. A
database that already ran 0098 sees nothing new, and a fresh database runs the
same SQL. Migrations run by version number, not by SQL hash
(`pg-migrator.ts:198`), so nothing runs again.

`test/fixtures/composition-migrations.json` stores the git blob hash of every
migration file, and `test/local/tool-composition-historical.test.js:37-48`
checks it. Its 0098 entry must take the new blob hash. No other change to that
file is possible, and the issue asks for exactly this file change.

### Item 3: one limit parameter

```ts
function parseWorkflowModels(value: unknown, decisionAlias: boolean, limit: number, allowProvenance = true)
```

| Caller | Before | After |
|---|---|---|
| `parseWorkflowAgentModels(v)` | `max` 64, `stored` false: 64 | `limit` 64 |
| `parseWorkflowAgentModels(v, { stored: true })` | `max` 64, `stored` true: 100 | `limit` 100 |
| `parseWorkflowDecisionModels(v)` | default `max` 64: 64 | `limit` 64 |
| `readStoredAgentModels(v)` | `max` 100, `stored` true: 100 | `limit` 100 |

No exported signature changes (`parseWorkflowModels` is module-private).

### Item 5: one comment at the import site

Above the three `effect_1_x_0` imports in `workflow/runtime.ts`:

```ts
// Each frozen effect module keeps its own copy of the error redaction and clipping (about 110 lines) on purpose: a
// shared helper could change in a later release and alter the error text an old history replays. Do not merge them.
```

### Item 7: the noul skeleton

```ts
return { answers: { decision: { type: "noul", noul: 1 } } };
```

`choice` and `score` keep their `probabilities`. The parser requires them for
`choice` (`decision-provider.ts:587-588`).

### Items 6 and F14: release notes

Add an `### Other changes in this release` subsection to the 0.8.14 section,
the release that shipped \#328, with one bullet per path in plain words. Add an
`## Unreleased` section for this change (the `noul` skeleton and the 0098
escaping), as earlier fix PRs did.

## Rejected alternatives

- **Edit the frozen effect files (items 4 and 5) and re-pin their hashes.**
  The freeze pins exist so that a released effect module never changes. A
  comment edit is harmless at runtime, but re-pinning means editing the freeze
  test for a reason other than a behavior the issue replaces, and the item 4
  sentence is already true. The item 5 note goes where a reader would think
  about merging the copies: the import site.
- **Add a new migration (0104) instead of editing 0098.** A new migration
  cannot repair 0098 for a schema name that contains a double quote, because
  0098 runs first. Older migrations in `cms-migrations.ts` do not escape
  either, so such a schema name does not work today in any case; the fix brings
  0098 in line with the other Decision-era migrations, as the issue asks.
- **Keep `max` and make `stored` override it.** Two parameters for one number
  is the confusion that the issue names.
- **Put the F14 notes in the Unreleased section.** They describe what 0.8.14
  shipped; a reader upgrading past 0.8.14 looks there.

## Compatibility and risks

- No public API, tool, wire shape, orchestration version, controller version,
  effect version or migration version changes.
- The SQL of 0098 is unchanged for every schema name without `"`. The test
  spec pins this with a SHA-256 of the SQL, and a local PostgreSQL 16 test runs
  the changed SQL (a schema name with `"`). For every other schema name,
  PostgreSQL 16 and HorizonDB receive the same bytes that 0.8.14 to 0.8.19
  already sent. A database that applied 0098 does not apply it again: the
  migrator runs a migration only when its version is not recorded.
- The `agent-models.ts` limits are unchanged: 64 for requests, 100 for stored
  maps.
- The fixture skeleton is advice in a test report. A fixture written from the
  old skeleton still parses (the parser accepts `probabilities` for `noul`).
- Risk: low. The changed lines are a string escape, a parameter fold, a
  literal and comments.
