# Latest-1.0.85 correspondence (Release C)

Code: `packages/sdk/src/` at `9f55ad01f6d493610ad6dc8a4d98d4615340fc12` (`waldemort/release-c`, base `4273ca01`). 1.0.84
is frozen in `orchestration_1_0_84/`; 1.0.85 is the live `orchestration/`. Line numbers are at `9f55ad01`.

Release C, in order of binding: the freeze of 1.0.84 (V `87621a39`); FB-036/FB-040 titles; FB-046 resurrection
(0094, `../workflow/resurrection/`); FB-034's truthful delete reply and self-delete (`612f3340`); the real-source
frozen-1.0.84 replay test (`4392c580`); the PR head `27b154ff` (Workflow controller freeze, composition tests), bound
at `1bc1f3cb`; then the migration-inventory test fixture (`94a91c88`), `.gitattributes` (`f44a8640`) and the FB-037/038/039
delete cascade (`6a229b64`, `cascade/`). `packages/sdk/src` at `9f55ad01` equals the cascade's bound tree `15e20127`.

## Session-orchestration paths

| Path | At 9f55ad01 |
|---|---|
| `orchestration_1_0_84/` | unchanged since V `87621a39` |
| `orchestration_1_0_80` to `orchestration_1_0_83`, `orchestration-registry.ts`, `orchestration-version.ts`, `orchestration.ts` | unchanged since `4273ca01` |
| `orchestration/agents.ts` | titles (FB-036), the FB-034 delete reply, the FB-037/038/039 cascade |
| `session-proxy.ts`, `client.ts`, `cms.ts`, `management-client.ts`, `session-delete.ts`, `cms-delete-transaction.ts`, `session-status.ts` | activity bodies, clients and status derivation (below) |

## Checks

