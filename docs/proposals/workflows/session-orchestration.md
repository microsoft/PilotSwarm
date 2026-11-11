# Ordinary session orchestration and snapshots

This file answers what PR 270 changes in a conversational session, not just in a Workflow. For example, an agent session that exhausts its model retries can now fail the Workflow visit it was serving instead of leaving that visit pending until its deadline.

All PilotSwarm citations refer to `4fa702dc`. The baseline is main `4ccbedcca57bcc6451919da98050dd7f09bbaca1`. **Hydration** restores a conversation snapshot to a worker. **Dehydration** saves state and releases the worker's warm conversation. These operations are separate from Duroxide replay of scheduling decisions.

## Version registration and handoff

| Item | Main | PR 270 candidate |
|---|---|---|
| Latest ordinary orchestration | `durable-session-v2` 1.0.82 | `durable-session-v2` 1.0.83 |
| Current source directory | `packages/sdk/src/orchestration/` implements 1.0.82 | The directory implements 1.0.83 |
| Frozen 1.0.82 | Current implementation before the change | Copied to `packages/sdk/src/orchestration_1_0_82/`; registry maps 1.0.82 to this handler |
| Compatibility floor | 1.0.47 | Still 1.0.47 |
| New starts | Latest registered version | Latest registered version, now 1.0.83 |
| Existing histories | Replay the recorded version | Still replay the recorded version; a later continue-as-new targets the latest version |

Evidence: `packages/sdk/src/orchestration-registry.ts:35-83`, `packages/sdk/src/orchestration-version.ts:1-16`, `packages/sdk/src/orchestration_1_0_82/runtime.ts:21`, `packages/sdk/src/client.ts:981-1012`, `packages/sdk/src/worker.ts:1005-1013`.

The compatibility floor is an input-normalization obligation, not a rule that rewrites old histories. An old handler stays registered while its live execution replays. A continue-as-new creates a new execution with the latest target and carried input. `versionedContinueAsNew` in 1.0.83 rejects a target older than itself or an unparseable version. Thus an old deployment must not silently downgrade intake-bearing state. See `packages/sdk/src/orchestration/lifecycle.ts:708-786` and `packages/sdk/src/orchestration/intake-state.ts:524-545`.

This protects replay semantics, but it does not provide orchestration-version routing across mixed worker binaries. Activity tags route activities, not orchestration dispatch. A rolling version flip can still send a new-version instance to a worker that lacks that version. The [formal session notes](../../formal/session-orchestration/README.md) record this limitation through `RollingDeploy`; it is not a claim that version registration alone makes every deployment safe.

## Changes in 1.0.83

