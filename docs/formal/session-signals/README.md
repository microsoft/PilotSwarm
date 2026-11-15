# Durable signals: waits, cancellation and version hand-off

These models bind the integrated orchestration 1.0.84 to code commit
`9b44e79177dda31922dd9fbfefaa4deb47197164`. The previous upstream 1.0.83
handler remains registered and frozen. See
[the action correspondence](CORRESPONDENCE-9b44e791.md).

This is a bounded model check, not a proof of the TypeScript implementation.

| Module | Boundary and bounds | Cases |
|---|---|---|
| `SignalWait` | One parked wait; one arrival each of Stop, accepted input, matching signal and timeout; time 0..3, deadline 2; one continue-as-new. Ordinary waits interrupt/resume; explicit races choose one winner. | 2 PASS, 4 deliberate violations |
| `WaitScopes` | One observed wait, one replacement (wait IDs 1/2 or turn 7), one stale timer and one Stop request. A stale request cannot cancel the replacement. | 1 PASS, 3 deliberate violations |
| `SignalHandoff` | One 83-to-84 hand-off; historical replay, 17 abstract carried-field tokens including two unread inputs, and activation of signals only on the new handler. | 1 PASS, 2 deliberate violations |
| `RollingDeploy` | Existing generic model reused unchanged: two workers, abandonment cap 2, one tagged turn and one affinity lock. Here its symbols 82/83 denote actual versions 83/84. | 2 PASS, 1 expected deployment hazard |

The waiting liveness cases assume weak fairness of `Tick`, `Decide` and
`Return`; they do not force free Stop/input/signal arrivals. The hand-off
liveness case assumes weak fairness of `Deploy`, `Replay` and `ContinueAsNew`.
The passing deployment cases assume weak fairness of deployment actions
(`UpgradeOne`, `Register`, `Flip`, `Recreate`), `FetchAny`, tagged `RunTurn`
and `LockLapse`, and check eventual turn execution. The one-phase hazard
case checks safety with `Spec`, without fairness.

## Recorded results

2026-11-15, TLC 2.19 (`tla2tools` 1.7.4), Java 17, two TLC workers:
**16 of 16 cases matched their expectations: 6 PASS, 10 expected safety
violations, 0 unexpected results, 0 PARTIAL, 0 VOID.** All four modules passed
SANY. Cases and expected invariant names are in `cases.json`; generated
settings are not committed.

The deliberate violations remove priority, absolute-deadline preservation,
terminal Stop handling, wait carry, wait/turn identity or historical
registration. They demonstrate non-vacuous rules, not newly discovered
product defects. Regression coverage includes the corresponding signal-wait,
priority, timeout-identity, version hand-off and parked Stop tests in
`packages/sdk/test/unit/session-signals.test.mjs` and
`packages/sdk/test/local/durable-signals-runtime.test.js`.

`deploy.one-phase` reproduces the existing version-blind worker-fetch
hazard: an old worker can exhaust attempts on a new-version orchestration
item. Recreate and register-everywhere-before-flipping comparisons pass.
This packet neither fixes Duroxide nor authorizes a deployment.

## Scope and exclusions

Queue contenders are an unordered bounded set at a decision gate, not a
complete FIFO/queue-drain implementation. Carry fields are presence tokens,
not serialized values. The models do not execute SQL, prove activity
transaction/result crash recovery, model arbitrary queue sizes, validate
webhook authentication or delivery, or exercise real LLM/model providers.
Existing Workflow and hydration/snapshot models remain separate; this
packet checks only the new wait carry and version boundary.

Run `./check-packet.sh`, then `TLA_TOOLS=<tools> ./run-tlc.sh <output>`.
The runners are byte-identical to the other formal folders. Regenerate
`SHA256SUMS` after changing inputs; never commit generated `.cfg` files.
