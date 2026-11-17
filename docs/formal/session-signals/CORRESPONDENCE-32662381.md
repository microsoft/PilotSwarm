# Action correspondence at 32662381

Code head: `32662381395705a29dc2a72b3deb533c1130c831`. Paths below are
relative to `packages/sdk/src/`; line numbers refer to that commit.
The code was re-read after integrating upstream
`f10b422c93171a2b09a72e30bf67feac980f3630`.
This is a bounded abstraction, not an executable refinement proof.

| Model action / definition | Code anchor | Classification and mapping |
|---|---|---|
| `SignalWait.Init`, `AbsoluteDeadline` | `orchestration/signals.ts:225-264` | **Code behavior:** `startSignalWait` assigns a wait ID and an absolute optional deadline. **Model simplification:** one finite deadline; indefinite waits are runtime-tested, not covered by this liveness model. |
| `Arrival`, `Tick` | `orchestration/signals.ts:69-111,182-223`; `orchestration/queue.ts:282` | **Model simplification:** accepted inputs and durable timer completion become at-most-once set arrivals. No SQL/activity transaction-result crash split is represented. |
| `Priority`, `Finish`, `GatePriority` | `orchestration/queue.ts:848-1368,1672-1834`; `orchestration/signals.ts:128-163,266-339` | **Rule to evaluate:** Stop/cancel precedes accepted user input, then matching signal, then timeout at an eligible decision gate. Code chooses one race result and defers dispatch until bounded drain completes. The set model does not implement the complete queue. |
| `Interrupt`, `ReturnNormal` | `orchestration/signals.ts:113-126,182-223`; `orchestration/state.ts:757-760`; `orchestration/turn.ts:832-835` | **Code behavior:** ordinary signal waits suspend for an input turn and retain their deadline. **Model simplification:** return abstracts the whole model turn. |
| `ReturnStopped`, `StopIsFinal` | `orchestration/turn.ts:1353-1356`; `orchestration/signals.ts:165-180` | **Code behavior:** stopped/cancelled turn results retire the suspended wait instead of rearming it. |
| `ContinueAsNew`, `WaitNotLost` | `orchestration/lifecycle.ts:595-710,743-815` | **Code behavior:** wait/dedupe state survives carry; signal timers do not become relative ordinary timers. **Model simplification:** one carry step without snapshot storage. |
| `WaitScopes.Observe`, `ReplaceWait`, `ReplaceTurn` | `management-client.ts:3350-3367,3456-3489`; `orchestration/signals.ts:225-264` | **Model simplification:** one read and one replacement capture the race window. The CMS turn-control refusal/fallback is not modelled as database transactions. |
| `WaitScopes.OldTimer` | `orchestration/signals.ts:323-339`; `orchestration/queue.ts:282` | **Code behavior:** a timeout only retires its own `waitId`. |
| `WaitScopes.Stop`, `ScopedCancellation` | `management-client.ts:3358-3363,3463-3489`; `orchestration/lifecycle.ts:1074-1099` | **Code behavior:** a `no_turn` fallback is parked-only and carries the observed wait ID. It cannot retarget a replacement turn/wait; storage errors propagate. |
| `SignalHandoff.Deploy`, `Replay`, `ReplayPinned` | `orchestration-registry.ts:40-41,88-89`; `orchestration_1_0_85/runtime.ts:23`; frozen `orchestration_1_0_85/proxy-contract.ts` | **Code behavior:** upstream 85 remains frozen and registered; active 86 is separate. **Model simplification:** registry identity is Boolean; the byte-pinning regression checks the actual frozen source. |
| `SignalHandoff.ContinueAsNew`, `CarryPreserved` | `orchestration_1_0_85/lifecycle.ts:595-815`; `orchestration/lifecycle.ts:595-815`; `orchestration/state.ts:757-760`; `session-proxy.ts:6568,6641` | **Rule to evaluate:** preserve upstream queue/retry/intake/rehydration/config and shared durable state. Nineteen presence tokens abstract these fields plus two unread inputs. `toolBindings` denotes existing config, including required tools; `titleLock` denotes CMS state untouched by the orchestration hand-off, not a serialized carry field. Value-level preservation is not proved. |
| `SignalHandoff.Replay`, `HistoricalContract` | `session-proxy.ts:889-905,964-966`; live and frozen `orchestration*/proxy-contract.ts` | **Code behavior:** only explicit `signals-v1` chooses signal activities. **Implementation-shaped comparison:** the rejected config-based switch lets a caller change a historical descriptor; `FaultContract=TRUE` reproduces that violation even when the registry remains pinned. Both ordinary and epoch V5/V6 regressions cover the code fix. |
| `SignalsOnlyOnNew` | `session-signals.ts:3-4`; `orchestration/runtime.ts:186-187`; `session-proxy.ts:889-966`; `worker.ts:934` | **Code behavior:** version 86 enables signals while inheriting composition/intake/control behavior. **Model simplification:** capability registration is abstracted, not handler execution. |
| `RollingDeploy.Register`, `Flip`, `Recreate` | `orchestration-registry.ts:88-89`; `worker.ts:934` | **Rule to evaluate:** execution workers must understand the new version before it reaches them. The unchanged generic model's symbols 82/83 denote actual 85/86. |
| `RollingDeploy.Fetch`, `RunTurn`, `LockLapse` | Existing `session-orchestration/RollingDeploy.tla` engine contract; `activity-routing.ts`; `worker.ts:934` | **Model simplification:** version-blind fetch, capability-filtered execution and owner-lock expiry; two workers, abandonment cap 2. One-phase poisoning remains an existing engine hazard, not a PilotSwarm workaround. |

All 17 cases matched expectations: 6 PASS, 11 expected violations, no
unexpected results, PARTIAL or VOID. Liveness fairness and exclusions are
listed in [README.md](README.md). The earlier 83-to-84 packet remains
historical. Models do not validate upstream Workflow-controller changes,
SQL migrations, webhook authentication, real model providers or deployment.
