# Latest-1.0.85 correspondence (Release C)

1.0.84 is frozen in `packages/sdk/src/orchestration_1_0_84/`; 1.0.85 remains the
live `orchestration/`. This note retains the title and version correspondence
and records the FB-076 revert above `d948da16`: session deletion returns to
main `8aa84d2c`. The owner acknowledged the changes to the 1.0.85 delete steps.
Keeper's replay check on the resulting head is separate; no new replay or TLC
result is claimed here.

Retained Release C bindings: freeze of 1.0.84 (`87621a39`); FB-036/FB-040 titles;
FB-046 resurrection (0094, `../workflow/resurrection/`); real-source frozen-1.0.84
replay (`4392c580`); Workflow controller freeze and composition (`27b154ff`,
bound at `1bc1f3cb`); migration inventory (`94a91c88`); `.gitattributes`
(`f44a8640`); and the later tool-composition review corrections.

## Session-orchestration paths

| Path | Retained behavior |
|---|---|
| `orchestration_1_0_84/` | unchanged since V `87621a39` |
| `orchestration_1_0_80` to `orchestration_1_0_83`, `orchestration-registry.ts`, `orchestration-version.ts`, `orchestration.ts` | unchanged since `4273ca01` |
| `orchestration/agents.ts` | titles (FB-036), tool composition; delete steps restored to main |
| `session-proxy.ts`, `client.ts`, `cms.ts`, `management-client.ts`, `session-status.ts` | delete paths and their status handling restored to main; unrelated title and composition changes retained |

## Checks

| Item | Obligation | Evidence |
|---|---|---|
| Each version maps to its exact module | holds | `orchestration-registry.ts` 86 `{ version: "1.0.84", handler: durableSessionOrchestration_1_0_84 }`, 87 the latest; `orchestration-version.ts` 15 `DURABLE_SESSION_LATEST_VERSION = "1.0.85"` |
| The frozen 1.0.84 is the 1.0.84 that ran | holds | Every file equals `orchestration/` at `4273ca01` except the version literal and the literal `"tool-composition-v1"` at the proxy sites; no `proxy-contract` import. Enforced by `test/unit/orchestration-freeze-1-0-84.test.mjs`; exercised end to end by `test/local/session-real-source-frozen-84.test.js` (a durable wait parked by a real 1.0.84 worker resumes on Release C without replacing its execution or history) |
| The activity contract | kept | 1.0.85 routes as `tool-composition-v1` (coordinator's decision, 2026-11-13 14:40Z): every activity input change in 1.0.85 is optional and absent from what 1.0.84 sends; deploys stop every worker |
| Activity inputs the frozen versions send | unchanged | `spawnChildSession` retains optional trailing `lockTitle`, added only when defined. `summarizeSession` results are discarded by every frozen version. Both live 1.0.85 and frozen 1.0.84 send main's `{sessionId}` and `{sessionId, reason}` for descendant enumeration and deletion |
| Shared deletion activity bodies | main behavior | Listing retains main's `cmsRetryCritical`; deletion starts the SDK client, calls `deleteSession(sessionId)` once and stops the client in `finally` |
| CMS 0093 and 0094 | not activity I/O | 0093 `cms_update_session_title_if_unlocked` runs inside the summary activity. 0094 is FB-046's bound migration (`../workflow/resurrection/CORRESPONDENCE-dbfb61a7.md`) |

## FB-076: deletion deferred

The honest-delete work (FB-034, FB-037/038/039 and FB-058) is deferred. The live
delete branch and terminal-child `delete_agent` call return to main's
`orchestration/agents.ts`, whose delete steps match frozen 1.0.84. The reply
precedes the delete attempt; descendant failures remain best-effort and do not
retain ancestors. The SDK and management deletion paths have main's order,
reads and failure handling. Their stronger deletion guarantees are not part of
this release. Migration 0094's independent creation/resurrection guards remain.

## Models

`VersionHandoff` and `RollingDeploy` carry over: the 1.0.84 to 1.0.85 handoff is the same continue-as-new shape as
1.0.82 to 1.0.83 (`CORRESPONDENCE-latest-1083.md`), with the same KV FIFO keys and the same stop-all deploy. No earlier
session-orchestration model reads titles, so FB-036 and FB-040 add no obligation
there beyond replay. The deferred delete-cascade model and its claims are removed.
No new TLC run for this file.

Tests relied on: `orchestration-freeze-1-0-84.test.mjs`, `session-real-source-frozen-84.test.js`,
`session-title-tools.test.js`. The revert is checked against main and the retained
baseline deletion tests; exact-head execution results belong to its handoff.

## Retained Workflow controller correspondence

| Merge | Source change | Binding |
|---|---|---|
| PR 303 (`be6a6e8f`) | the six Workflow controller files of FB-064 | `../workflow/handoff/CORRESPONDENCE-93710d97.md` (`ControllerHandoff`, ch2, 13 of 13), pinned at `be6a6e8f`; not a session-orchestration change |

The final release qualification remains owned by the integration lead.
