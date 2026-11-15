# Action correspondence at 9b44e791

Code head: `9b44e79177dda31922dd9fbfefaa4deb47197164`. Paths below are
relative to `packages/sdk/src/`; line numbers refer to that commit.
The models abstract intended rules and the integrated code boundaries;
they are not an executable refinement proof.

| Model action / definition | Code anchor | Classification and mapping |
|---|---|---|
| `SignalWait.Init`, `AbsoluteDeadline` | `orchestration/signals.ts:225-264` | **Code behavior:** `startSignalWait` assigns a wait ID and an absolute optional deadline. Model simplification: one finite deadline; indefinite waits are covered by runtime tests, not this liveness model. |
| `Arrival`, `Tick` | `orchestration/signals.ts:69-111,182-223`; `orchestration/queue.ts:282` | **Model simplification:** accepted inputs and timer completion become at-most-once set arrivals. Code buffers typed signals and uses a wait-scoped durable timer. No SQL/activity crash split is represented. |
| `Priority`, `Finish`, `GatePriority` | `orchestration/queue.ts:848-1368,1672-1834`; `orchestration/signals.ts:128-163,266-339` | **Rule to evaluate:** Stop/cancel precedes accepted user input, then matching signal, then timeout at an eligible decision gate. Code completes one explicit race and defers dispatch until bounded-drain continuation is complete. The set model does not implement the entire queue. |
| `Interrupt`, `ReturnNormal` | `orchestration/signals.ts:113-126,182-223`; `orchestration/state.ts:757`; `orchestration/turn.ts:1351-1355` | **Code behavior:** ordinary signal waits suspend for an input turn and retain the deadline; model return abstracts the entire model turn. |
| `ReturnStopped`, `StopIsFinal` | `orchestration/turn.ts:1351-1355`; `orchestration/signals.ts:165-180` | **Code behavior:** an authoritative stopped/cancelled turn result retires the suspended signal wait rather than rearming it. |
| `ContinueAsNew`, `WaitNotLost` | `orchestration/lifecycle.ts:595-710,743-815` | **Code behavior:** pending wait and dedupe state survive carry; a signal timer is not converted into a relative ordinary timer. Model simplification: one carry step without snapshot storage. |
| `WaitScopes.Observe`, `ReplaceWait`, `ReplaceTurn` | `management-client.ts:3318-3458`; `orchestration/signals.ts:225-264` | **Model simplification:** one read and one replacement capture the race window. The CMS turn-control refusal and fallback are not themselves modelled as database transactions. |
| `WaitScopes.OldTimer` | `orchestration/signals.ts:323-339`; `orchestration/queue.ts:282` | **Code behavior:** a timeout only retires its own `waitId`, never a later wait. |
| `WaitScopes.Stop`, `ScopedCancellation` | `management-client.ts:3338,3430-3458`; `orchestration/lifecycle.ts:1074-1099` | **Code behavior:** a CMS `no_turn` fallback is parked-only and uses the observed wait ID. It cannot target a replacement running turn or wait. Storage errors propagate; they are not treated as timeout-shaped outcomes. |
| `SignalHandoff.Deploy`, `Replay`, `ReplayPinned` | `orchestration-registry.ts:38-39,84-85`; `orchestration_1_0_83/runtime.ts` | **Code behavior:** historical 83 remains pinned and registered; active 84 is separate. **Model simplification:** registration is one Boolean, not module-byte equivalence or a real worker deployment. |
| `SignalHandoff.ContinueAsNew`, `CarryPreserved` | `orchestration/lifecycle.ts:595-710,743-815`; `orchestration/state.ts:757` | **Rule to evaluate:** preserve upstream queue/retry/intake/rehydration state and add signal carry. Seventeen tokens stand in for real fields and unread KV inputs; their presence does not establish value-level preservation. |
| `SignalsOnlyOnNew` | `session-signals.ts`; `activity-routing.ts`; `session-proxy.ts`; `worker.ts:929` | **Code behavior:** version 84 enables signal-capable routing alongside the upstream Workflow intake capability. The model abstracts capability registration, not handler execution. |
| `RollingDeploy.Register`, `Flip`, `Recreate` | `orchestration-registry.ts:84-85`; `worker.ts:929` | **Rule to evaluate:** all execution workers must understand the new version before it reaches them. Symbols 82/83 in this byte-identical reused module mean actual 83/84. |
| `RollingDeploy.Fetch`, `RunTurn`, `LockLapse` | Existing `session-orchestration/RollingDeploy.tla` engine contract; `activity-routing.ts`, `worker.ts:929` | **Model simplification:** version-blind orchestration fetch, capability-filtered activity execution and owner-lock expiry. Two workers and abandonment cap 2 abstract real routing and attempt limits. One-phase poisoning is the existing engine hazard, not a new PilotSwarm fix. |

Fault constants deliberately remove one rule at a time. Their expected
counterexamples are distinguished from implementation findings in the
[recorded results](README.md). Regression tests reproduce the Stop and
wait-identity boundary in the actual management/orchestration code.
