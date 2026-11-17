---
name: debug-orchestration
description: Diagnose and fix nondeterminism errors in the duroxide orchestration. Covers the replay model, common violations, and how to audit orchestration code for determinism.
---

# Debug Orchestration Nondeterminism

If the issue is about live worker routing, session-affined activity placement, hydration/dehydration traces, or cross-pod runtime evidence rather than replay-safe code shape, use the sibling skill [`.github/skills/investigate-duroxide-runtime/SKILL.md`](../investigate-duroxide-runtime/SKILL.md).

Duroxide replays the orchestration generator from the beginning on every new event. The generator must produce the **exact same sequence of yielded actions** during replay as during original execution. A mismatch causes:

```
nondeterministic: custom status mismatch: action=CallActivity { ... } vs event=CustomStatusUpdated { ... }
```

## How replay works

1. Duroxide stores every action (yield) result in a history log.
2. On replay, it feeds stored results back into the generator at each `yield`.
3. It compares each yielded action descriptor with the stored history event.
4. If they don't match → **nondeterminism error** → orchestration fails.

`setCustomStatus()` is **also recorded** in history as `CustomStatusUpdated`. It's fire-and-forget (no yield), but its position relative to yields matters.

## Diagnosis steps

1. **Read the error message carefully.** It tells you:
   - What the orchestration **tried to do** (`action=CallActivity { name: "X" }`)
   - What the history **expected** (`event=CustomStatusUpdated { ... }`)

2. **Find the divergence point.** The orchestration took a different code path during replay. Look for:
   - `Date.now()` used in a condition before a yield or `setCustomStatus()`
   - `Math.random()` or `crypto.randomUUID()` in control flow
   - Any I/O (fetch, fs, database) done directly in the generator
   - `setCustomStatus()` that moved relative to a yield

3. **Trace the yield sequence.** Number every `yield` and `setCustomStatus()` call in the handler actually registered for the recorded version: session `packages/sdk/src/orchestration/` or its frozen `orchestration_<version>/` tree or legacy `orchestration_X_Y_Z.ts` file, or Workflow `packages/sdk/src/workflow/controller/` or its frozen `controller_<version>/`. During replay, the Nth yield must match the Nth history event. Check `orchestration-registry.ts` or `workflow/controller-registry.ts`; do not assume the live handler owns an old history.

## Common bugs and fixes

| Bug | Fix |
|-----|-----|
| `Date.now()` in condition before yield | Use `yield ctx.utcNow()` — deterministic, replay-safe |
| `Math.random()` for IDs | Use `yield ctx.newGuid()` |
| Direct I/O in generator | Wrap in an activity (`ctx.scheduleActivity()`) |
| `setTimeout` / `setInterval` | Use `yield ctx.scheduleTimer(ms)` |
| `setCustomStatus()` order changed | Ensure it appears at the same position relative to yields |
| Redeployed with changed yields | Freeze the released handler and register a new orchestration version. Deploys never reset the database. |

For a Workflow upgrade, freeze the controller's complete replay-sensitive dependency
closure in `workflow/controller_<version>/` and open the next handler in
`workflow/controller/`. Keep the frozen version literal, never a live
`controller-version.ts` import. The controller registry is the only importer of the
frozen tree; hash and import tests enforce this. Existing runs keep their admitted
version across recovery and continue-as-new. Follow the
[controller versioning procedure](../../../docs/developer/contributing/working-on-pilotswarm.md#changing-the-workflow-controller-orchestration)
and [Duroxide's versioning best practices](https://github.com/microsoft/duroxide/blob/main/docs/versioning-best-practices.md).

## Deterministic alternatives

| Non-deterministic | Deterministic equivalent |
|-------------------|--------------------------|
| `Date.now()` | `yield ctx.utcNow()` |
| `new Date()` | `yield ctx.utcNow()` (returns ms, wrap with `new Date(ms)` if needed) |
| `Math.random()` | `yield ctx.newGuid()` |
| `crypto.randomUUID()` | `yield ctx.newGuid()` |
| `setTimeout(fn, ms)` | `yield ctx.scheduleTimer(ms)` |
| `fetch()` / any I/O | `yield ctx.scheduleActivity("name", input)` |

## The `setCustomStatus` trap

`setCustomStatus()` doesn't require a yield, but duroxide records it as a `CustomStatusUpdated` event in the history. This means:

```typescript
// Original execution: condition is false → no activity yield → setCustomStatus
if (Date.now() > threshold) {           // ← non-deterministic!
    yield someActivity();               // recorded as CallActivity
}
setStatus("idle");                      // recorded as CustomStatusUpdated

// Replay: condition is NOW true → activity yield → mismatch!
// Replay expects CustomStatusUpdated but gets CallActivity
```

The fix: use `yield ctx.utcNow()` for any time-based branching.

## Runaway / leaky deployments

A very common cause of nondeterminism is **old workers from a previous deployment still running** in the same cluster, connected to the same database. This happens when:

- A previous deployment used a different Kubernetes namespace (e.g. `copilot-sdk` vs `copilot-runtime`) and was never cleaned up.
- A rolling update left old ReplicaSet pods running alongside new ones during the transition.
- Manual `kubectl run` or port-forward sessions left orphaned pods polling the same database.

Old workers run **old orchestration code** but process orchestrations that were started (or replayed) by the **new code**. The yield sequences differ → nondeterminism error.

### Diagnosis

```bash
# Check ALL namespaces for worker pods — not just the expected one
kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
```

If you see pods in an unexpected namespace or from a different ReplicaSet, that's the culprit.

### Fix

Identify the configured deployment and the exact workers missing the recorded
version or activity contract. Preserve their logs and the durable history. Under
the deployment's change approval, replace those workers with a build that registers
the required frozen and live handlers. Do not delete unrelated deployments or reset
the database to hide a replay mismatch.

## After fixing

1. Replay the preserved history against its registered frozen handler and prove
   that the action names, inputs, ordering and custom statuses still match.
2. Exercise the new handler separately, including continuation, failure and
   cancellation. Check shared activities against both versions' contracts.
3. Follow the approved deployment procedure and verify version-specific traces.
   Durable-state deletion is a separate destructive operation requiring explicit
   approval; it is not an orchestration or controller upgrade step.

## Key files
- [packages/sdk/src/orchestration/](../../../packages/sdk/src/orchestration/) — live session generator and helpers; historical handlers are in `orchestration_<version>/` trees or legacy `orchestration_X_Y_Z.ts` files
- [packages/sdk/src/orchestration-registry.ts](../../../packages/sdk/src/orchestration-registry.ts) — session version dispatch
- [packages/sdk/src/workflow/controller/](../../../packages/sdk/src/workflow/controller/) — live Workflow generator and helpers; frozen handlers are in `controller_<version>/`
- [packages/sdk/src/workflow/controller-registry.ts](../../../packages/sdk/src/workflow/controller-registry.ts) — Workflow version dispatch
- [packages/sdk/src/workflow/controller-version.ts](../../../packages/sdk/src/workflow/controller-version.ts) — single latest version for new Workflow admission
- [packages/sdk/src/workflow/runtime.ts](../../../packages/sdk/src/workflow/runtime.ts) — shared Workflow activities and helper orchestrations
- [packages/sdk/src/session-proxy.ts](../../../packages/sdk/src/session-proxy.ts) — session activities, which execute outside generator replay
