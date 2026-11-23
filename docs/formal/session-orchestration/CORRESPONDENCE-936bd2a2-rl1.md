# RuntimeLoss (rl1) correspondence to 936bd2a2

Issue #329: the Copilot runtime child behind a pooled `CopilotClient` dies (an OOM kill, for example) during a turn or
between turns. Code at `936bd2a208d7fa7b6d61a077ca3b7e5e3de9b6ae` (branch `fix/329-dead-runtime`, based on main `45a01a81`), with
`@github/copilot-sdk` 1.0.34 (runtime `@github/copilot` 1.0.112). Mode `"main"` is bound to `45a01a81`; its lines are
marked **main**. SDK lines are `node_modules/@github/copilot-sdk/dist/client.js` at 1.0.34.

Between `928e10dd` and `45a01a81`, main changed these files only outside the modelled paths: the decide tool's turn
signal and per-turn tool call counts, the move to SDK 1.0.34 (runtime tool and session input validation, context
tiers) and the worker-shutdown cut of a running turn (#364, below). `orchestration/turn.ts`, `orchestration/utils.ts`
and `session-lifecycle.ts` are unchanged.

| Model | Code | Label |
|---|---|---|
| `Start`: the preamble hydrates (and drops the warm handle) when `sentinel = "dirty"` or `local = "none"` | `session-lifecycle.ts` `runTurnPreamble` 248-365: `localTrusted = !sentinel && localDirUsable && !epochMismatch` 271; `resolveFromStore` 207-216 calls `dropWarmSession` 212, then hydrates | Code behavior |
| `Start`: `sentinel' = "dirty"` | `session-proxy.ts` 2775-2781 `writeTurnSentinel`, after `getOrCreate`, before the turn body | Code behavior |
| `Start`, `w = "live"`: the live warm handle is reused | `session-manager.ts` `_getOrCreateUnlocked` 2358, the warm branch 3505 onward (`else if (existing)`) | Code behavior |
| `Start`, `w = "dead"`, `DropDeadWarm`: the dead handle is dropped and the session resumes on a client | `session-manager.ts` 3492-3504: `existing?.runtimeLost && turnIndex !== 0` 3493 destroys and forgets it; turn 0 resets any warm handle | Code behavior |
| `Start`, `w = "dead"`, **main**: the dead handle is reused, and the send fails at once | **main** `session-manager.ts` 3444-3445: any warm handle is reused; SDK `markDisconnected` 3708-3731 marked its session disconnected | Code behavior |
| `Start`, `OTHER`, `pooled /\ rt = "dead"` (`deadClientUse`): a session on a dead pooled client fails at once | **main** `session-manager.ts` `ensureClient` 1764 and `ensureClientForKey` 1930 return the pooled client. SDK `listModels` 2722 and `deleteSession` 2864 reach it through `getStartedConnection` 2695-2709, which throws "Client not connected" on a disconnected client without starting it | Code behavior |
| `deadClientUse` for a create or resume, **main** | **main** `_startClient` 1824-1841 calls `client.start()` before each create and resume. SDK 1.0.34 `start()` 935-943 retires a closed connection and starts again, and a disconnected client starts again (`doStart` 959, which reaps the old child 968-969). After the SDK disconnects (`disconnectAfterDrain` 3732-3747 on the connection's close 3749, or 10 s after the exit 3763) a create or resume in main gets a fresh runtime in the same client; before that, a request on the closed connection fails. The model lets every use of a dead pooled client fail | Model simplification |
| `Start`, `OTHER`, otherwise: a fresh client and runtime (`rt' = "live"`, `pooled' = TRUE`) | `session-manager.ts` `ensureClient` 1773-1775 and `ensureClientForKey` 1976-1978 evict a lost client and create another; `_startClient` 1841-1863 refuses a lost client 1847-1849 and starts inside the monitor's claim 1850 | Code behavior |
| `Die`: `rt' = "dead"`, and with `EvictDeadClient` `pooled' = FALSE` | `copilot-runtime-monitor.ts` per-child `exit` listener 185-201 calls `onUnexpectedExit`; `session-manager.ts` `_onRuntimeLost` 1880-1888 logs pid, code and signal, `_evictClient` 1866-1870, then `forceStop` in the background 1885-1887 | Code behavior |
| `Die`: `warm' = "dead"` | `managed-session.ts` `runtimeLost` 1843 reads the watch bound at creation (`bindRuntimeWatch` 1838, called at `session-manager.ts` 3653 and 3841) | Code behavior |
| `Die` during a turn: `local'` is `local` or `Torn(local)` | the runtime may have written events of the turn to the session's local dir before it died | Model simplification |
| `Die` between turns (`AllowIdleLoss`) | the same exit listener, with no turn running; the warm handle is dropped at its next `getOrCreate` | Code behavior |
| `Finish` | the turn reaches `session.idle` on a live runtime | Model simplification |
| `SettleOnExit` (`ExitWatch`) | `managed-session.ts` `_runTurnInner` 4592-4605: the turn races `runtimeWatch.onExit` with its timeout and inactivity guards; the catch 4917-4932 returns `copilotRuntimeExitMessage` (ends "Connection is closed."); the outer guard 1713, 1743-1752 for a runtime already gone. SDK 1.0.34's disconnect (`markDisconnected` 3708-3731) clears the session's handlers and emits no `session.idle`, so without this race the turn waits for the watchdog | Code behavior |
| `SettleByWatchdog` | `managed-session.ts` inactivity watchdog 4561-4585 (`DEFAULT_TURN_INACTIVITY_TIMEOUT_MS` 773, 300 s); **main** 4513-4548, 4553: the guards are the timeout and the watchdog only | Code behavior |
| no `SettleByWatchdog` with `ExitWatch` | the exit event arrives within milliseconds of the kill; the watchdog is 300 s | Model simplification (timing assumption) |
| `Postamble`, `res = "ok"`: commit, `sentinel' = "clean"` | `session-lifecycle.ts` `runTurnCommit` 426-427 `commitTurnSnapshot`, which clears the sentinel on publish | Code behavior |
| `Postamble`, `res = "loss"`, `DropDeadWarm` | `session-proxy.ts` 5117-5130: `isCopilotTransportLossMessage` (`copilot-runtime-monitor.ts` 220-224; the runtime-exit, closed, disposed, not-connected and SDK 1.0.34 disconnected-session wordings 34-43) drops the warm session (`invalidateWarmSession`, `TRANSPORT_LOSS_DESTROY_DEADLINE_MS` 663) and appends the connection-closed wording (`transportLossMessage`) | Code behavior |
| `Postamble`, `res = "loss"`, `SkipCommitOnLoss`: no commit, the sentinel stays dirty | `session-lifecycle.ts` `runTurnCommit` 405-425 returns `unpublishedReason: "transport_loss"` (413-425); `session-proxy.ts` 5427 commits, 5429-5437 emits `session.snapshot_unpublished` | Code behavior |
| `Postamble`, `res = "loss"`, **main**: the torn dir is committed and the sentinel cleared | **main** `session-lifecycle.ts` `runTurnCommit` 371-401 commits every result but a stopped one | Code behavior |
| `att' = "retry"` after a loss | `orchestration/utils.ts` `isCopilotConnectionClosedError` 298-300 matches "Connection is closed"; `orchestration/turn.ts` `handleConnectionClosedRetry` 128-213 | Code behavior |
| `Move` (once, `AllowMove`) | `orchestration/turn.ts` 150 `releaseAffinity(runtime, "error")` before the 15 s retry timer 160, so any worker may take the retry; that worker has no local dir and its own pool | Code behavior |
| `MaxTries` bounds the attempts; the lossy hand-off is not modelled | `turn.ts` 134 `retryCount <= COPILOT_CONNECTION_CLOSED_MAX_RETRIES` (3), then the lossy hand-off 165-213 (`OwnedRetry.tla`) | Model simplification |
| `Inv_StoreNeverTorn`, `Inv_NoDeadWarmReuse`, `Inv_NoDeadClientUse`, `Inv_PromptSettle`, `Inv_LossLeavesSentinelDirty`, `Prop_TurnCommits` | the requirements of issue #329 | Rule to evaluate |

Bounds: `MaxTries` 4, `MaxLoss` 3, `AllowIdleLoss` TRUE, `AllowMove` TRUE (FALSE in `rl.live-one-worker`,
`comparison.rl-main-live` and `wit.rl-turn-loss-recovered`). One session and one turn after a committed one.

Not modelled:

- the orchestration's retry count, its reset and its lossy hand-off (`OwnedRetry.tla`);
- a runtime that hangs without exiting: it keeps the 300 s watchdog;
- the bounded wait for the dropped session's destroy;
- a first turn with an empty store;
- a session that returns to the worker it left;
- other sessions on the same client, apart from `deadClientUse`;
- a worker shutdown during a turn: the manager marks its clients as stopping (`session-manager.ts` 4386), so their
  exits are not losses, and #364's shutdown cut (`session-proxy.ts` 5027-5037, before the transport-loss block) fails
  the attempt without saving its result.

In main a single session's retry always reuses its dead warm handle before it reaches the pool, so `deadClientUse` is
not reachable with one session in `Mode = "main"`. It is the failure of every other session on that client, so the
pool rule is checked by `fault.rl-keep-dead-client` instead of a comparison case.

Test evidence:

- `packages/sdk/test/local/runtime-loss.test.js`: one worker, a session with no workspace, the runtime child killed
  mid-turn. The turn settles within seconds, a `transport_loss` `snapshot_unpublished` is recorded, the retry runs on
  a fresh runtime (a new pid), and there is no `session.lossy_handoff`.
- `packages/sdk/test/local/turn-lifecycle.test.js`: a transport-loss result skips the commit and leaves the sentinel
  dirty; a completed result still commits.
- `packages/sdk/test/unit/copilot-runtime-monitor.test.mjs`: spawn claims, exit watches, `isLost`, `markStopping` and
  the message classifiers.
