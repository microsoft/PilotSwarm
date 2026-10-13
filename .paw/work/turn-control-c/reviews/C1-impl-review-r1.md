## Review Result: BLOCKED

### Summary
C1 implements the planned management-client and Web API surfaces, but three blocking issues remain: Stop outcome reads hide errors, malformed Stop timeouts can create an endless wait, and a new live test replaces the default system prompt contrary to the test-integrity rules.

Reviewed candidate: `efb9601e`, against base `11563484`. All source findings below refer to immutable objects at `efb9601e`. The repository was not modified and no repository code, build, dependency command or test was executed by this reviewer.

### Tests

- Status: PASS for the coordinator-reported executed coverage; PENDING for the explicitly deferred real-PostgreSQL and live-turn coverage. This is not a full C1 test pass.
- Coordinator reports: `npm run build` passed; SDK API tests 42/42; API surface, generated-operation coverage, provider parity and web shims 20/20; app web tests 153 passed, 22 skipped; TUI tests 22/22; fake-catalog and legacy management tests 31/31 with five real-PG cases deselected; `management.test.js` 4/4; privacy check reported zero findings.
- The five real-PG cases require A2 migration 0082. The `stop-turn-live.test.js` update requires A4 and B2. These are agreed deferred dependencies, not C1 omission findings.
- None of the reported passing tests covers an outcome-read rejection or a nonnumeric `timeoutMs`. Add regression cases for issues 1 and 2 without retries or throughput reductions.
- After corrections, the coordinator should run in the approved dev environment, from `packages/sdk`: `npx vitest run test/local/turn-control-management.test.js test/local/stop-turn-management.test.js -t 'fake catalog|Web API mode|PilotSwarmManagementClient.stopSessionTurn'`, followed by `npm run build` from the repository root and `npm run test:api --workspace=pilotswarm-sdk`.
- After A2 is integrated, run from `packages/sdk`: `npx vitest run test/local/turn-control-management.test.js test/local/stop-turn-management.test.js test/local/management.test.js`. Return the exact resulting candidate and output references for this reviewer to inspect. The deferred live Stop coverage remains with the coordinator after A4/B2.

### Commits Made

None. Review improvements are supplied as a comment-only patch for parent application; functional changes are implementer-owned.

### Issues Found

#### 1. Stop outcome-read failures are silently reported as an ordinary timeout — blocking, P1

**Location:** `packages/sdk/src/management-client.ts:2658-2660`, with the misleading result at `:2674-2678`.

`getSessionEvents(...).catch(() => null)` catches every catalog read error and treats it as an empty outcome page. A database/query/provider failure can therefore produce an HTTP 200 result saying the accepted Stop has no outcome and will apply later, even if its outcome was already recorded. The caller receives neither the failure nor a trustworthy account of the control state. This also violates the required tight-error-handling rule: new code must not add broad catches or silent fallbacks.

**Required change:** Propagate the read failure, or expose it explicitly using the existing error surface while retaining accepted-control context where appropriate. Do not convert arbitrary errors into empty pages. Make the timeout detail say that no outcome was observed, not that the control is known to remain open. A genuine empty successful read may still lead to the planned timeout result.

**Required evidence:** Add a fake-catalog test where control insertion succeeds and `getSessionEvents` rejects. Assert that the actual failure reaches the caller and is not returned as `outcome: "timeout"`; cover the Web API error surface as well. Retain the successful-empty-page timeout test.

#### 2. Stop accepts unvalidated timeout input that can make the request wait forever — blocking, P1

**Location:** `packages/sdk/src/management-client.ts:2605-2606` and `:2654-2672`.

The Web API forwards the options object without runtime validation, and TypeScript types do not validate JSON. For example, `{ options: { timeoutMs: "not-a-number", requestId: "r" } }` reaches this method. `Math.max(0, timeoutMs)` produces `NaN`; both the deadline and remaining time become `NaN`; `remaining <= 0` is always false. The polling loop never times out and repeatedly schedules an effectively immediate timer. The Stop has already been inserted before this invalid input is discovered. Direct callers can also supply `NaN` or `Infinity` at runtime.

**Required change:** Validate `timeoutMs` before `turnControlAdd`. When supplied, require a finite numeric duration with the supported nonnegative range; preserve the default and zero-duration behavior deliberately. Reject invalid input through the existing `INVALID_REQUEST`/400 surface, before recording a control. Do not silently coerce a malformed value or fall back to the default.

**Required evidence:** Add direct and Web API cases for a nonnumeric string and an invalid object, plus direct cases for `NaN` and `Infinity`; assert rejection and zero control-add calls. Retain valid default, positive and zero-duration behavior. These tests must not themselves invoke the unbounded old path and hang.

#### 3. The new ordinary-message fallback test replaces the default system prompt — blocking, P2

**Location:** `packages/sdk/test/local/turn-control-management.test.js:28` and `:475-478`.

The test calls `client.createSession(ONEWORD_CONFIG)`. That fixture is defined in `packages/sdk/test/helpers/fixtures.js:86-88` as `{ systemMessage: { mode: "replace", content: "Answer in one word only. No punctuation." } }`. This is a new behavior test, not a custom-system-message test. It bypasses the default agent prompt and therefore does not exercise the required ordinary-session behavior. The approved plan's Test integrity section forbids custom system prompts used to compensate for product behavior; `.github/copilot-instructions.md:672` explicitly requires `client.createSession()` without a system-message override unless that override is what is being tested.

