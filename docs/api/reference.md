# PilotSwarm Web API Reference

The Web API is the supported way to talk to a PilotSwarm deployment: a
versioned HTTP + WebSocket surface hosted by the portal server at `/api/v1`
and `/api/v1/ws`. Clients need exactly one thing — the deployment URL — and
never hold database or storage credentials.

Most callers should use a higher-level client rather than raw HTTP:

- **SDK (Node):** `new PilotSwarmClient({ apiUrl })` / `new PilotSwarmManagementClient({ apiUrl })`
- **Browser / isomorphic:** [`pilotswarm-sdk/api`](../../packages/sdk/api/README.md)
- **TUI:** `npx pilotswarm remote --api-url <url>`

To read and write the **Facts** and **Graph** surfaces (below) from an SDK app as
`FactStore` / `GraphStore` instances rather than raw HTTP, see the
[Facts & Graph SDK guide](../developer/building/facts-and-graph.md).

The contract's source of truth is the operations table in
[`packages/sdk/api/src/protocol.js`](../../packages/sdk/api/src/protocol.js) —
the portal server generates its routes from it, so this document cannot be
more current than that file. The operation tables below are generated from it.

## Conventions

- **Envelope:** every JSON operation responds `{ "ok": true, "result": … }` or
  `{ "ok": false, "error": { "code", "message" } }`.
- **Statuses:** `400` invalid request · `401` missing/invalid token ·
  `403` authenticated but not admitted (the `message` carries the authz
  reason) · `404` not found · `500` unexpected · plus operation-specific
  errors surfaced with their own codes.
- **Query types:** `boolean` params take `true`/`false`; `json` params take
  URL-encoded JSON (e.g. the paging `cursor`); dates are ISO 8601 strings.
- **Body:** JSON, limit 2 MB (binary artifact uploads ride base64 within it).

## Auth

Auth mode is discovered from the public `GET /api/v1/auth/config`
(`{ enabled, provider, client: { clientId, authority, redirectUri } | null }`).

- **`none`** — no token; every caller shares the synthetic
  `none/unknown` principal.
- **`entra`** — send `Authorization: Bearer <token>` with a v2 access token
  for scope `<clientId>/.default`. Browsers use MSAL; the TUI uses the
  interactive browser flow / auth code + PKCE (`pilotswarm auth login`; `--device-code` for headless hosts). WebSocket upgrades accept the
  bearer header or the subprotocol list `["access_token", <token>]` and
  close `4401`/`4403` on failure.
- **`proxy`** — the identity-aware front door authenticates the user and adds
  a signed assertion or trusted identity headers to each HTTP and WebSocket
  request. Browser clients send no bearer token directly; discovery returns
  `client: null`. Direct origin access must be blocked when unsigned header
  mode is enabled.

Admission follows the portal's authorization engine (app roles →
email allowlists → `PORTAL_AUTHZ_DEFAULT_ROLE`); a `403` body carries the
engine's reason.

## Bespoke routes

| Route | Auth | Description |
|---|---|---|
| `GET /api/v1/health` | public | `{ ok, started, mode, apiVersion }` — readiness probe target |
| `GET /api/v1/auth/config` | public | Auth provider discovery (see above) |
| `GET /api/v1/auth/me` | authed | `{ principal, authorization }` for the caller |
| `GET /api/v1/bootstrap` | authed | Mode, worker count, log config, models, creatable agents, session policy, auth context |
| `GET /api/v1/sessions/:sessionId/artifacts/:filename/download` | authed | Binary artifact stream (`Content-Disposition: attachment`) |
| `GET /api/v1/agent-packages/:name/download` | authed | Full SHA-verified package tarball; optional `semver`, `scope`, and admin owner selector query params |

## Streaming: `WS /api/v1/ws`

```text
client -> server: subscribeSession { sessionId } | unsubscribeSession { sessionId }
                  | subscribeLive { sessionId, topics[] } | unsubscribeLive { sessionId }
                  | subscribeLogs {} | unsubscribeLogs {}
server -> client: ready | subscribedSession { sessionId } | sessionEvent { sessionId, event }
                  | subscribedLive { sessionId, topics[] }
                  | live { sessionId, topic, seq, kind, data?, updatedAt? }
                  | subscribedLogs | logEntry { entry } | error { scope, sessionId?, error }
```

WebSocket delivery is an acceleration path; correctness comes from replay —
after a reconnect, catch up with
`GET /api/v1/management/sessions/:sessionId/events?afterSeq=…`. The log tail
is live-only (no history, no catch-up). Generic live topics are ephemeral
last-value state: reconnecting clients receive a retained snapshot from
`getLive` before subsequent notifications. They do not enter session history.

`kind` is `snapshot`, `patch`, `signal`, or `unavailable` (release cached
state and its sequence). Clients ignore stale snapshots, refetch on patch
gaps, and replay durable events independently. Topic subscriptions are limited
to 16 per session; live publishing is server-only. The optional `turn` topic
carries `phase`, `streamId`, message/reasoning IDs and cumulative text, plus
`truncated: true` when a preview reaches its limit. An idle applies only to
its stream. See [live-plane architecture](../architecture/live-plane.md).

## Operations

Operations tagged **[admin]** require the `admin` role. Session operations are
also authorized by access class: read/write may be delegated by visibility or
targeted grants; manage/destroy/share remain owner/admin only. Inaccessible
sessions return not-found to avoid an existence oracle.

