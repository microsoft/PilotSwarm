# P1-02 Decision mock-test admission report

## Verdict

Implemented. Mocked Workflow definition tests now materialize and persist the effective Decision model map before runtime admission. The normal fixture path reaches the same raw Decision response parser and policy without a provider or budget call. Source-local lint, build, and focused DB-less tests pass. The PostgreSQL end-to-end suites remain for the parent T3 run because local PostgreSQL is unavailable.

## Head

- Branch: `waldemort/workflow-decision-node-test-admission3`
- Reviewed base: `8b82177cfda0cae3741f791af9df4870b4d38646`
- Scope: P1-02 only

## Files

- `packages/sdk/src/workflow/service.ts`: admits test model choices, materializes every Decision from the current eligible Cluster Decision Default, preserves real-Agent model catalog checks, and refuses Agent choices in mocked mode.
- `packages/sdk/src/workflow/definition-test.ts`: preflights unavailable or incompatible Decision admission before creating a hidden test bench and passes compatible choices to the persisted run admission.
- `packages/sdk/src/workflow/definition-tool.ts`: validates and forwards `agent_models` and `decision_models` for `workflow_definition test` instead of ignoring them.
- `packages/sdk/test/local/workflow-definition-test.test.js`: adds the normal `workflow_definition test` raw-fixture end-to-end regression, compatible overrides, a separate no-default refusal, and mocked-Agent refusal without a direct SQL patch to `workflow_runs.agent_models`.
- `packages/sdk/test/unit/workflow-agent-models.test.mjs`: adds DB-less production admission coverage.
- `packages/sdk/plugins/workflow/skills/workflow-tools/SKILL.md`: documents Decision test admission and fixture behavior.

## Behavior

- Every fresh Decision test run uses the current eligible Cluster Decision Default unless a compatible explicit override names that node.
- A missing, stale, or ineligible default still refuses admission with `WORKFLOW_DECISION_MODEL_UNAVAILABLE` and actionable Admin Settings guidance. An override cannot bypass it.
- Mocked tests refuse Agent model choices. Real-agent tests keep the existing Agent catalog check; Decision choices never enter that chat-model checker.
- The admitted effective map is stored in the existing `workflow_runs.agent_models` column through the normal test admission transaction.
- A Decision fixture is intercepted before `runDecision`, then normalized and policy-applied by the existing production parser. No Decision provider is resolved and no budget admission is called.

## Tests

Passed:

- `npm run lint --workspace packages/sdk`
- `npm run build --workspace packages/sdk`
- 78 focused unit tests across `workflow-agent-models`, `workflow-decision-provider`, `workflow-decision-availability`, and `workflow-milestone-tools`
- `git diff --check`
- JavaScript syntax check for `workflow-definition-test.test.js`

Blocked locally:

- `workflow-definition-test.test.js` and `workflow-decision-model-admission.test.js` could not start because PostgreSQL refused connections at `::1:5432` and `127.0.0.1:5432` (`ECONNREFUSED`). No integration assertion ran.

## Blockers

- T2 has no answering local PostgreSQL service. This does not indicate a code failure.

## Next action

Run the two targeted PostgreSQL suites in parent T3, then include this clean commit in the P1 repair integration head.
