# Issue 409: implementation report

Issue: [microsoft/PilotSwarm#409](https://github.com/microsoft/PilotSwarm/issues/409).
Specs: [design-spec.md](design-spec.md), [impl-spec.md](impl-spec.md),
[test-spec.md](test-spec.md). Terms (Start, claim, admission, orphan claim) are
defined in the design spec.

## Result in one paragraph

Main already does what the issue asks: a person can delete a definition with no
active run; a delete is refused `DEFINITION_IN_USE` while a run is active; row
locks make a run's admission and a delete happen one after the other; and the
delete is a soft delete that keeps revisions, Workflows and runs. One gap
remained. A Start that lost the race to a delete (or was interrupted before its
admission and then had its definition deleted) kept a claim that could never
run, and that claim still used one of the session's 50 child slots. This change
stops counting such a claim, and keeps a retry of that Start answered
`DEFINITION_DELETED`.

## What changed and why

| File | Change | Why |
|---|---|---|
| `packages/sdk/src/child-budget.ts` | `childBudgetCountSql`: a claim whose pinned session definition has `deleted_at` set is not counted. | A deletion is permanent, so such a claim can never become a running Workflow. Its slot reserved nothing. |
| `packages/sdk/src/workflow/session-definitions.ts` | `replaySessionStart`: for a resumed claim, a `CHILD_LIMIT` from the budget check is not returned when the pinned definition is deleted (read again at that moment); the existing identity checks and the admission answer instead. | Once the slot is freed, another child can take it. Without this, a retry of the interrupted Start in a full session got `CHILD_LIMIT` ("wait for some to end") instead of `DEFINITION_DELETED`. |
| `packages/sdk/test/local/workflow-session-definitions.test.js` | Two new tests in a new block; one new import. No existing test changed. | Regression tests (see below). |
| `docs/developer/building/workflow-sessions.md` | One paragraph next to the Delete bullet. | Says what a Start at the same moment as a delete gets. |
| `CHANGELOG.md` | New `Unreleased` section with one entry. | Repository convention for fixes. |
| `docs/botdocs/issue-409/*.md` | These four documents. | Task requirement. |

No session row is changed or deleted, no lock, transaction, error code or
migration changes.

## How the gap was found

A scratch probe (not committed) on the local PostgreSQL 16:

- forced "Start first": the delete waited for the admission and was refused
  `DEFINITION_IN_USE`;
- forced "Delete first": the Start waited and was refused `DEFINITION_DELETED`
  with no run, but one Workflow claim session stayed live;
- 40 rounds of a random race: Start and Delete never both succeeded; the delete
  won all 40, and each lost Start left one claim that the child budget still
  counted.

## Deviations from the specs

1. **The first design was replaced after review.** The first implementation
   soft-deleted the claim when the admission was refused, and answered a retry
   early. The first independent review showed it was unsafe: two overlapping
   attempts of the same Start could soft-delete a Workflow that the other
   attempt had admitted (and that had finished), and some retries changed their
   refusal code. The specs were rewritten before the final commits. The
   committed design spec lists that approach under rejected alternatives.
2. **Retry rule added after the second review** (impl-spec step 3).
3. **`CHANGELOG.md` entry** added after reading the repository convention.
4. **Privacy check** (`scripts/check-repository-privacy.mjs`) added to the test
   spec because the change adds documents.
5. **No TLA+ model.** The existing Workflow models do not model creation
   (`docs/formal/workflow/README.md:381`). This change adds no lock, transaction
   or state transition: it changes one count and one refusal order. See
   follow-ups.

## Tests run

All on the dev builder pod, Node 24.22.1, local PostgreSQL 16.15 on a private
port, with `PG*` and `AZURE_*` unset. Commands are from `packages/sdk` unless
noted.

| Command | Head | Result |
|---|---|---|
| `node ../../node_modules/vitest/vitest.mjs run test/local/workflow-session-definitions.test.js -t "issue 409"` | specs and tests on main (before the fix) | Failed as expected: 2 failed (`expected 1 to be 0`, `expected 2 to be 1`) |
| same | with the fix | Passed: 2 passed |
| same | fix without the retry rule (mutation) | Failed as expected: 1 failed with `CHILD_LIMIT`, 1 passed |
| `node ../../node_modules/vitest/vitest.mjs run test/local/workflow-session-definitions.test.js test/local/workflow-definitions-step-guard.test.js test/local/workflow-start-review.test.js test/local/workflow-migration-0088.test.js` | with the fix | Passed: 4 files, 25 tests |
| `npm run build` (repository root) | with the fix | Passed |
| `node scripts/check-repository-privacy.mjs` (repository root) | with the fix | Passed: 0 findings |
| `npm run test:unit` | with the fix | Passed: 3,127 tests, 3,126 passed, 0 failed, 1 skipped |

The same list is run again on the final head after `origin/main` is merged in;
the PR lists those results.

## Review findings and what was done

Each review was an independent adversarial review of the sealed diff by a
model from a different family than the author's.

| Round | Finding | Action |
|---|---|---|
| 1 (first design) | An overlapping identical Start could soft-delete another attempt's admitted, finished Workflow. | Design replaced (no session row is deleted now). |
| 1 | Overlapping identical retries could get `SESSION_EXISTS`. | Gone with the replacement. |
| 1 | The early retry answer masked `OPERATION_CONFLICT` for a keyed retry with other arguments. | Gone with the replacement; the retry rule now leaves identity checks to the existing code. |
| 1 | An interrupted Start that is never retried kept its slot after the delete. | Fixed by the budget change (covered by the second test). |
| 1 | Two identical deletes at the same moment: the second gets `DEFINITION_DELETED` instead of the first one's receipt. | Exists on main; follow-up. |
| 2 | A retry in a session that filled the freed slot got `CHILD_LIMIT`. | Fixed (retry rule) and tested. |
| 2 | Docs: a delete after the admitted run has ended succeeds; the plan test does not seed claims, so do not promise one index probe per plan. | Design spec reworded. |
| 2 | Plan test fixture has no pinned claims. | Follow-up. |
| 3 | Retry rule review. | Approved, no findings. |

## Follow-ups

1. The orphan claim row itself stays in the catalog (as on main for any
   interrupted Start). It is not listed as a Workflow and no longer holds a
   slot. Removing it needs a design that is safe against overlapping attempts
   of the same Start.
2. Concurrent identical deletes: re-read the operation receipt after taking the
   definition lock, so the second gets the first one's receipt.
3. Seed pinned Workflow claims in the `workflow-migration-0088` plan test, so
   the new lookup's plan is checked too.
4. A TLA+ model of Start (claim and admission), delete and the child budget, if
   Workflow creation is modeled later.
