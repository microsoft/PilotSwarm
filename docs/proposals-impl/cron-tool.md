# Cron Tool — Declarative Recurring Schedules

## Status

Implemented, unreleased. Published-package prechecks depend on the executable
package security prerequisite; this proposal is not release or deployment
authorization. The current API and examples are in
[SDK apps](../developer/building/sdk-apps.md) and
[building agent packages](../building-agent-packages.md).

Package prechecks use manifest-declared generic supervised callbacks, not the
unreleased legacy `createCronPrechecks`/`cronPrechecks` exports. Arming captures
package/version/full-artifact SHA and binding revision; timers and
continue-as-new retain that exact pin. Current-owner/binding/tool admission
occurs in activities, never deterministic replay. Pending content imports
nothing; denial, timeout, caught failed calls and unfinished calls cannot skip a
model turn. Approved empty-queue callbacks skip without model hydration.
Trusted `worker.registerCronPrechecks()` registration needs no new opt-in.

### Integrated acceptance snapshot

The integrated candidate passed the root full build and:

* The five targeted cron Vitest files (`cron-precheck`, `cron-tool`,
  `cron-precheck-orchestration`, `cron-precheck-mcp`, `cron-precheck-routing`):
  **68 passed**, zero skips.
* `node --test packages\app\web\test\agent-package-review-authz.test.mjs packages\app\mcp\test\unit\agent-package-reviews.unit.mjs packages\app\ui\core\test\package-review-tabs.test.mjs`:
  **21 passed**, zero skips, covering authenticated fleet-admin authority,
  discarded client actor/admin flags, review operations and tab ordering.
* `node --test --test-reporter=tap --test-concurrency=1 packages\sdk\test\postgres\package-runtime.test.mjs`:
  **41 passed**, zero skips, against a separate standalone PostgreSQL 17 cluster
  using **SCRAM**, not PGlite or an operator database. This includes real process
  counters, browser review/activation/revoke, multiple workers, failed startup,
  authority outage, exact cron pins, actual current root-owner/config mutation,
  timeout fencing and callback denial.
* Real native worker/SDK/CLI tests in `cron-precheck-live.test.js` and
  `cron-precheck-package-live.test.js`: **four passed**, zero skips, against
  standalone SCRAM PostgreSQL. Both package variants proved pending
  import/factory/callback counts zero; approval plus activation produced exactly
  one import/tools factory/callback factory in the same non-parent PID. Two idle
  callback cycles produced zero additional model requests. The packaged-MCP
  variant had one supervised server start and at least two tool calls. Warm
  revocation/refresh added zero new execution counter entries. Trusted static
  registration, session defaults and shadow behavior remained operational.
* From `packages\sdk`, Git Bash with Git's `usr/bin` first on `PATH`:
  `node --test --test-concurrency=2 test/unit/*.test.mjs`:
  **1,609 passed, nine skipped, zero failed**. Scratch lived inside the checkout;
  the Git fixture now prevents ancestor-repository discovery itself, rather than
  inheriting a ceiling its isolation function strips. The nine skips concern
  Unix permissions/UIDs/sockets, Linux process/mount metadata and process groups,
  including one local-Git-version-dependent UID test. They are **not** claimed
  as Linux acceptance.

The requested Linux completed-candidate run and external legacy-worker fencing
proof remain separate gates. The earlier Linux run failed the passwordless
broker-role fixture under SCRAM; passing other cases did not make that run pass.
Both branches now generate and forward the same synthetic broker-role password
and cover observed cleanup after broker initialization failure. No deployment
or exact Claude Opus 4.8 completed-candidate review is claimed.

## Problem

The current `wait()` tool is imperative — the LLM must call it at the end of every turn to keep a recurring loop alive. If the LLM forgets (common with gpt-5.4), the loop dies silently. We've added prompt hardening (rules 5-6), a forgotten-timer safety net (orchestration nudge), and child-update batching to work around this, but the root cause remains: the orchestration depends on the LLM remembering to call `wait()` every single turn.

## Solution

Add a `cron` tool that lets the LLM declare a recurring schedule once. The orchestration owns the timer loop — not the LLM.

## Tool API

### `cron(seconds, reason)` — Set or update a recurring schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `seconds` | number | yes | Interval between wake-ups (minimum 15s) |
| `reason` | string | yes | What the LLM should do on each wake-up (e.g. "check sub-agents and summarize news") |

Returns: `{ status: "scheduled", interval: 45, reason: "..." }`

### `cron("cancel")` — Cancel the active schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"cancel"` | yes | Cancels the active cron |

Returns: `{ status: "cancelled" }`

### Design decisions

