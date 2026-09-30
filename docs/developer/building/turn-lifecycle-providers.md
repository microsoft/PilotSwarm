# Turn lifecycle providers

Turn lifecycle providers let application code establish process-local state
around every real agent turn without adding resource-specific behavior to the
PilotSwarm worker.

An extension module can register one or more providers before the worker
starts:

```js
export function register(worker) {
    worker.registerTurnLifecycleProvider({
        name: "turn-logger",
        beforeTurn(context) {
            console.log(`starting turn ${context.turnIndex}`);
        },
        afterTurn(context) {
            console.log(`turn ${context.turnIndex}: ${context.status}`);
        },
    });
}
```

Load the module through the stock worker's existing extension mechanism:

```text
PILOTSWARM_EXTENSION_MODULES=/app/extensions/lifecycle.mjs
```

## Ordering and failures

Providers enter in registration order and unwind in reverse order:

```text
first-provider.beforeTurn
second-provider.beforeTurn
third-provider.beforeTurn
turn
third-provider.afterTurn
second-provider.afterTurn
first-provider.afterTurn
```

If setup fails, the turn does not start. PilotSwarm unwinds only providers
whose setup completed. Every cleanup is attempted even if another cleanup
fails.

The primary setup or turn error remains first. Cleanup errors follow in unwind
order in an `AggregateError`. A single cleanup failure after an otherwise
successful turn is surfaced directly.

Providers run inside the existing run-turn activity. Durable activity retries
are separate attempts, so providers must be idempotent for the same session and
turn index.

The lifecycle contract does not add activities, timers, routing decisions,
affinity policies, or serialized orchestration inputs.
