# Latest-1.0.86 correspondence

1.0.85 is frozen in `packages/sdk/src/orchestration_1_0_85/`. 1.0.86 is the live
`orchestration/`. This note records why the version was opened, what the frozen
copy is, and what was checked. No model changed. No new TLC result is claimed
here.

## Why 1.0.86

PR 326 changed the live tree while it still carried the name 1.0.85. The change
is in `orchestration/agents.ts`, `handleSubAgentAction`, in the branch that
handles a `spawn_agent` action of a turn:

1. The child config goes through `applySessionWorkspaceSelection`
   (`workspace.ts`). For an explicit record or `null` it now drops the parent's
   `workingDirectory`, and drops `workspaceDefaults` unless the spawn inherits.
   `"none"` is new. 1.0.85 only set or deleted `workspace`.
2. For a session with `workflowInsideWorkflow`, the sub-agent system message
   has a different filesystem note.

Both values are part of the `captureSpawnTools` and `spawnChildSession`
activity inputs. Duroxide compares an activity's input on replay. A 1.0.85
history that recorded such a spawn would not replay on the changed tree. So the
change gets its own version, and 1.0.85 is frozen as it was released.

Reach: a turn of a current worker creates a child inside the `runTurn`
activity (`controlToolBridge.spawnAgent` in `session-proxy.ts`), where no replay
applies. The orchestration branch runs only when a turn returns a `spawn_agent`
action. The freeze does not depend on how often that happens.

## Session-orchestration paths

| Path | State |
|---|---|
| `orchestration_1_0_85/` | the live `orchestration/` of tag `v0.8.12`, with two kinds of literal only (below) |
| `orchestration/` | the tree of main `928e10dd`; its `index.ts` names 1.0.86 |
| `orchestration_1_0_26` to `orchestration_1_0_84` | unchanged since tag `v0.8.12` |
| `orchestration-registry.ts`, `orchestration-version.ts`, `orchestration.ts` | register 1.0.85 from the frozen tree and 1.0.86 from the live tree |

## Checks

| Item | Obligation | Evidence |
|---|---|---|
| Each version maps to its exact module | holds | `orchestration-registry.ts` `{ version: "1.0.85", handler: durableSessionOrchestration_1_0_85 }` from `orchestration_1_0_85/index.js`; the latest from `orchestration/index.js`; `orchestration-version.ts` `DURABLE_SESSION_LATEST_VERSION = "1.0.86"`. `test/unit/orchestration-registry-modules.test.mjs` |
| The frozen 1.0.85 is the 1.0.85 that ran | holds | Every file equals `orchestration/` at tag `v0.8.12` except the version literal, the literal `"tool-composition-v1"` at the eight proxy sites, the removed `proxy-contract` import and one header comment. Hash-pinned by `test/unit/orchestration-freeze-1-0-85.test.mjs` |
| A 1.0.85 spawn replays with its recorded inputs | holds for three recorded cases | The same test pins SHA-256 digests of the two activity inputs, recorded by running `handleSubAgentAction` of the real `v0.8.12` source: an inheriting spawn of a Workflow agent step's session, a spawn with its own record, and a spawn that clears the record. Frozen 1.0.85 produces the same bytes. Live 1.0.86 does not |
| Other in-place changes since `v0.8.12` | none visible to replay | `git diff v0.8.12..928e10dd` over `orchestration/`, the frozen trees, the registry and the version file shows only the `agents.ts` change above. Of the shared modules the trees import, only `types.ts` (types, and two functions the trees do not call) and `session-proxy.ts` changed; in `session-proxy.ts` the proxy builders (`createSessionProxy` to `createSessionManagerProxy`) are byte-identical |
| The activity contract | kept | 1.0.86 routes as `tool-composition-v1`. Its new activity input fields are absent from what 1.0.85 sends. Deploys stop every worker |
| The Workflow controller | unchanged | `workflow/controller/` and `workflow/controller_1_0_0/` have no diff since `v0.8.12`, and both import only `../controller-version.js` from outside their trees. The changes of PR 318 and PR 326 under `workflow/` are in shared activities and tools, which are not replayed |

## Models

`VersionHandoff` and `RollingDeploy` carry over: the 1.0.85 to 1.0.86 hand-off
is the same continue-as-new shape as 1.0.84 to 1.0.85
(`CORRESPONDENCE-latest-1085.md`), with the same KV FIFO keys and the same
stop-all deploy. No session-orchestration model reads a child's workspace
selection or its system message, so 1.0.86 adds no obligation there beyond
replay. No new TLC run for this file.

Tests relied on: `orchestration-freeze-1-0-85.test.mjs`,
`orchestration-freeze-1-0-84.test.mjs`, `orchestration-registry-modules.test.mjs`.