### Sessions

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessions | `GET /api/v1/sessions` | — | List session summaries. |
| createSession | `POST /api/v1/sessions` | model (body), reasoningEffort (body), contextTier (body), groupId (body), visibility (body) | Create a session. Owner is the authenticated principal; visibility defaults to the deployment default. `groupId` is an initial placement into one of **your** groups — `403` if the group is missing or not yours. |
| readWorkflow | `GET /api/v1/sessions/:sessionId/workflow` | sessionId (path), runId (query), cursor (query, JSON), executionId (query), limit (query, JSON), kvRevision (query, JSON), kvKey (query), agentVersions (query, JSON), definitionRevision (query, JSON), stepInput (query, JSON) | Read a durable Workflow session without changing it: definition state, current revision and its diagnostics (no YAML), graph, runs, and one run (`runId`, default the live run) with the newest page of its node executions, typed input inbox and outbox (and a test run's intercepted effects), the rows still open that a page does not hold (`openExecutions`, `openInbox`, `openOutbox`, `test.openInterceptions`), and `run.pages`: each section's `limit` and `nextCursor`. A run that a control action touched has `run.lastControl` (`{ operation, by, at, reason? }`): who last paused, resumed, stopped or cancelled it or set its variables (`by`: `a person` with their portal `name` when known, `another session` with its `sessionId`, or `system` with its `name`). `cursor` (a `nextCursor` given back as it was) reads that section's next, older page (`{ items, nextCursor }`); `executionId` reads one node execution of the run with its whole output or runtime error (`execution.result`, within 256 KiB); `limit` (1 to 200) sets the rows per page; `kvRevision` reads that kept revision of the run's variables (each with its size and sha256, whole up to 256 KiB in all, otherwise 200-character previews) and `kvKey` with it one variable, whole; `agentVersions` (`true`, alone) reads the agent versions that publishing the current revision would lock now (`{ revision, definitionHash, resolves, locked, agents, problem }`: each named agent state's agent, package, version and exact revision, or the problem that would refuse the publication), resolved as publication resolves them; it locks nothing; `definitionRevision` (an integer, alone) reads that revision of the definition (`definitionRevision: { revision, definitionHash, valid, diagnostics, current, published, yaml, formatted }`: its YAML as saved and properly formatted, for comparing versions), only for a caller who may change the workflow (`403` otherwise), `404 DEFINITION_REVISION_NOT_FOUND` for a revision it does not have. `stepInput` (`{ state, input? }`, alone; owner decision q6) reads an agent step's input fields in the current draft and where each takes its value from (`stepInput: { state, revision, definitionHash, schemaDeclared, fields: [{ name, declared, required, type, description, current }], runInputs, inputShape, inputText }`, `current.source` one of `run_input`, `previous_step`, `variable`, `fixed`, `keep`); with `input` (field -> `{ source, name | path | value }`, a field left out is removed) it also gives `proposed: { yaml, changed, valid, diagnostics }`, the draft's YAML with only that step's input lines changed, to save with `replace_definition` at `revision`; only for a caller who may change the workflow (`403` otherwise), `400 WORKFLOW_READ_INVALID` for a published workflow, a step that is not an agent step or not written as a block mapping, or an invalid choice. Pages are separate reads, not a snapshot. Access `session:read`: not-found unless the session is readable. `404 WORKFLOW_NOT_FOUND` for a session that is not a durable Workflow, `404 RUN_NOT_FOUND` for a run that is not one of its runs, `404 EXECUTION_NOT_FOUND` for an execution that is not one of the run's, `404 KV_REVISION_NOT_FOUND` for a revision the run does not have, `400 WORKFLOW_CURSOR_INVALID` for a cursor that is not one a read of this workflow returned (or names another run than `runId`), `400 WORKFLOW_READ_INVALID` for an invalid `limit` or `executionId`, or a cursor with an `executionId`, `400 INVALID_REQUEST` for an invalid `runId`, including one that is not a single string (a list, a repeated parameter, a number): it is sent and read as invalid, never as an id coerced from it, and for a `cursor` or `limit` that is not JSON. Inactive: only a deployment that takes a person's workflow commands (`updateWorkflow`) adds `personCommands` to the view: the operations this workflow takes from people (only `pause`, `stop` and `cancel` in a workflow agent state's subtree, with a `restriction` that names its controlling agent), whether the shown run takes a graceful stop (`run.stop`), whether the caller may send them (`viewer`: `updateWorkflow`'s own `session:manage` decision), and, for a draft the caller may change, its current revision's YAML (`draft`: left out for anyone else); it grants nothing. |
| listChatWorkflowDefinitions | `GET /api/v1/sessions/:sessionId/workflow-definitions` | sessionId (path), includeDeleted (query, JSON) | Stage 2.1: a chat's Workflow Definitions, each with `definitionId`, `name`, `currentRevision`, `newestValidRevision`, its revisions (number, `valid`, version, who saved it and when; no YAML) and the Workflows started from it (`workflowSessionId`, `revision`, `runStatus`). `includeDeleted: true` lists deleted ones too. Access `session:read`. `404 CHAT_NOT_FOUND` for a Workflow session. Stage 2.2: each revision has `lastTest` (`{ testId, verdict: passed \| failed \| running, at }`) when the chat tested it. A person's copy of a package's definition has `source: "copy"` and `copiedFrom` (`{ definitionId, name, revision, package: { packageId, packageName, semver, sha256 } }`). |
| readChatWorkflowDefinition | `GET /api/v1/sessions/:sessionId/workflow-definition` | sessionId (path), definitionId (query), name (query), revision (query, JSON) | Stage 2.1: one definition, by `definitionId` (a deleted one too) or `name` (its live one), with `revision`'s YAML and diagnostics (default the newest). Stage 2.1b: with that revision's `graph` (as `readWorkflow` draws it; `null` for a revision with errors), `personCommands` (whether the deployment takes a person's save, start and delete) and `viewer` (`{ allowed, reason }`: whether this caller may send them, the `session:manage` gate). A caller who may not gets no `yaml`, the input schema and diagnostics without the values and words their author wrote, and no agent state's inline prompt (`graph.states[].about.prompt`; a state's `about.description` stays), as `readWorkflow`'s reader view. Access `session:read`. `404 DEFINITION_NOT_FOUND`, `404 REVISION_NOT_FOUND`. |
| saveChatWorkflowDefinition | `POST /api/v1/sessions/:sessionId/workflow-definitions/save` | sessionId (path), name, yaml, definitionId, expectedRevision, operationId (body) | Stage 2.1: a person saves the next revision. `definitionId` and `expectedRevision` name the revision the edit was based on; without them, the first save of `name`. `409 REVISION_STALE` (with `savedBy`, `savedAt`) when another revision was saved since, `409 DEFINITION_DELETED`, `409 DEFINITION_EXISTS` for a second first save of a name; a revision with errors is saved with them. The chat reads a note on its next turn; nothing wakes it. Access `session:manage`. Every deployment takes a person's workflow commands (`501 WORKFLOW_COMMANDS_UNAVAILABLE` only from a client created without them). |
| startChatWorkflowDefinition | `POST /api/v1/sessions/:sessionId/workflow-definitions/start` | sessionId (path), definitionId, revision, runAgainOf, inputs, vars, notifyParent, operationId (body) | Stage 2.1: a person starts a new Workflow from a revision (default the newest valid one; `runAgainOf`: the revision of that Workflow). `409 CHAT_NOT_LIVE`, `409 DEFINITION_DELETED`, `422 DEFINITION_INVALID`. Access `session:manage`. Taken on every deployment, as `saveChatWorkflowDefinition`. |
| deleteChatWorkflowDefinition | `POST /api/v1/sessions/:sessionId/workflow-definitions/delete` | sessionId (path), definitionId, operationId (body) | Stage 2.1: a person deletes a definition; `409 DEFINITION_IN_USE` (with `workflowSessionIds`) while one of its Workflows is running. Its revisions stay. Access `session:manage`. Taken on every deployment, as `saveChatWorkflowDefinition`. |
| copyChatWorkflowDefinition | `POST /api/v1/sessions/:sessionId/workflow-definitions/copy` | sessionId (path), definitionId, revision, operationId (body) | Stage 2.3: a person's **Make a copy** of a package's locked definition: its revision (default the newest) is saved as the chat's own, editable definition at revision 1, named as its YAML names it; the chat reads a note on its next turn. `409 DEFINITION_EXISTS` when the chat already has that name. Access `session:manage`. Taken on every deployment, as `saveChatWorkflowDefinition`. |
| updateChatWorkflowPackage | `POST /api/v1/sessions/:sessionId/workflow-definitions/update-package` | sessionId (path), definitionId, operationId (body) | Stage 2.3: a person takes the package's newer version of a locked definition for the chat's next Workflow; it becomes the next revision, and running Workflows keep theirs. Access `session:manage`. Taken on every deployment, as `saveChatWorkflowDefinition`. |
| updateWorkflow | `POST /api/v1/sessions/:sessionId/workflow/commands` | sessionId (path), command (body) | A person's command to a durable Workflow session: `command` is the `update_workflow` tool's command (`operation`, `operation_id` and the operation's arguments: `replace_definition`, `publish`, `publish_and_start`, `start`, `set_vars`, `pause`, `resume`, `cancel`; `stop` and the test operations when the workers run controller 1.9.0), run by the tool's own implementation; the answer is its receipt. The recorded actor is the signed-in caller, never a field of the command. Access `session:manage` (owner or admin), enforced even while the ownership switch is off. Every deployment takes it (`501 WORKFLOW_COMMANDS_UNAVAILABLE` only from a client created without a person's commands). A workflow in a workflow agent state's subtree takes only `pause`, `stop` and `cancel` (`403 WORKFLOW_HUMAN_INPUT_DENIED`). `404 WORKFLOW_NOT_FOUND` for a session that is not a durable Workflow; other refusals keep the tool's codes with an HTTP status (400 invalid, 409 conflict, 422 a value its contract refuses, 429 a limit) and their `details` (for example field errors). |
| createWorkflowChat | `POST /api/v1/sessions/for-workflow` | ref, model, reasoningEffort, contextTier, groupId, visibility (body) | Stage 2.3: a chat made for a package's Workflow Definition (`ref`: `<package>/<name>`): the definition attached and locked at the package's version, instructions to coordinate it from its interface card, its title naming it, and a first message asking the chat to greet the person and ask for the inputs it needs. `model` defaults to the deployment's. The session list shows it with `workflowRef`. The definition is attached at exactly the package version the instructions were written from; when another version became active between the two, or the package is gone, no chat is left (`409 PACKAGE_VERSION_CHANGED`, `404 PACKAGE_WORKFLOW_NOT_FOUND`). `404 PACKAGE_WORKFLOW_NOT_FOUND`. Same `groupId` placement rule as createSession. |
| createSessionForAgent | `POST /api/v1/sessions/for-agent` | agentName (body), model (body), reasoningEffort (body), contextTier (body), title (body), splash (body), initialPrompt (body), groupId (body), visibility (body) | Create a session bound to a named agent. Same `groupId` placement rule as createSession. |
| getSession | `GET /api/v1/sessions/:sessionId` | sessionId (path) | Get one session view (live orchestration status). |
| deleteSession | `DELETE /api/v1/sessions/:sessionId` | sessionId (path) | Cancel and soft-delete a session. |
| sendMessage | `POST /api/v1/sessions/:sessionId/messages` | sessionId (path), prompt (body), options (body) | Send a prompt (options: { enqueueOnly?, clientMessageIds? }). |
| sendAnswer | `POST /api/v1/sessions/:sessionId/answers` | sessionId (path), answer (body), options (body) | Answer a pending question. `options.expectedQuestion: { question, iteration? }` binds to the observed `pendingQuestion`; omitted options bind to the current question when enqueued. A stale binding preserves the text as an ordinary message. |
| sendSessionEvent | `POST /api/v1/sessions/:sessionId/events` | sessionId (path), eventName (body), data (body) | Send a custom event into the session. |
| cancelPendingMessage | `POST /api/v1/sessions/:sessionId/cancel-pending` | sessionId (path), clientMessageIds (body) | Cancel queued messages by client message ids. |

Session DTOs (`listSessions`, `getSession`, paged management listings) carry
**`viewerGroupId`** — the *caller's own* private group placement for the
session's tree root (`null`/absent on child rows and when the caller has not
placed the tree). The former `groupId` field is **gone** from session DTOs:
group membership is per-viewer state, not a property of the session. See
[Management: session groups](#management-session-groups).

### Session sharing

| Operation | Route | Access | Summary |
|---|---|---|---|
| getSessionAccess | `GET /api/v1/sessions/:sessionId/access` | readable session | Effective visibility, relation, owner, write/manage flags, and `viewerGroupId` (the caller's own placement of the tree root — never another viewer's). |
| setSessionVisibility | `PUT /api/v1/sessions/:sessionId/visibility` | owner/admin | Set `private`, `shared_read`, or `shared_write` on the whole session tree. |
| grantSessionShare | `POST /api/v1/sessions/:sessionId/shares` | owner/admin | Grant one principal targeted `read` or `write` access. |
| revokeSessionShare | `POST /api/v1/sessions/:sessionId/shares/revoke` | owner/admin | Revoke one targeted grant. |
| listSessionShares | `GET /api/v1/sessions/:sessionId/shares` | owner/admin | List targeted grants and grantee metadata. |
| listAuthzAudit | `GET /api/v1/management/authz-audit` | owner/admin | Owners read audit entries for one owned session; admins can read fleet-wide. |

### Artifacts

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listArtifacts | `GET /api/v1/sessions/:sessionId/artifacts` | sessionId (path) | List artifacts for a session. |
| getArtifactMetadata | `GET /api/v1/sessions/:sessionId/artifacts/:filename/meta` | sessionId (path), filename (path) | Artifact metadata. |
| downloadArtifact | `GET /api/v1/sessions/:sessionId/artifacts/:filename/text` | sessionId (path), filename (path) | Artifact content as text (JSON envelope). Binary: GET …/download. |
| uploadArtifact | `PUT /api/v1/sessions/:sessionId/artifacts/:filename` | sessionId (path), filename (path), content (body), contentType (body), contentEncoding (body) | Upload artifact content (base64 for binary; 2 MB JSON limit). |
| deleteArtifact | `DELETE /api/v1/sessions/:sessionId/artifacts/:filename` | sessionId (path), filename (path) | Delete an artifact. |
| readArtifactBase64 | `GET /api/v1/sessions/:sessionId/artifacts/:filename/base64` | sessionId (path), filename (path), maxBytes (query) | Size-guarded base64 read for binary artifacts (JSON-safe; default 256 KB, max 1 MB). |
| copyArtifact | `POST /api/v1/artifacts/copy` | fromSessionId, fromFilename, toSessionId, toFilename (body) | Server-side artifact copy between sessions (read access on the source, write on the target); result metadata carries `sha256` and copy provenance. |
| setArtifactPinned | `PUT /api/v1/sessions/:sessionId/artifacts/:filename/pinned` | sessionId (path), filename (path), pinned (body) | Pin/unpin an artifact; pinned artifacts survive bulk session cleanup. |

### Management: sessions

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessionsPage | `GET /api/v1/management/sessions` | limit (query: number), cursor (query: json), includeDeleted (query: boolean), systemFilter (query: `all` \| `only` \| `exclude`), viewerOnly (query: boolean) | Keyset-paginated session listing. `systemFilter` defaults to `all`; `viewerOnly` lets an authenticated administrator request the same owner/shared/system-visible catalog as the current viewer. |
| renameSession | `PATCH /api/v1/management/sessions/:sessionId` | sessionId (path), title (body) | Rename a session. |
| cancelSession | `POST /api/v1/management/sessions/:sessionId/cancel` | sessionId (path) | Cancel a session. |
| completeSession | `POST /api/v1/management/sessions/:sessionId/complete` | sessionId (path), reason (body) | Mark a session completed. |
| stopSessionTurn | `POST /api/v1/management/sessions/:sessionId/stop-turn` | sessionId (path), options (body: `reason?`, `timeoutMs?`, `requestId?`) | Stop the running turn. Stop discards the turn: the agent does not remember the stopped request or its partial work; send it again to continue. Outcome `stopped`, `too_late`, `no_active_turn` (`detail` names any other refusal), `timeout` (with `controlSeq` when the Stop was accepted) or `stop_forced` (turns of orchestration 1.0.80 and older). See [Stop and Steer](#stop-and-steer). |
| steerSessionTurn | `POST /api/v1/management/sessions/:sessionId/steer` | sessionId (path), options (body: `text`, `requestId`, `replacesClientMessageId?`) | Add guidance to the running turn; with `replacesClientMessageId`, convert that queued message. Access `session:write`; the `sessions.steering` feature is always on. Outcome `accepted` (`steerId`, `turn`, `repeat?`) or a refusal. See [Stop and Steer](#stop-and-steer). |
| setSessionModel | `POST /api/v1/management/sessions/:sessionId/model` | sessionId (path), options (body) | Switch the session model ({ model, reasoningEffort? }). |
| restartSystemSession | `POST /api/v1/management/sessions/:agentIdOrSessionId/restart-system` | agentIdOrSessionId (path), options (body) | Restart a system session (complete \| terminate \| hard_delete). With `startReplacement: false`, remove it and start nothing; refused (409 `SYSTEM_AGENT_LOADED`) while a live worker loads the agent. |
| exportExecutionHistory | `POST /api/v1/management/sessions/:sessionId/export-execution-history` | sessionId (path) | Export execution history to an artifact; returns artifact meta. |
| getSessionStatus | `GET /api/v1/management/sessions/:sessionId/status` | sessionId (path) | Live custom status + orchestration status. |
| waitForStatusChange | `GET /api/v1/management/sessions/:sessionId/status/wait` | sessionId (path), afterVersion (query: number), timeoutMs (query: number) | Long-poll for a status version change (server-capped timeout). |
| getLatestResponse | `GET /api/v1/management/sessions/:sessionId/latest-response` | sessionId (path) | Latest turn response payload, if any. |
| getOrchestrationStats | `GET /api/v1/management/sessions/:sessionId/orchestration-stats` | sessionId (path) | Orchestration runtime stats. |
| getExecutionHistory | `GET /api/v1/management/sessions/:sessionId/execution-history` | sessionId (path), executionId (query: number) | Raw execution history events. |
| getSessionEvents | `GET /api/v1/management/sessions/:sessionId/events` | sessionId (path), afterSeq (query: number), limit (query: number), eventTypes (query: json) | Session events after a sequence number (reconnect catch-up). Optional eventTypes (JSON string array) narrows to those event types server-side. |
| getSessionEventsBefore | `GET /api/v1/management/sessions/:sessionId/events-before` | sessionId (path), beforeSeq (query: number), limit (query: number), eventTypes (query: json) | Older session events for history paging. Optional eventTypes (JSON string array) narrows to those event types server-side (chat transcript paging). |
| getLive | `GET /api/v1/management/sessions/:sessionId/live` | sessionId (path), topics (query: json) | Current retained values from the ephemeral live plane, optionally filtered by topic. |
| getSessionMetricSummary | `GET /api/v1/management/sessions/:sessionId/metric-summary` | sessionId (path) | Per-session metric summary. |
| getSessionTokensByModel | `GET /api/v1/management/sessions/:sessionId/tokens-by-model` | sessionId (path) | Token totals grouped by model. |
| getSessionTreeStats | `GET /api/v1/management/sessions/:sessionId/tree-stats` | sessionId (path) | Stats rolled up across the spawn tree. |
| getSessionSkillUsage | `GET /api/v1/management/sessions/:sessionId/skill-usage` | sessionId (path), since (query) | Skill usage for one session. |
| getSessionTreeSkillUsage | `GET /api/v1/management/sessions/:sessionId/tree-skill-usage` | sessionId (path), since (query) | Skill usage across the spawn tree. |
| getSessionFactsStats | `GET /api/v1/management/sessions/:sessionId/facts-stats` | sessionId (path) | Facts stats for one session. |
| getSessionTreeFactsStats | `GET /api/v1/management/sessions/:sessionId/tree-facts-stats` | sessionId (path) | Facts stats across the spawn tree. |
| getSessionRetrievalUsage | `GET /api/v1/management/sessions/:sessionId/retrieval-usage` | sessionId (path), since (query) | Retrieval (facts/graph search) usage for one session. |
| getSessionTreeRetrievalUsage | `GET /api/v1/management/sessions/:sessionId/tree-retrieval-usage` | sessionId (path), since (query) | Retrieval usage across the spawn tree. |
| getSessionGraphNodeUsage | `GET /api/v1/management/sessions/:sessionId/graph-node-usage` | sessionId (path), since (query), limit (query: number), nodeKeyLike (query), kind (query) | Graph node usage for one session. |
| getSessionGraphEdgeSearchUsage | `GET /api/v1/management/sessions/:sessionId/graph-edge-search-usage` | sessionId (path), since (query), limit (query: number) | Graph edge-search usage for one session. |
| getSessionGraphSearches | `GET /api/v1/management/sessions/:sessionId/graph-searches` | sessionId (path), limit (query: number) | Recent graph search events for one session. |
| listChildOutcomes | `GET /api/v1/management/sessions/:parentSessionId/child-outcomes` | parentSessionId (path) | Child outcomes recorded under a parent session. |
| getChildOutcome | `GET /api/v1/management/child-outcomes/:childSessionId` | childSessionId (path) | One child outcome. |

### Management: session groups

Session groups are **private per-user organization**. A group belongs to the
caller who created it; placing a session in a group records a
(viewer, tree-root) *placement* that only changes how the catalog looks **to
that viewer**. Placement requires only **read** access to the session — owners,
collaborators, and recipients of shared sessions all organize the same session
into their *own* groups independently, and none of it changes shared session
data or reveals anyone else's grouping.

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessionGroups | `GET /api/v1/management/session-groups` | — | List **your** session groups. Viewer-scoped for every caller — **admins included**: other users' groups are never returned, and member counts/activity reflect only your own placements. |
| createSessionGroup | `POST /api/v1/management/session-groups` | input (body) | Create a session group owned by the caller. |
| updateSessionGroup | `PATCH /api/v1/management/session-groups/:groupId` | groupId (path), patch (body) | Update group title/description. |
| deleteSessionGroup | `DELETE /api/v1/management/session-groups/:groupId` | groupId (path) | Delete a session group. Its placements are cleared; the sessions themselves are untouched (a non-empty group deletes cleanly). |
| placeSessionsInGroup | `POST /api/v1/management/session-groups/place` | groupId (body), sessionIds (body) | Place session trees into one of the caller's groups (`groupId` null = ungroup). Requires read access to each session; changes no shared session data. |
| assignSessionsToGroup | `POST /api/v1/management/session-groups/:groupId/assign` | groupId (path), sessionIds (body) | **Deprecated** alias of placeSessionsInGroup. |
| moveSessionsToGroup | `POST /api/v1/management/session-groups/move` | groupId (body), sessionIds (body) | **Deprecated** alias of placeSessionsInGroup (groupId null = ungroup). |
| cancelSessionGroup | `POST /api/v1/management/session-groups/:groupId/cancel` | groupId (path), reason (body) | **Deprecated.** Cancel all sessions in a group. |
| completeSessionGroup | `POST /api/v1/management/session-groups/:groupId/complete` | groupId (path), options (body) | **Deprecated.** Complete all sessions in a group. |

**placeSessionsInGroup** request/response:

```jsonc
// POST /api/v1/management/session-groups/place
{ "groupId": "grp-123", "sessionIds": ["sess-a", "sess-b"] }   // groupId: null → ungroup

// result: one row per distinct resolved tree root
[
  { "rootSessionId": "sess-a", "placed": true,  "reason": null },
  { "rootSessionId": "sess-b", "placed": false, "reason": "not_found" }
]
```

- Session ids resolve to their **tree root** before placing (children are never
  placed; duplicates collapse to one row).
- Per-row `reason` on `placed: false`: **`not_found`** — the id is unknown *or*
  the caller cannot read it (identical shape by design; no existence oracle) —
  or **`system`** — system trees cannot be placed.
- The target group must be **owned by the caller**: a missing *or* foreign
  `groupId` fails the whole call with **`403`**
  (`"Session group not found or not owned by you."`) — deliberately not
  distinguishing the two. Cross-user placement is structurally impossible.
- The deprecated aliases (`assignSessionsToGroup`, `moveSessionsToGroup`)
  execute the same viewer-private placement and return the same per-row result
  array.

### Management: fleet, users, facts, events

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getFleetStats | `GET /api/v1/management/fleet/stats` | since (query), includeDeleted (query: boolean) | Fleet-wide stats. |
| getFleetSkillUsage | `GET /api/v1/management/fleet/skill-usage` | since (query), includeDeleted (query: boolean) | Fleet-wide skill usage. |
| getFleetRetrievalUsage | `GET /api/v1/management/fleet/retrieval-usage` | since (query), includeDeleted (query: boolean) | Fleet-wide retrieval usage. |
| getFleetGraphNodeUsage | `GET /api/v1/management/fleet/graph-node-usage` | since (query), includeDeleted (query: boolean), limit (query: number), nodeKeyLike (query), kind (query) | Fleet-wide graph node usage. |
| getUserStats | `GET /api/v1/management/users/stats` | since (query), includeDeleted (query: boolean) | Per-user stats. |
| getSharedFactsStats | `GET /api/v1/management/facts/shared-stats` | — | Shared facts stats. |
| getFactsTombstoneStats | `GET /api/v1/management/facts/tombstone-stats` | ttlSeconds (query: number) | Soft-deleted facts awaiting reconciliation. |
| getTopEventEmitters | `GET /api/v1/management/events/top-emitters` | since (query), limit (query: number) | Noisiest event emitters since a date. |
| pruneDeletedSummaries | `POST /api/v1/management/summaries/prune-deleted` | olderThan (body) | Prune summaries of deleted sessions. |

### Facts

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| factsCapabilities | `GET /api/v1/facts/capabilities` | — | Store capabilities: { search, embedder, graph } — the remote isEnhancedFactStore/isGraphStore. |
| readFacts | `GET /api/v1/facts` | keyPattern (query), scopeKeys (query: json), tags (query: json), sessionId (query), agentId (query), limit (query: number), scope (query) | Read facts (ReadFactsQuery params). |
| storeFact | `POST /api/v1/facts` | input (body) | Store a fact or facts (StoreFactInput \| StoreFactInput[]). |
| deleteFact | `POST /api/v1/facts/delete` | input (body) | Delete a fact / pattern (DeleteFactInput). POST because DELETE bodies are unreliable. |
| searchFacts | `POST /api/v1/facts/search` | query (body), opts (body) | Retrieval over facts (lexical \| semantic \| hybrid). [enhanced] |
| similarFacts | `POST /api/v1/facts/similar` | scopeKey (body), opts (body) | Semantic nearest-neighbours of a known fact. [enhanced] |
| getEmbedderStatus | `GET /api/v1/facts/embedder` | — | Durable embedder status. [enhanced] |
| startFactsEmbedder **[admin]** | `POST /api/v1/facts/embedder/start` | intervalSeconds (body), batch (body) | Start the durable embedder loop. [enhanced, admin] |
| stopFactsEmbedder **[admin]** | `POST /api/v1/facts/embedder/stop` | reason (body) | Stop the durable embedder loop. [enhanced, admin] |
| forcePurgeFacts **[admin]** | `POST /api/v1/facts/purge` | input (body) | Force-purge soft-deleted facts (ForcePurgeFactsInput). [admin] |

### Graph

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| searchGraphNodes | `POST /api/v1/graph/nodes/search` | query (body) | Search graph nodes (GraphNodeQuery). |
| searchGraphEdges | `POST /api/v1/graph/edges/search` | query (body) | Search graph edges (GraphEdgeQuery). |
| graphNeighbourhood | `POST /api/v1/graph/neighbourhood` | nodeKey (body), depth (body), namespace (body) | Expand a subgraph around a node. |
| upsertGraphNode | `POST /api/v1/graph/nodes` | input (body) | Upsert a graph node (GraphNodeInput). |
| upsertGraphEdge | `POST /api/v1/graph/edges` | input (body) | Upsert a graph edge (GraphEdgeInput). |
| deleteGraphNode | `POST /api/v1/graph/nodes/delete` | nodeKey (body), namespace (body) | Delete a graph node. |
| deleteGraphEdge | `POST /api/v1/graph/edges/delete` | fromKey (body), toKey (body), predicateKey (body), namespace (body) | Delete a graph edge. |
| graphStats | `GET /api/v1/graph/stats` | namespace (query) | Graph node/edge counts. |
| listGraphNamespaces | `GET /api/v1/graph/namespaces` | prefix (query), includeArchived (query: boolean), includeDetails (query: boolean) | List graph namespaces (corpora). |
| getGraphNamespace | `GET /api/v1/graph/namespaces/:namespace` | namespace (path) | One graph namespace descriptor. |
| upsertGraphNamespace **[admin]** | `POST /api/v1/graph/namespaces` | input (body) | Register/update a graph namespace. [admin] |
| deleteGraphNamespace **[admin]** | `DELETE /api/v1/graph/namespaces/:namespace` | namespace (path) | Delete a graph namespace and its data. [admin] |

### Models, agents, policy

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listModels | `GET /api/v1/models` | — | Viewer-usable runtime provider instances (`catalogKind=runtime_provider`). Direct management callers use `listRuntimeModels(viewer)` for the same semantics; synchronous `listModels()` is the type template catalog. |
| getModelsByProvider | `GET /api/v1/models/by-provider` | — | Model templates grouped by provider type (`catalogKind=provider_type`). Use `listModels` for viewer-usable runtime provider instances. |
| getDefaultModel | `GET /api/v1/models/default` | — | The deployment default model. |
| listCreatableAgents | `GET /api/v1/agents` | — | Agents sessions can be created for. |
| listCreatableWorkflows | `GET /api/v1/workflow-definitions/catalog` | — | Stage 2.3: the package Workflow Definitions the caller can make a chat for (their own packages and the shared ones): `ref`, `name`, `package`, `packageTitle`, `semver`, `scope`, `mine`, and the card's `description`, `whenToUse`, `model`, `inputs` (`{ name, required }`), `outcomes`, `asks`, `effects`. |
| getSessionCreationPolicy | `GET /api/v1/session-creation-policy` | — | Session creation policy. |

### Runtime model providers and defaults

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listProviders | `GET /api/v1/providers` | — | Shared providers, the caller's personal providers, and admin-visible metadata. Credentials are never returned. |
| getProviderUsageSummary | `GET /api/v1/providers/usage-summary` | days? (14/30/90), providers? (comma-separated names) | The cluster summary from the usage ledger: today / week / month token totals with the input, output and cache split, a per-UTC-day series, and the per-model pivot across providers, reasoning efforts and context tiers. Admins see the cluster, system sessions included; everyone else sees their own turns. |
| createMyProvider | `POST /api/v1/me/providers` | name, type, credentials, baseUrl? (body) | Add a private BYOK provider for the authenticated user. |
| updateMyProviderCredential | `PUT /api/v1/me/providers/:name/credential` | name (path), credentials (body) | Replace the credential on the caller's personal provider while preserving its name, defaults, routing references, and usage history. |
| createProvider **[admin]** | `POST /api/v1/management/providers` | name, type, credentials, baseUrl? (body) | Add a shared cluster provider. |
| updateSharedProviderCredential **[admin]** | `PUT /api/v1/management/providers/:name/credential` | name (path), credentials (body) | Replace the credential on a shared provider while preserving its name, defaults, routing references, and usage history. A personal name reads as not found; a provider seeded from the deployment's model-providers file (its key is an environment-variable pointer) is refused. |
| clearProviderRoutingDependencies | `POST /api/v1/providers/:name/clear-routing` | name (path) | Explicitly clear ordinary/system defaults and agent overrides before deleting a provider. Shared providers require admin. |
| setProviderSystemUse **[admin]** | `PUT /api/v1/management/providers/:name/system-use` | name (path), enabled (body) | Permit system sessions to use the calling admin's personal provider without exposing it to other users. |
| getModelDefaults | `GET /api/v1/model-defaults` | — | Configured/effective user and cluster defaults; admins also receive system routing and per-agent overrides. |
| setModelDefault | `PUT /api/v1/model-defaults` | scope, provider, model, reasoningEffort?, contextTier? (body) | Set/clear a user or cluster ordinary-session default. Cluster scope requires admin. Existing sessions do not change. |
| setSystemModelDefault **[admin]** | `PUT /api/v1/management/system-model-default` | provider, model, reasoningEffort?, contextTier?, restartExisting? (body) | Set/clear the system default; optionally restart inheriting sessions with complete, terminate, or hard_delete. |
| setSystemSessionModel **[admin]** | `PUT /api/v1/management/system-sessions/:agentId/model` | agentId (path), provider, model, reasoningEffort?, contextTier? (body) | Set one persistent system-agent model override. |
| clearSystemSessionModel **[admin]** | `DELETE /api/v1/management/system-sessions/:agentId/model` | agentId (path) | Clear one override and return the agent to the system default. |
| getLegacyProviderMigrationStatus **[admin]** | `GET /api/v1/management/providers/legacy-key-migration` | — | Aggregate legacy GHCP migration status; never returns keys or hashes. |
| adoptLegacySystemGitHubCopilotKey **[admin]** | `POST /api/v1/management/providers/adopt-system-github-key` | name (body) | Copy the legacy synthetic System key server-side into the calling admin's private, system-enabled provider. |
| getProviderStatus | `GET /api/v1/providers/status` | names? (query) | Limits, current-window usage, reset times, and the caller's allowance ceiling. |
| getProviderUsageGrid | `GET /api/v1/providers/usage-grid` | — | Every visible provider/model row with fixed day, week, and month meter windows. |
| getProviderUsage | `GET /api/v1/providers/usage` | days?, provider?, model?, mine?, ownerUserId?, sessionId?, chargeClass?, dimension?, limit? (query) | Historical totals, daily series, and a bounded breakdown. Non-admin reads are owner-scoped except aggregate totals for a named shared provider. |
| setProviderLimit | `PUT /api/v1/providers/:name/limit` | name (path), period, model?, tokens (body) | Save/replace one day, week, or month limit for a provider or one qualified model. Shared requires admin; personal requires owner. |
| removeProviderLimit | `DELETE /api/v1/providers/:name/limit` | name (path), period, model? (query) | Remove one provider/model limit. |
| setProviderAllowance **[admin]** | `PUT /api/v1/management/providers/:name/allowance` | name (path), pct (body) | Set the per-user share of shared-provider limits. |
| setProviderHold **[admin]** | `PUT /api/v1/management/providers/:name/hold` | name (path), untilUtc?, release? (body) | Hold or release new turns against a provider. |
| listPausedSessions | `GET /api/v1/providers/paused` | — | Sessions waiting on a provider, limit, allowance, or hold; fleet-wide for admins, own sessions otherwise. |

Trusted session creation resolves `explicit → user default → cluster default →
first usable provider/model`, validates capabilities, and writes the exact
qualified model before orchestration starts. System sessions resolve
`per-agent override → system default → first system-eligible provider/model`.
System-default restart rollouts are serialized per agent with durable claims;
completed agents are idempotently skipped and failed agents can be retried.
Provider accounting is exactly-once per `(session, turn)`. Historical usage
survives session and provider deletion; current rules/meters are removed with a
deleted provider. The budget table always shows fixed day/week/month windows,
while the selected daily chart offers 14-, 30-, and 90-day history ranges.

### Current user

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getCurrentUserProfile | `GET /api/v1/me/profile` | — | Profile of the authenticated principal. |
| setCurrentUserProfileSettings | `PATCH /api/v1/me/profile/settings` | settings (body) | Replace profile settings. |
| setCurrentUserGitHubCopilotKey **[legacy]** | `PUT /api/v1/me/github-copilot-key` | key (body) | Legacy rollback API. New users add a private GitHub Copilot runtime provider in Admin Console. |

### System

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getLogConfig | `GET /api/v1/system/log-config` | — | Log tail availability. |
| getWorkerCount | `GET /api/v1/system/workers` | — | Live worker count. |

## Long polling

`GET …/status/wait?afterVersion=…&timeoutMs=…` holds the request open until
the session's status version advances or the timeout elapses (server-capped
at 25 s default / 300 s max — loop client-side for longer waits).

## Curl example (no-auth deployment)

```bash
BASE=https://portal.example.com/api/v1
SID=$(curl -s -X POST $BASE/sessions -H 'content-type: application/json' -d '{}' | jq -r .result.sessionId)
curl -s -X POST $BASE/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"prompt": "What is the capital of France?"}'
# poll status / read events
curl -s "$BASE/management/sessions/$SID/events?limit=50" | jq '.result[].eventType'
```


## Stop and Steer

Stop and Steer act on a session's running turn (session turn control). A turn
of orchestration 1.0.81 or later listens for them through the session catalog;
the detailed session view (`getSession`) says whether it does:
`activeTurnIndex`, `turnHigh` and `acceptsTurnControl` (true while a turn runs
on the turn-control path; list rows do not carry these fields).

| Operation | Answer |
| --- | --- |
| `steerSessionTurn` | `{ outcome: "accepted", steerId, turn, repeat? }`, or `{ outcome }` with a refusal: `no_turn` (no running turn), `legacy_turn` (the turn does not listen for controls), `not_found`, `too_many` (20 open controls on the turn), `request_id_reused` (the id was used for a different request), `steering_disabled` (not returned while `sessions.steering` is always on; kept for compatibility), `already_received` (the queued message named by `replacesClientMessageId` already reached a turn) |
| `stopSessionTurn` | `stopped`, `too_late` (the turn had already finished its model run), `no_active_turn`, `timeout` (no outcome observed before `timeoutMs`; `controlSeq` identifies an accepted Stop), or `stop_forced` on the earlier path |

- **Caller.** The Web API sets `options.caller` (the sender recorded on the
  control and its viewer) from the authenticated request and ignores body
  values. Direct-mode callers may pass `caller`. `sessions.steering` is
  always on, so the viewer does not change whether a steer is allowed.
- **Request ids.** `requestId` is required for Steer and optional for Stop.
  Retry with the same id only after a transport failure: the retry returns
  the first answer and records nothing new. After a definite `no_turn` or
  `legacy_turn` Steer refusal, send the text as an ordinary message with a
  new client message id instead, and do not retry that id.
- **Converting a queued message.** Pass the queued message's client message
  id as `replacesClientMessageId` and its text as `text`. A `delivered`
  steer replaces the message: the orchestration records
  `pending_messages.cancelled` with reason `converted_to_steer` and the
  message never runs as its own turn. Any other outcome leaves it queued;
  such a steer is never carried. A new request for the same message returns
  the first answer while its steer is open or delivered. Do not re-send the
  message yourself: it is its own fallback.
  `replacesClientMessageId` must be one of the `clientMessageIds` given in
  `options.clientMessageIds` when the message was sent. A message sent
  without client message ids cannot be converted: the steer is accepted but
  the message also runs, so its text runs twice. The server cannot tell an
  unknown id from a message that has not arrived yet.
- **Outcome.** Each accepted control gets one outcome event
  (`session.control_outcome`): a steer is `delivered`, `carried` (it runs
  with the next turn), or `not_delivered`; a Stop is `stopped` or
  `too_late`. A carried steer's later fate is the
  `session.carried_steers_closed` event (`ran`, `stopped`, `gave_up`,
  `terminal`).
- **Limits.** Steer `text` must be non-empty; the request body has the same
  2 MB JSON limit as an ordinary message (413 `PAYLOAD_TOO_LARGE`). Stop
  `timeoutMs` is 0 to 300,000 ms (default 30,000). Stop is never gated by a
  feature flag or refused for the open-control cap. `sessions.steering` is
  always on and cannot be turned off; a retry of an already recorded request
  id returns its first answer.
- **Parent agents.** An agent controls its own sub-agent's running turn with
  two tools on the same paths: `message_agent` with `deliver: "now"` steers
  it (after a `no_turn`, `legacy_turn` or `too_many` refusal the message is
  queued for the next turn instead), and `stop_agent_turn` stops the turn
  and keeps the sub-agent alive. The control's sender is the parent agent
  (`kind: "agent"`).

## Message of the day

Signed-in portal viewers use Settings > Message of the day to read today's
notice and message history, including pictures. Show splash again is a local
preview and does not dismiss a message. Admins also get create and delete
controls. Non-admins have a read-only panel.

The automatic splash reads the current notice at most every 30 seconds.
A click on that splash dismisses that message for that person.

All paths below are relative to `/api/v1`.

| Method / path | Operation | Access |
| --- | --- | --- |
| GET `/management/motd/current` | `getCurrentMotd` | Authenticated |
| POST `/management/motd/:motdId/dismiss` | `dismissMotd` | Self |
| GET `/management/motd/:motdId/image?mobile=true` | `getMotdImage` | Authenticated |
| GET `/management/motd?limit=50&before=123` | `listMotds` | Authenticated |
| POST `/management/motd` | `createMotd` | Admin |
| DELETE `/management/motd/:motdId` | `deleteMotd` | Admin |

Creation requires `bodyMd` (at most 16 KB of UTF-8) and `requestId`.
`startsAt` and `endsAt` are optional ISO 8601 times with UTC offsets. An
omitted start uses server creation time. Omit `endsAt` to keep the message
until replaced or deleted. An explicit end is exclusive and must be in the
future; when both times are supplied, end must follow start. Legacy `fromAt`
and `toAt` aliases remain accepted. Reuse the same request ID and unchanged
input to retry an uncertain response.

Among all active messages, the latest to become
active wins: `GREATEST(start, created_at)` descending, then message ID
descending. A newly created active message takes over at once. An
earlier-created schedule takes over when its start arrives. Open-ended
messages do not expire. Readers still cannot see future schedules.
Current selection happens before the viewer's dismissal is checked. If the
viewer dismissed that message, current returns null; an older active message
does not resurface. Deleting the current row is different: the next-newest
active row becomes current again, subject to its own saved dismissal.

Optional `image` and `mobileImage` each contain `{base64, contentType, alt}`.
PNG, JPEG, WebP and GIF are allowed. Each picture is at most 2 MB of decoded
bytes. Creation has a 6 MB JSON body limit; other routes keep their existing
limits. `imagePlacement` is `above` (default), `beside` or `background`. Phones
always use `above`. Optional `mobileBodyMd` supplies a shorter phone notice;
otherwise the desktop body scrolls in a bottom sheet with Got it visible.
Markdown escapes raw HTML and leaves body images as placeholders.
The splash preserves a leading markdown `---` block. It is not front matter.
The portal loads the picture for the current device. Failed picture reads
back off for five minutes. Transfers have a 60-second limit and cancel on
timeout. The text remains visible when a picture cannot be loaded.

Message IDs are decimal strings. Deletion removes the message and its
pictures, writes no audit record, and keeps dismissal rows. IDs are not reused.
History returns `live`, `hidden`, `scheduled` or `ended`, plus dismissal count.
Current reads do not expose the creator's identity.
History includes creator identity and dismissal counts only for admins.
Authenticated viewers can read existing message pictures for history and
preview after a message's start time, including after it ends. Scheduled
messages remain admin-only until their start time. Deleted messages and
pictures remain unreadable. Migration 0085 enables this read-only access over
deployed 0084; it does not change create or delete authorization.

The matching MCP names are `get_current_motd`, `dismiss_motd`, `get_motd_image`,
`list_motds`, `create_motd` and `delete_motd`. Direct MCP mutations require
`PILOTSWARM_MCP_MOTD_ADMIN=true` and an explicit actor provider and subject.
Web MCP uses the authenticated server identity instead. Built-in admin agent
tools use the same operation list, but creation takes picture artifact
references `{sessionId, filename, alt}` so image bytes stay out of model context.
The source session must be readable by that caller.

## Feature flags

Settings → Feature flags exposes personal preferences and admin cluster/user controls.
Definitions are published by code migrations; these APIs only manage values.
All paths below are relative to `/api/v1`. A feature key such as
`copilot.native_tasks` is a single path segment.

| Method / path | Operation | Access |
| --- | --- | --- |
| GET `/management/features/catalog` | `listFeatureFlags` | Authenticated |
| GET `/management/features/cluster` | `getClusterFeatureFlags` | Authenticated |
| PUT / DELETE `/management/features/cluster/:featureKey` | `setClusterFeatureFlag` / `resetClusterFeatureFlag` | Admin |
| GET `/management/users/me/features` | `getMyFeatureFlags` | Self |
| PUT / DELETE `/management/users/me/features/:featureKey` | `setMyFeatureFlag` / `unsetMyFeatureFlag` | Self |
| GET `/management/users/:userId/features` | `getUserFeatureFlags` | Admin |
| PUT / DELETE `/management/users/:userId/features/:featureKey` | `setUserFeatureFlag` / `unsetUserFeatureFlag` | Admin |
| GET `/management/features/users?query=...` | `listFeatureFlagUsers` | Admin |
| GET `/management/features/changes?limit=50` | `listFeatureFlagChanges` | Admin |

PUT bodies require `enabled`, `expectedRevision` (decimal string), and `requestId`.
Cluster PUT also requires `allowUserOverride`. DELETE takes `expectedRevision`
and `requestId` as query parameters. It removes the setting: cluster reset restores
published defaults, user unset restores inheritance. No per-session setting exists.
All mutations return the committed revision. Stale writes return 409
`FEATURE_CONFLICT`; identical retries with the same actor/request/input return the
original result. Reads include `effective`, `source`, `userOverrideIgnored`,
`alwaysOn`, and configured cluster/user settings. A successful save does not prove
worker adoption; workers report applied revisions/capability in their
`feature-flags` state.

### Always-on flags

The code registry can mark a flag `alwaysOn` (one line in
`packages/sdk/src/feature-flags.ts`). Such a flag is on everywhere before any
stored setting is read: worker resolution, the management client, the Web API,
MCP and the management agents' tools, the portal and the TUI. Stored definition
and setting rows for it are ignored and need no migration. Today
`copilot.native_tasks`, `agents.base_v2` and `sessions.steering` are always on;
`debug.enable_model_event_logging` is a normal flag, off by default.

- Read rows for an always-on flag carry `alwaysOn: true`, `effective: true`,
  `source: "always_on"`, `userOverrideIgnored: false`, and
  `notice: "This switch is now always on and may be removed in a future release."`.
  Other rows carry `alwaysOn: false` and no `notice`. `supported` keeps its meaning.
- Every set, reset or unset of an always-on flag, at cluster or user scope and for
  any caller, is refused with 409 `FEATURE_ALWAYS_ON` (the message contains the
  notice) before anything is written. Route access checks still run first, so a
  non-admin calling an admin route gets 403.
- Runtime resolution returns `{ enabled: true, source: "always_on", revision: null,
  stale: false }` even before the worker's feature cache has loaded, after a failed
  poll, or when the catalog lacks the key; `{ required: true }` does not throw.
- The portal shows such a flag as a checked, disabled, greyed switch with
  "Always on." and the notice, and no cluster or personal controls.

`sessions.steering` is always on: the management client, the Web API, MCP,
the portal and the TUI offer Steer for every viewer, and the turn-control
procedures always receive `p_steering_allowed = true`.

The SDK management client exposes the same operation names with a trusted
`FeatureViewer` first argument. Web clients derive the viewer from authentication.
MCP tools use snake case (for example `set_cluster_feature_flag`). Direct MCP mode
requires `PILOTSWARM_MCP_ACTOR_PROVIDER` and `PILOTSWARM_MCP_ACTOR_SUBJECT`; admin
writes additionally require `PILOTSWARM_MCP_FEATURE_ADMIN=true` and the trusted
admin process context. In Web MCP mode, server authentication determines authority.
