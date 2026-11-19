# D-03 Decision settlement fix

State: implemented

## Verdict

A successful provider result or mapped `DecisionProviderError` is now independent of inference-usage settlement. Settlement uses the existing bounded best-effort CMS retry policy, keeps the `(operationId, attempt)` update idempotent, and cannot throw out of `runDecision` after the Decision result has been selected.

The provider call count, Decision entry cap, semantic policy, result shape, and pending-only terminal CAS are unchanged.

## Files

- `packages/sdk/src/workflow/runtime.ts`: retries claimed inference-operation settlement and swallows exhausted or unexpected settlement failures without replacing the Decision result.
- `packages/sdk/test/local/workflow-decision-runtime.test.js`: forces transient settlement failures for a business result and a mapped provider timeout; verifies one provider call, two settlement attempts, retained attribution, and the intended committed node result.

## Verification

- `npm run build --workspace=packages/sdk`: passed.
- `npm run lint --workspace=packages/sdk`: passed.
- `node --test packages/sdk/test/unit/workflow-decision-runtime.test.mjs`: 6 passed.
- `workflow-decision-runtime.test.js`: added regressions, but execution is blocked on this worker because PostgreSQL refuses connections on `127.0.0.1:5432` and `::1:5432` with `ECONNREFUSED`.

## Blocker and next action

Run the database-backed decision runtime suite on a worker with the repository's local PostgreSQL test database:

```sh
cd packages/sdk
node --env-file-if-exists=../../.env ../../node_modules/vitest/vitest.mjs run test/local/workflow-decision-runtime.test.js
```
