# Final Review — Session Turn Control, Workstream C

**Reviewer model:** `azure-openai:gpt-6-luna`  
**Mode:** Single-model; non-interactive  
**Work ID:** `turn-control-c`  
**Source:** `microsoft/PilotSwarm`, `1d3c3abe...3b035d2a` (candidate `3b035d2a`)

## Findings

### 1. A disabled steering flag prevents an idempotent retry from returning the first answer

**Issue:** If the first Steer request was accepted but its response was lost, then an operator disables `sessions.steering` before the client retries, the retry returns `steering_disabled` instead of the original accepted answer. The request ID never reaches the CMS deduplication path. This violates FR-004 and the C1 plan's lost-response retry requirement; clients can mistake an accepted steer for a refusal and resend its text as a normal message.

**Current (`packages/sdk/src/management-client.ts:2572-2575`):**

```ts
if (!(await this._steeringEnabled(opts?.caller))) {
    return { outcome: "steering_disabled" };
}
const added = await this._turnControlAdd(sessionId, "steer", text, requestId, opts?.caller);
```

**Proposed fix:** Resolve and validate an existing request ID before applying the current feature gate, including the existing kind/text mismatch behavior. Only a genuinely new request should be refused when steering is disabled. Keep the duplicate lookup/admission path race-safe. Add a regression test that accepts a Steer while enabled, loses the response, disables the flag, retries the same ID, and verifies the original answer is returned with only one recorded control.

**Severity:** `must-fix`

### 2. MCP rejects the documented zero-millisecond Stop timeout

**Issue:** The management client accepts `timeoutMs: 0` (and the API reference documents `0` to `300,000` ms), but MCP's `timeout_ms` schema requires a positive integer. MCP callers therefore cannot use a valid management-operation boundary value through this surface.

**Current (`packages/app/mcp/src/tools/turn-control.ts:38`; documented at `docs/api/reference.md:389`):**

```ts
timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the turn to stop"),
```

**Proposed fix:** Accept the documented inclusive range in MCP, for example `z.number().int().min(0).max(300_000)`, and add boundary tests for `0` and `300_000` plus rejection outside the range.

**Severity:** `should-fix`

## Summary
Counts: must-fix 1; should-fix 1; consider 0
Verdict: not ready for PR
Artifact: artifact://35341e9b-0c7c-4657-b269-7628e6e8e57c/REVIEW.md
