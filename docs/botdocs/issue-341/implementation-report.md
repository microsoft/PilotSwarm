# Issue #341 — implementation report

Branch: `waldemort/issue-341-decision-node-small-cleanups-and-release`.
Base: `main` at b79be29d (release 0.8.19). `main` has not moved since, so the
merge of the latest `main` into the branch was a no-op ("Already up to date").

The other three documents: [design-spec.md](design-spec.md),
[impl-spec.md](impl-spec.md), [test-spec.md](test-spec.md).

## What changed and why

The final review of PR \#328 (the Workflow Decision node) left seven small
items and one release-note finding (F14). Each was checked against `main`
before any change.

| # | Item | Result | Change |
|---|---|---|---|
| 1 | Migration 0098 does not quote-escape the schema name | Fixed | `cluster-decision-default-0098.ts`: a `"` in the schema name is now written `""`, as in 0096, 0097 and 0099-0103. For a name without `"`, the SQL is byte for byte the same (SHA-256 pinned by a test), so no database runs anything new. |
| 2 | Guidance names `workflows.decision.available` | Already fixed on `main` | None. PR \#355 (0.8.15) removed that wording; `workflow/guidance.ts` has one static line. |
| 3 | `agent-models.ts`: `max` ignored when `stored` is true | Fixed, no behavior change | The module-private `parseWorkflowModels` takes one `limit` parameter. Each caller passes its number: 64 for request maps, 100 (`WORKFLOW_MAX_NODES`) for stored maps. The limits are the same as before. |
| 4 | `effect_1_1_0` comment says "the released 1.1.0 error projection" | No change | \#328 shipped in 0.8.14, so the sentence is now true. The file is a frozen, byte-pinned released module. |
| 5 | Two effect modules duplicate about 110 lines of redaction | Note added | Two comment lines above the frozen effect imports in `workflow/runtime.ts` say the copies are deliberate and must not be merged. The frozen files are untouched. |
| 6 | `selectors.js` gained `foundry-wif` without a note | Release note | Bullet in a new "Other changes in this release" subsection of the 0.8.14 `CHANGELOG.md` section. |
| 7 | `noul` fixture skeleton includes `probabilities` | Fixed | A Workflow test report now suggests `{ type: "noul", noul: 1 }`, the shape the live service sends. A fixture with `probabilities` still parses. |
| F14 | \#328 touched paths that do not involve a Decision | Release notes | Four bullets in the same 0.8.14 subsection: receipt replay in `applyWorkflowUpdate`, the test bench claim and replay, `resolveProviderCredential`, and `buildRuntimeRegistry`. |

`CHANGELOG.md` also has a new `## Unreleased` section for items 1 and 7.

No public API, tool, wire shape, orchestration, controller, effect or
migration version changes.

## Deviations from the specs

- Review round 1 added test T4 (0098 on PostgreSQL 16 with a schema name that
  contains `"`) and the section "Migration verification and the pull request
  gates" to `test-spec.md`. `impl-spec.md` step 1 names T4.
- Review round 2 asked `test-spec.md` to say which commit each pull request
  gate tests. That section now explains it (see below). No code change.
- Otherwise the work follows `impl-spec.md` step by step.

## Tests run

All runs are on the dev builder, Node 24.22.1, after `source /workspace/env.sh`
(it unsets `PG*` and `AZURE_*`), in the worktree
`/workspace/tasks/pilotswarm-issue-341`. The local database is a disposable
PostgreSQL 16 cluster on `127.0.0.1:55641`. No HorizonDB and no test cluster
were used.

### Before the fix (failing tests first)

| Test | Commit | Result |
|---|---|---|
| T1 and T2 with the `main` versions of `cluster-decision-default-0098.ts` and `definition-test.ts`: `node --test test/unit/cms-migrations-shape.test.mjs test/unit/workflow-definition-test-gaps.test.mjs` | c47552ac with the two source files restored from `main` | 2 failed of 30, both for the stated reason (T1: 0098 writes `"pilot"swarm"`; T2: the `noul` skeleton has `probabilities`). After restoring the fixed files: 30 of 30 passed. |
| T4 with the `main` version of `cluster-decision-default-0098.ts`: `provider-decision-default.test.js -t "double quote"` | c47552ac with 0098 restored from `main` | 1 failed: PostgreSQL 16 `syntax error at or near "<tag>_q"`. |
| T3 | — | A guard, not a regression test: item 3 changes no behavior. It passes before and after. |

