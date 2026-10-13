# Final Review — Session Turn Control, Workstream C (Delta)

**Reviewer model:** `azure-openai:gpt-6-luna`  
**Mode:** Single-model; non-interactive  
**Work ID:** `turn-control-c`  
**Reviewed delta:** `3b035d2a..525957a2` for the supplied workstream C paths  
**Candidate:** `525957a2`

## Previous finding disposition

1. **Steer idempotency after flag-off:** Partially resolved. A retry for a control recorded in the current orchestration lifetime reaches catalog deduplication and returns the first answer. The cross-lifetime case remains open; see Finding 1.
2. **MCP zero-millisecond timeout:** Resolved. `packages/app/mcp/src/tools/turn-control.ts:38` now accepts integer `timeout_ms` values from 0 through 300,000. `packages/app/mcp/test/unit/turn-control.unit.mjs` covers both boundaries and rejects values outside the range.

The previously pending `stop-turn-live.test.js` update is present: it asserts one 1.0.81 `user.stop` and `stopped` outcome without the old system message, and includes a pinned 1.0.80 legacy case.

## Finding 1 — A historical request ID can bypass the disabled steering flag

**Issue:** `_steerRequestRecorded` searches all `user.steer` events starting at sequence 0. After revival, the catalog's request-ID deduplication ignores events at or before the new `turn_base_seq`. If steering is off, a request ID from the earlier lifetime still makes the management client skip `steering_disabled`; the catalog can then record a new Steer in the current lifetime. A replay with different text can also be admitted because the current-lifetime catalog check does not see the old event. This leaves the flag gate bypassable and does not provide idempotency across this boundary.

**Current (`packages/sdk/src/management-client.ts:2575, 2635-2642`; residual documented at `.paw/work/turn-control-c/Docs.md:24-28`):**

```ts
if (!(await this._steeringEnabled(opts?.caller)) && !(await this._steerRequestRecorded(sessionId, requestId))) {
    return { outcome: "steering_disabled" };
}
```

```ts
let after = 0;
for (;;) {
    const page = await this._catalog!.getSessionEvents(sessionId, after, OUTCOME_PAGE_LIMIT, [TURN_CONTROL_EVENT_TYPES.steer]);
    if (page.some((event) => (event.data as { requestId?: unknown } | null)?.requestId === requestId)) return true;
    if (page.length < OUTCOME_PAGE_LIMIT) return false;
    after = page[page.length - 1].seq;
}
```

**Proposed fix:** Make flag admission and request-ID deduplication atomic in the catalog operation, using the same lifetime boundary as the catalog's duplicate check. A request ID from an earlier lifetime must not bypass the disabled flag or create a new control. Preserve same-lifetime retries and `request_id_reused` responses. Add a real-PostgreSQL regression test: record a Steer, revive the same session, disable steering, replay the old request ID (including with different text), and verify refusal with no new control event.

**Severity:** `must-fix`

## Evidence considered

The coordinator reported passing build, API, MCP, management and live Stop suites on the supplied commits. The app unit and E2E runs on `525957a2` were still in progress when this review was prepared.

## Summary
Counts: must-fix 1; should-fix 0; consider 0
Verdict: not ready for PR
Artifact: artifact://35341e9b-0c7c-4657-b269-7628e6e8e57c/REVIEW-r2.md