| Item | Verdict | Evidence at 9f55ad01 |
|---|---|---|
| Each version maps to its exact module | holds | `orchestration-registry.ts` 86 `{ version: "1.0.84", handler: durableSessionOrchestration_1_0_84 }`, 87 the latest; `orchestration-version.ts` 15 `DURABLE_SESSION_LATEST_VERSION = "1.0.85"` |
| The frozen 1.0.84 is the 1.0.84 that ran | holds | Every file equals `orchestration/` at `4273ca01` except the version literal and the literal `"tool-composition-v1"` at the proxy sites; no `proxy-contract` import. Enforced by `test/unit/orchestration-freeze-1-0-84.test.mjs`; exercised end to end by `test/local/session-real-source-frozen-84.test.js` (a durable wait parked by a real 1.0.84 worker resumes on Release C without replacing its execution or history) |
| The activity contract | kept | 1.0.85 routes as `tool-composition-v1` (coordinator's decision, 2026-11-13 14:40Z): every activity input change in 1.0.85 is optional and absent from what 1.0.84 sends; deploys stop every worker |
| Activity inputs the frozen versions send | unchanged | `spawnChildSession`: optional trailing `lockTitle` (`session-proxy.ts` 1246, added only when defined at 1252; 1.0.85 `agents.ts` 1058). `summarizeSession` results are discarded by every frozen version. `getDescendantSessionIds` and `deleteSession` (`session-proxy.ts` 1312, 1330-1335): `selfDelete`, `strictCascade` and `deadlineAtMs` are added only when set, so frozen 1.0.84 still sends `{sessionId}` and `{sessionId, reason}` |
| Shared activity bodies under frozen callers | today's behaviour | Without `strictCascade` the listing activity keeps its retry (`cmsRetryCritical`) and the delete activity calls the client with `strictCascade: false` (`session-proxy.ts` 7348): the legacy cascade and the unguarded soft delete. Modeled as `Inv_FrozenNoWorse` in `cascade/` |
| CMS 0093 and 0094 | not activity I/O | 0093 `cms_update_session_title_if_unlocked` runs inside the summary activity. 0094 is FB-046's bound migration (`../workflow/resurrection/CORRESPONDENCE-dbfb61a7.md`) |

## The live 1.0.85 delete path

`orchestration/agents.ts` `cancelSession`, delete branch, in recorded order: `notifyParentOfTerminalState`;
`session.destroy`; `utcNow` (599; deadline = start + 50 s); `getDescendantSessionIds` with `strictCascade` and the
deadline (605); `deleteSession` per descendant with the same, no `selfDelete` (614); then, only if nothing failed, the
session's own `deleteSession` with `selfDelete` (636). On success `writeCommandResponse` ("Session deleted"); on any
failure `writeCommandResponse` (error) first, then `publishStatus("failed")` (a recorded custom-status event), then
`updateCmsState("failed")`; then `orchestrationResult` (686). A cancel writes its reply before the branch, as before.
delete_agent's terminal-child route records `utcNow` and a strict `deleteSession` (1334-1335).

| Obligation | Evidence |
|---|---|
| Without `selfDelete`, a successful self-delete loses its reply | duroxide core 0.1.32: the activity's `cancelInstance` becomes `OrchestrationCancelRequested` in the turn that dequeues it, and `finalize_turn` returns `Cancelled` ahead of the generator's output. Hence the flag |
| The cancel is skipped for the session itself only | `client.ts` 612 (strict) and 644 (legacy) pass `skipOrchestrationCancel` for the target only; descendants are cancelled (654, 683). `test/local/delete-self-cancel-live.test.js`: a real self-delete ends `Completed` with its reply |
| A failure after a successful delete cannot report failure | the legacy activity traces `sdkClient.stop()` errors (`session-proxy.ts` 7372 onward); the strict activity settles a timed-out client start without deleting |
| Truthful, bounded cascade with no new orphans | `cascade/CORRESPONDENCE-30f31912.md` (bound at `6a229b64`, the same `packages/sdk/src` tree): `DeleteCascade`, dc4, 40 of 40 as expected |
| No recorded 1.0.85 history meets these changes | TEST has run only 1.0.84 or older; DEV ran 1.0.85 only in throwaway test schemas; the first 1.0.85 on TEST is the deploy of this head, stop-all (Ace and the coordinator, option (i), 2026-11-13 21:49Z) |

Note, not an obligation: a cascaded descendant's instance reads `Completed` after an ancestor delete in the live test;
its terminal status is outside these models.

## Models

`VersionHandoff` and `RollingDeploy` carry over: the 1.0.84 to 1.0.85 handoff is the same continue-as-new shape as
1.0.82 to 1.0.83 (`CORRESPONDENCE-latest-1083.md`), with the same KV FIFO keys and the same stop-all deploy. No earlier
session-orchestration model reads titles, delete results, command replies or custom status, so FB-036, FB-040 and FB-034
add no obligation there beyond replay, which the tables above cover. The delete cascade has its own model
(`cascade/DeleteCascade.tla`). No new TLC run for this file.

Tests relied on: `orchestration-freeze-1-0-84.test.mjs`, `session-real-source-frozen-84.test.js`,
`session-title-tools.test.js`, `delete-self-cancel.test.js`, `delete-self-cancel-live.test.js` and the cascade tests
named in `cascade/CORRESPONDENCE-30f31912.md`, with the full suite on `9f55ad01`.

## Release C final content (after `35466268`)

Two further merges, both outside the session orchestration (`orchestration/`, `orchestration_1_0_84/`, the registry, the
version file, `session-proxy.ts`, `client.ts`, `cms.ts`, `session-delete.ts` and `cms-delete-transaction.ts` are
unchanged from `35466268`):

| Merge | Source change | Binding |
|---|---|---|
| FB-058 (`a46213ad`) | `management-client.ts` only: a delete of a live root keeps its command id (1817) and, inside the same 65 s settle deadline, reserves 3 s (218) to read the correlated reply; a readable failure reply is thrown with the real cause, also if the row disappeared for another reason (1856); an unreadable reply never overrides the observed outcome | Narrows the cascade binding's documented limit that a running management delete could only end in the generic settle timeout (`cascade/CORRESPONDENCE-30f31912.md`). No recorded step, activity input, schema or wire change; `DeleteCascade`'s properties are unaffected |
| PR 303 (`be6a6e8f`) | the six Workflow controller files of FB-064 | `../workflow/handoff/CORRESPONDENCE-93710d97.md` (`ControllerHandoff`, ch2, 13 of 13), pinned at `be6a6e8f`; not a session-orchestration change |

The final Release C pin is the head that carries this text, after its full suite, with `packages/sdk/src` equal to the
tree recorded at that pin.
