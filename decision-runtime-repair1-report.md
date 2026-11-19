# Decision runtime repair 1

## Result

The current controller 1.1 plan parser now accepts `decision` nodes. Historical controller 1.0.0 was not changed.

## Source and scope

- Base: `49e26777577b1fcf0177823135b2d6b645b93cec`
- Branch: `waldemort/workflow-decision-node-runtime`
- Production change: add `item.type === "decision"` to `parsePlan` in `packages/sdk/src/workflow/controller/runtime.ts`.
- Tests changed: no.
- Provider calls: none.

## Adjacent current-runtime scan

The current controller plan interface already includes `decision`. `controller/index.ts` already intercepts Decision test runs and starts effect orchestration with `nodeType: "decision"`. The effect parser accepts that value, selects `runDecision`, and the current store/runtime paths already validate and complete Decision executions. Script-only guards for script tool calls remain intentionally unchanged.

The historical `controller_1_0_0/runtime.ts` parser remains unchanged. The source scan found no current-runtime guard adjacent to the repaired parser that rejects Decision nodes.

## Verification performed by this repair author

- Confirmed the assigned branch and clean base head before editing.
- Performed a syntax-only TypeScript parse of the changed production file.
- Checked the diff for whitespace errors.
- Did not run a T2 build, unit test, local PostgreSQL test, or provider call.

Parent-owned unchanged T3 rerun commands:

```bash
npm ci
npm run build --workspace=packages/sdk
node --test packages/sdk/test/unit/workflow-decision-runtime.test.mjs
npm exec --workspace=packages/sdk -- vitest run test/local/workflow-decision-runtime.test.js
```

The pre-repair parent evidence remained: 6/6 unit tests passed and 7/7 PostgreSQL runtime tests failed at `plan node route/grade type is invalid`.

## Self-review

- The production diff is limited to the current 1.1 parser allowlist.
- Historical controller 1.0.0 is untouched.
- Existing Decision-specific runtime paths are already present and do not require widening.
- No test behavior or test fixture was changed.
- No resource, remote, base, or deployment state was changed.