### On the final code (head c47552ac, which already contains the latest `main` b79be29d)

| # | Command (from `packages/sdk` unless noted) | Result |
|---|---|---|
| 1 | `npm run build && npm run lint` | Passed |
| 2 | `node --test` on the 9 targeted unit files in `test-spec.md` | 127 of 127 passed |
| 3 | `node ../../node_modules/vitest/vitest.mjs run test/local/tool-composition-historical.test.js` | 2 of 2 passed |
| 4 | `PS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55641/pilotswarm node ../../node_modules/vitest/vitest.mjs run test/local/provider-decision-default.test.js` | 31 of 31 passed (includes T4) |
| 5 | From the repository root: `node scripts/check-repository-privacy.mjs` | 0 findings |

Earlier heads: 1ca3c9dc (sent to review round 1) passed commands 1-4, with 30
of 30 in command 4 (T4 did not exist yet). c47552ac (sent to review round 2)
passed all five, with the same counts as above. The last commit on the branch
adds only this report and the `test-spec.md` text; the privacy check ran again
on it.

Not run in this step, by the rules of the Workflow that ran it: the full SDK
unit suite and `./scripts/run-tests.sh --all-providers` (PostgreSQL baseline
plus live HorizonDB). Both run on the pull request:

- `pr-checks.yml` runs the full SDK unit suite on Linux and Windows on each
  push. It tests GitHub's merge of the pull request head with the `main` of
  that moment. The branch already contains `main` b79be29d, so while `main`
  stays there, that merge has the same files as the branch head.
- A maintainer's `/test all` comment runs `tests.yml` with all providers on
  the pull request head commit itself.

## Review rounds

| Round | Reviewed head | Verdict | Findings and what was done |
|---|---|---|---|
| 1 | 1ca3c9dc | Changes required | (1) Blocker: the test plan did not run the changed 0098 SQL on a database. **Fixed in part**: new test T4 runs 0098 with a `"` in the schema name on PostgreSQL 16 (fails before the fix with a syntax error). **Rejected in part**: running the full SDK suite and the PostgreSQL plus HorizonDB matrix in this step. The Workflow rules forbid them here, and both run on the pull request. For every schema name without `"`, 0098 sends the same bytes that 0.8.14 to 0.8.19 already sent. (2) Important: the 0.8.14 note on receipt replay omitted that the request must match. **Fixed**: the note says a receipt stored for the same request is replayed, a different request is refused with `OPERATION_CONFLICT`, and a start on a deleted Workflow without a Decision is refused with `WORKFLOW_DELETED` first. (3) Minor: the `resolveProviderCredential` note overstated the old behavior. **Fixed**: before, the resolver did not check the model list, but still needed the credential and endpoint its type requires. |
| 2 | c47552ac | Approved | (1) Minor: `pr-checks.yml` tests GitHub's merge commit, while `/test all` tests the pull request head. **Fixed**: `test-spec.md` explains the difference with an example, and this report and the pull request say which commit each run tests. |

## Existing tests changed

| File | Change | Reason |
|---|---|---|
| `packages/sdk/test/fixtures/composition-migrations.json` | The 0098 entry's `blob` changes from `e1eff013…` to `017b1c93…`. | The fixture stores the git blob hash of each migration file, and `tool-composition-historical.test.js` checks it. The issue asks for exactly this file change (item 1), so the hash must follow. No other entry changed. |
| `packages/sdk/test/unit/workflow-agent-models.test.mjs` | Two import lines name `parseWorkflowDecisionModels` and `WORKFLOW_MAX_NODES`. | Needed by the new test T3 in the same file. No existing test case changed. |

New test cases were added to `cms-migrations-shape.test.mjs` (T1),
`workflow-definition-test-gaps.test.mjs` (T2), `workflow-agent-models.test.mjs`
(T3) and `provider-decision-default.test.js` (T4). No existing assertion was
edited.

## Follow-ups

- Run `/test all` on the pull request before release; it is the only run of
  the PostgreSQL baseline plus live HorizonDB for this change.
- Migrations before 0096 do not escape the schema name either, so a schema
  name with `"` still fails at the first migration. Fixing them would change
  old migration SQL and is not part of this issue. T4 works around it by
  running 0001-0097 under a plain name and renaming the schema.