| Change | Behavior | Source |
|---|---|---|
| Intake state machine | Tracks unclaimed/settling copies, claimed held references and one fixed invocation. Latches store-write decisions before I/O and retries them without re-deciding. | `packages/sdk/src/orchestration/intake-state.ts:1-25`, `:80-188`; `packages/sdk/src/orchestration/intake-machine.ts:1` |
| Intake-aware drain | A due intake write participates in the queue/timer decision. The loop does not continue as new merely because no ordinary prompt is ready while intake has due work. | `packages/sdk/src/orchestration/runtime.ts:305-308`; `packages/sdk/src/orchestration/intake-wiring.ts:1` |
| Carry state across execution boundaries | Carry intake, owned retry, retry marker, arrival flag and owed Workflow-turn failure. Empty intake is absent rather than a new empty object on every input. | `packages/sdk/src/orchestration/lifecycle.ts:708-775` |
| Own a failed turn's retry | Keep the retry's prompt, IDs and thrown turn key separate from follow-up prompts. Only the matching retry can adopt the previously committed turn. | `packages/sdk/src/orchestration/state.ts:255-410`; `packages/sdk/src/orchestration/turn.ts:435-448`, `:555-620` |
| Preserve carried notices | Return carried rehydration notices and child digests when a queued prompt is dropped by cancellation, including dispatch-time drops. Do not erase newer observations. | `packages/sdk/src/orchestration/queue.ts:413-520`; [CarriedGiveBack correspondence](../../formal/session-orchestration/CORRESPONDENCE-bb162ed8-so5b.md) |
| Separate authors while batching | Person-authored prompts do not merge with non-person prompts. Agent and system prompts share the non-person class. Legacy unclassified runtime-looking text is a merge barrier. | `packages/sdk/src/orchestration/queue.ts:1561-1568`, `:1624`; [latest correspondence](../../formal/session-orchestration/CORRESPONDENCE-latest-1083.md#mergerule-bound-to-4ffbf909) |
| Route request-aware turns | The session and manager proxies use `workflow-intake-v1`; every normal worker registers the corresponding activities and capability tag. | `packages/sdk/src/orchestration/runtime.ts:172-176`, `packages/sdk/src/worker.ts:923-933`, `:1005-1013` |
| Do not swallow a bad handoff | At the history-size threshold, only the stats read is tolerated. A refused continue-as-new fails the execution instead of being hidden by that catch. | `packages/sdk/src/orchestration/runtime.ts:260-279` |
| Report terminal agent-turn failure | A failed Workflow-agent turn owes one report for its carried visit IDs. Failed reporting stays carried and is retried at execution/turn boundaries. A later successful turn drops an unsent report. | `packages/sdk/src/orchestration/workflow-turn-failure.ts:1-74`, `packages/sdk/src/orchestration/runtime.ts:243-247` |

The intake protocol is implemented and its activities are registered. However, `worker.ts` does not supply the `workflowIntake` enabling callback to `registerWorkflow`. `workflow/runtime.ts` selects durable send mode only when that callback returns true and the recipient version qualifies. Therefore ordinary Workflow-to-session delivery at this commit uses the legacy session queue, not the new durable-intake guarantee. See `packages/sdk/src/worker.ts:1043-1064` and `packages/sdk/src/workflow/runtime.ts:4490-4509`.

## Snapshot and hydration changes

The snapshot mechanism is not replaced. The existing lifecycle preamble probes the versioned store, restores the committed snapshot when required and can adopt a turn result already committed under the same turn key. A normal turn still commits its snapshot before the activity returns its result to Duroxide. See `packages/sdk/src/session-proxy.ts:2012-2096`, `:5610-5638`, `:5685-5712`.

PR 270 adds these specific protections:

| Boundary | Change | Why |
|---|---|---|
| Given-up hydration | 1.0.83 records `noteIntakeAttempt({kind:"hydration"})` when hydration remains required; it does not send the invocation to a model | Distinguish an unsent attempt from work already exposed; `packages/sdk/src/orchestration/turn.ts:478-524`. |
| Unsettled aborted model run | Read `takeUnsettledRun`; invalidate the warm session before snapshot commit. If invalidation throws, fail the attempt and retry without saving it | Do not save or reuse a still-live aborted run after turn-control failure; `packages/sdk/src/session-proxy.ts:5275-5288`. |
| Warm-session invalidation | Forget the warm handle in a `finally` block, even if workspace cleanup fails | A failed drop cannot leave that handle available for reuse; `packages/sdk/src/session-manager.ts:3996-4011`. |
| Continued visit result | Save the turn's visit fence with its result and adopt the winning snapshot's fence on retry | A later turn-end/stop cannot act on whichever visit happens to be newest; `packages/sdk/src/session-proxy.ts:5635-5638`, `:5698-5707`, `packages/sdk/src/session-lifecycle.ts:505-517`. |
| Idle eviction | Close/forget the warm SDK session. A committed local copy can be dropped; legacy uncommitted state is uploaded. A non-final sweep defers if CLI close is unconfirmed | Release memory without overwriting newer durable state or removing the only legacy copy; `packages/sdk/src/session-manager.ts:1953-2073`. |
| Final worker release | Prefer legacy sessions that may hold the only copy. Do not repeatedly wait on an already-unconfirmed close before upload | Preserve the useful shutdown budget, but do not claim all work finishes before process exit; `packages/sdk/src/session-manager.ts:1961-1970`, `:1995-2039`. |

An activity result carries only the events needed by the orchestration; full events are already projected in CMS. The snapshot commit can reject a superseded or user-stopped turn, and the activity records the accepted memory-loss condition. A racing attempt that finds a winning saved result returns that result, not its own divergent output. See `packages/sdk/src/session-proxy.ts:5610-5712`.

## How the three session implementation layers differ

| Layer | Responsibility |
|---|---|
| `orchestration/` | Durable, replayable decisions: queues, turn order, retry ownership, timers, handoff and owed reports. |
| `session-proxy.ts` | Activity bridge: hydrate/commit, trusted turn metadata, workflow tools and actor identity, typed completion, visit fences and CMS projections. |
| `session-manager.ts` | Worker-local session/tool lifecycle: create/resume SDK handles, choose Workflow context, apply tool restrictions, release warm state, prepare script tool executors. |
| `managed-session.ts` | Model-turn event loop: run the model, enforce pre-tool behavior, collect actions, handle stop/steer, remind agent steps and report session errors. |

Evidence: `packages/sdk/src/orchestration/runtime.ts:170-176`, `packages/sdk/src/session-proxy.ts:2012-2033`, `:5260-5288`, `packages/sdk/src/session-manager.ts:2546-2616`, `:2942-2977`, `packages/sdk/src/managed-session.ts:4616-4669`.

These layers use both CMS and Duroxide. Snapshot durability does not make a Workflow start, child creation, parent notification or cleanup atomic across those stores. [Duroxide integration](duroxide.md) gives the live-start example.