**Required change:** Remove the fixture import and create the session with the default configuration. Keep the guidance in the normal user prompt; preserve the one-message and zero-steer-event assertions. Do not weaken assertions, add retries, pin a model or reduce parallelism.

**Required evidence:** Run this real-PG case with the configured default model after A2 is integrated and return its output on the corrected SHA.

### Notes for Reviewer

#### Plan completeness and ownership

| C1 commitment | Review result |
| --- | --- |
| Detailed view has `activeTurnIndex`, `turnHigh`, `acceptsTurnControl`; list rows unchanged | Present at `management-client.ts:1404-1406`; fake direct/Web parity coverage exists. |
| Steer validates text/id, gates for caller viewer, inserts through catalog, maps refusals | Present at `management-client.ts:2551-2571` and `:2619-2650`. |
| Stop inserts through catalog, maps no-turn, retains legacy fallback, waits for outcome | Present at `management-client.ts:2598-2616`; issues 1 and 2 block the new wait path. |
| Protocol route and `session:write` access | Present at `packages/sdk/api/src/protocol.js:105-106`; protocol tests compare Steer with sendMessage and Stop. |
| Web client and HTTP/Node transports forward options and request id | Present; forwarding tests cover both operations. |
| Authenticated caller overwrites body identity | Present at `packages/app/web/runtime.js:1245-1256`; fake HTTP tests cover forged caller and flag-off Stop attribution. |
| Read-only collaborator refusal with no recorded controls | Real-PG test present at `turn-control-management.test.js:459-472`, awaiting A2 execution. |
| Accepted-repeat after turn end, no-turn fallback, real Stop outcome | Substantive tests present; awaiting A2, with issue 3 corrected first. |
| Generated Web operations | Diff matches the new protocol operation; regeneration is coordinator-reported, not inferred from the file alone. |
| C does not edit A/B-owned files | Changed-path comparison complies. A1's `sessions.steering` entry in `admin-diagnostics.js` is unchanged. |
| MCP, UI and documentation rollout | C2/C3/C4, not C1 omissions. |

#### Earlier test-registration concern: withdrawn

The new file is not orphaned. Current `scripts/run-tests.sh:1110-1114` discovers filtered local tests by filename, and `:1153` runs unfiltered SDK coverage. `packages/sdk/vitest.config.js:13` includes `test/local/**/*.test.js`; `packages/sdk/package.json:53` invokes unfiltered Vitest for `test:local`. Thus the new file is picked up by the current runner and npm script without an explicit new entry. The instruction at `.github/copilot-instructions.md:642` still mentions a `SUITES` array, but that description is stale relative to the actual dynamic runner. No registration edit or runner ownership violation is requested.

#### Assessment of implementer interpretations

| Interpretation | Assessment |
| --- | --- |
| Same text size limit as sendMessage means the shared Web API JSON-body cap | Reasonable. `management-client.ts:3998-4055` has no text-size limit of its own. The new body-limit test exercises both route classes. The cap applies to the entire JSON body, not exactly 2 MB of text; direct mode remains without this transport cap. |
| `TurnControlUnavailableError` is treated as legacy capability | Reasonable compatibility handling. The catch is specific and rethrows unrelated errors. A1's catalog implementation deliberately throws this error; it is not evidence that a running turn independently reported `legacy_turn`. This must not become a catch-all fallback. |
| Legacy helper is private to preserve public direct/Web parity | Appropriate. The helper was not an existing public API under that name; only public Stop is exposed. Keeping the implementation detail private avoids adding a separate legacy Web operation. |

#### Reviewer-owned comment patch

Artifact: [C1-impl-review-r1.patch](artifact://0aabc430-7100-41d7-bd68-cc720dbd9cf3/C1-impl-review-r1.patch).

The patch is a unified diff against `efb9601e`, intended for `git apply` from the repository root. It changes only the Stop docstring in `packages/sdk/src/management-client.ts`.

| Hunk | Rationale |
| --- | --- |
| Original lines 2581-2587 | Limit request-id deduplication guarantees to the turn-control path. The legacy fallback builds a fresh command id and does not deduplicate by the supplied request id; the existing wording overpromises legacy retry safety. |
| Original lines 2591-2597 | Describe timeout as an observation limit, not proof that an accepted control remains open. A response timeout cannot establish current database state. |

This patch does not fix functional issues 1 or 2 and cannot turn this review into PASS. Parent application and inspection of the corrected candidate remain pending. Before application, the parent should run `git apply --check C1-impl-review-r1.patch`, apply the exact artifact under its existing source authority, and return the resulting SHA and immutable diff. The runtime timeout detail at line 2678 is implementer-owned and must be corrected alongside issue 1.

#### Additional test robustness observation, nonblocking

At `turn-control-management.test.js:446-454`, the real-PG Stop test starts a pending Stop promise and polls for the actual control event. That is state-based synchronization, not a hidden test retry. However, if the event assertion or `turnEnd` fails, the pending promise is not awaited in a failure path. When revising the test, attach rejection handling immediately and settle/observe the pending operation during cleanup so a primary failure does not leave background work or an unhandled rejection. Preserve concurrency and avoid adding fixed synchronization sleeps.

#### Completion state

Functional rework is required. No PASS or PASS-pending-patch is issued. Return the corrected candidate and requested execution evidence to this same reviewer. The documented A2/A4/B2 dependencies remain pending separately and were not counted as blocking findings.
