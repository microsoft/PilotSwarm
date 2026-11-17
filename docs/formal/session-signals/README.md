# Durable signals: waits, cancellation and version hand-off

These models bind the integrated orchestration 1.0.86 to code commit
`32662381395705a29dc2a72b3deb533c1130c831`. The previous upstream 1.0.85
handler remains registered and frozen. See
[the action correspondence](CORRESPONDENCE-32662381.md).
The earlier [1.0.84 correspondence](CORRESPONDENCE-9b44e791.md) is historical;
upstream has since released its own 1.0.84 and 1.0.85.

This is a bounded model check, not a proof of the TypeScript implementation.

| Module | Boundary and bounds | Cases |
|---|---|---|
| `SignalWait` | One parked wait; one arrival each of Stop, accepted input, matching signal and timeout; time 0..3, deadline 2; one continue-as-new. Ordinary waits interrupt/resume; explicit races choose one winner. | 2 PASS, 4 deliberate violations |
| `WaitScopes` | One observed wait, one replacement (wait IDs 1/2 or turn 7), one stale timer and one Stop request. A stale request cannot cancel the replacement. | 1 PASS, 3 deliberate violations |
| `SignalHandoff` | One 85-to-86 hand-off; historical replay, 19 abstract durable-state tokens including two unread inputs, title lock and tool bindings, and activation of signals only on the new handler. | 1 PASS, 2 deliberate violations, 1 implementation-shaped comparison |
| `RollingDeploy` | Existing generic model reused unchanged: two workers, abandonment cap 2, one tagged turn and one affinity lock. Here its symbols 82/83 denote actual versions 85/86. | 2 PASS, 1 expected deployment hazard |

The waiting liveness cases assume weak fairness of `Tick`, `Decide` and
`Return`; they do not force free Stop/input/signal arrivals. The hand-off
liveness case assumes weak fairness of `Deploy`, `Replay` and `ContinueAsNew`.
The passing deployment cases assume weak fairness of deployment actions
(`UpgradeOne`, `Register`, `Flip`, `Recreate`), `FetchAny`, tagged `RunTurn`
and `LockLapse`, and check eventual turn execution. The one-phase hazard
case checks safety with `Spec`, without fairness.

## Recorded results

2026-11-17, TLC 2.19 (`tla2tools` 1.7.4), Java 17, two TLC workers:
**17 of 17 cases matched their expectations: 6 PASS, 11 expected safety
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

The refreshed hand-off also covers a conflict-resolution finding: selecting
signal activities from caller-supplied `config.durableSignals` changed
historical V5/V6 descriptors. `handoff.fault-contract` reproduces that
behavior; `handoff.correct` preserves the explicit routing contract. The
regression in `packages/sdk/test/unit/agent-handoff-routing.test.mjs` verifies
both historical contracts and both epoch variants. The new frozen 1.0.85
tree is byte-pinned by `orchestration-registry-modules.test.mjs`.

`deploy.one-phase` reproduces the existing version-blind worker-fetch
hazard: an old worker can exhaust attempts on a new-version orchestration
item. Recreate and register-everywhere-before-flipping comparisons pass.
This packet neither fixes Duroxide nor authorizes a deployment.

## Scope and exclusions

Queue contenders are an unordered bounded set at a decision gate, not a
complete FIFO/queue-drain implementation. Durable fields are presence tokens,
not serialized values; title lock represents unchanged CMS state, not a new
continue-as-new field. Tool bindings ride the existing session config.
The models do not execute SQL, prove activity
transaction/result crash recovery, model arbitrary queue sizes, validate
webhook authentication or delivery, or exercise real LLM/model providers.
Existing Workflow and hydration/snapshot models remain separate; this
packet checks only the new wait carry and version boundary.

Run `./check-packet.sh`, then `TLA_TOOLS=<tools> ./run-tlc.sh <output>`.
The runners are byte-identical to the other formal folders. Regenerate
`SHA256SUMS` after changing inputs; never commit generated `.cfg` files.