- **Simple interval, not cron syntax.** LLMs will butcher `*/5 * * * *`. Every real use case is "every N seconds."
- **One cron per session.** Calling `cron()` again replaces the current schedule. No multi-cron complexity.
- **Minimum 15s interval.** Prevents runaway wake-ups.
- **`reason` is mandatory.** It becomes the wake-up prompt, so the LLM knows what to do on resume.

## Orchestration Behavior

### When `cron()` is called (new `case "cron"` in result dispatch)

1. Store cron state: `{ intervalSeconds, reason }` in `OrchestrationInput.cronSchedule`.
2. Respond to the LLM: `"Recurring schedule set: every {N}s — {reason}"`
3. Continue the current turn (LLM may do more work before completing).

### When a turn completes (`case "completed"`) with an active cron

Instead of going idle or requiring the LLM to call `wait()`:

1. Publish status `"waiting"` (same as current wait behavior).
2. Schedule a durable timer for `cronSchedule.intervalSeconds * 1000` ms.
3. Race timer against inbound messages (same as current wait race pattern).
4. **Timer fires →** `continueAsNew` with prompt:
   ```
   [SYSTEM: Scheduled cron wake-up for: "{reason}". Resume your recurring task.]
   ```
5. **User message interrupts →** deliver user message to LLM (same as wait interrupt). Cron stays active — next completed turn will schedule again.
6. **Child update interrupts (<=60s remaining) →** absorb silently (same as current batching).

### When `cron("cancel")` is called

1. Clear `cronSchedule` from orchestration state.
2. Respond: `"Recurring schedule cancelled."`
3. Subsequent `case "completed"` goes to normal idle behavior.

### Cron + `wait()` interaction

They're independent. Within a cron cycle, the LLM can still call `wait()` for one-shot delays:

```
[cron fires] → LLM spawns sub-agents → calls wait(10) to poll → poll completes →
LLM summarizes → turn completes → orchestration auto-schedules next cron fire
```

If the LLM calls `wait()` while a cron is active, `wait()` takes precedence for that specific pause. After the wait completes, the turn continues. When the turn eventually completes, the cron timer fires.

### Cron + dehydration

Cron timer is handled identically to wait timer for dehydration:
- If `intervalSeconds * 1000 > dehydrateThreshold` → dehydrate, fire timer, rehydrate.
- `cronSchedule` state survives in `OrchestrationInput` across `continueAsNew`.

## State Changes

### `OrchestrationInput` (types.ts)

```typescript
/** Active recurring schedule set by the cron tool. */
cronSchedule?: {
    intervalSeconds: number;
    reason: string;
};
```

Carried across `continueAsNew` in `continueInput()`.

### `customStatus` (published to CMS)

Add `cronActive: boolean` and `cronInterval: number` to the custom status so the TUI can show cron state.

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `cronSchedule` to `OrchestrationInput` |
| `src/managed-session.ts` | Add `cron` tool definition + result type |
| `src/orchestration.ts` | Add `case "cron"` handler + cron-aware idle logic in `case "completed"` |
| `plugins/system/agents/default.agent.md` | Add `cron` to tools list + update rules |
| `packages/ui-core/src/selectors.js` | Show cron state indicator in the session list and related status surfaces |

## Agent Prompt Changes

Rules 5-6 change from:

> 5. NEVER end a turn without calling `wait()` if you have pending recurring work...
> 6. Every turn that is part of a recurring loop MUST end with a `wait()` call...

To:

> 5. For recurring/periodic tasks (monitoring, polling loops, scheduled digests), use `cron(seconds, reason)` once. The orchestration handles the schedule — you do NOT need to call `wait()` at the end of each turn.
> 6. Use `wait(seconds)` only for one-shot delays within a turn (e.g. poll sub-agents, brief pause before retry). `wait()` is not needed for recurring loops if `cron` is active.
> 7. Use `cron("cancel")` to stop a recurring schedule.

The forgotten-timer safety net remains as a fallback but should rarely fire once `cron` is adopted.

## Example Flow

User: "Monitor news headlines every 45 seconds"

```
Turn 1: LLM calls spawn_agent(3 news agents), calls cron(45, "check sub-agents and summarize news"), outputs "Started monitoring."
         → orchestration stores cronSchedule, schedules 45s timer
         → [45s passes]
Turn 2: Orchestration wakes LLM with "[SYSTEM: Scheduled cron wake-up for: check sub-agents and summarize news]"
         → LLM calls check_agents, reads facts, outputs summary table
         → turn completes → orchestration auto-schedules next 45s timer
         → [45s passes]
Turn 3: Same pattern, indefinitely
         ...
User: "Stop monitoring"
Turn N: LLM calls cron("cancel"), outputs "Monitoring stopped."
         → turn completes → goes to normal idle (no more cron fires)
```
