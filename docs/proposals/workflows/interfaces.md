# Interfaces, authority and the portal

This file answers how callers reach Workflows without gaining each other's authority. For example, a shared reader can inspect run progress but cannot retrieve editable YAML or start another owner's Workflow.

All citations refer to `4fa702dc`.

## Agent tool surface

| Tool | Role | Authority and restrictions |
|---|---|---|
| `enable_workflows` | Enable Workflow tools/guidance on the session's next turn | No arguments; model is instructed to obtain agreement first. It is not a human approval token. `packages/sdk/src/workflow/guidance.ts:72-90`. |
| `workflow_definition` | `list`, `read`, `save`, `start`, `test`, `card` | Operates on the host session's definitions. Save uses a revision guard; start creates a Workflow. Delete is deliberately person-only. `packages/sdk/src/workflow/definition-tool.ts:1-79`. |
| `spawn_workflow` | Compatibility path for one release | Maps to save then start; uses the latest revision the session has seen and pins its own saved revision. It is not the preferred way to edit a definition. `packages/sdk/src/workflow/definition-tool.ts:7-8`. |
| `read_workflow` | Read definition/run/graph and paged execution, inbox, outbox, KV or test data | Host-bound session access; whole-value reads are distinct from preview reads. `packages/sdk/src/workflow/tools.ts:123-142`, `:187-228`. |
| `update_workflow` | Run controls and recovery; optional low-level test operations | Parent tool path checks the Workflow's parent. Person adapter uses a different authority path and does not expose recover. `packages/sdk/src/workflow/tools.ts:64-119`, `packages/sdk/src/workflow/human-commands.ts:10-37`. |
| `send_workflow_input` | Accept typed input into a Workflow's inbox | Host-bound sender; trusted parent or same non-system human owner, checked again under locks. `packages/sdk/src/workflow/tools.ts:229`, `packages/sdk/src/workflow/authority.ts:4-29`. |
| `respond_session_request` | Return a response or decline for a request | Only the frozen responder session; user-provided actor fields cannot substitute for it. `packages/sdk/src/workflow/request-service.ts:18-39`, `packages/sdk/src/workflow/authority.ts:81-104`. |
| `complete_workflow_node` | Finish an agent visit with a typed result | Own child session only; continued sessions must identify the visit and agree with the turn fence. `packages/sdk/src/workflow/agent-node-service.ts:23-67`, `:108-130`. |

Sessions inside a Workflow agent subtree receive no definition tools. The runtime also rejects those calls, including matching MCP tool names. This prevents an agent step from expanding the procedure by starting nested Workflow definitions. Ordinary sub-agents outside such a subtree keep their allowed definition tools. See `packages/sdk/src/workflow/input-policy.ts:48-101`.

## SDK, RPC and HTTP surface

The existing management client hosts in-process SDK calls in direct mode, or uses the normal Web API transport in web mode. RPC method names are not names of independently deployed services.

| RPC / management method | HTTP route | Access |
|---|---|---|
| `readWorkflow` | `GET /sessions/:sessionId/workflow` | `session:read`; YAML-specific subreads also require manage access |
| `listSessionWorkflowDefinitions` | `GET /sessions/:sessionId/workflow-definitions` | `session:read` |
| `readSessionWorkflowDefinition` | `GET /sessions/:sessionId/workflow-definition` | `session:read`; strip YAML and author literals for non-managers |
| `saveSessionWorkflowDefinition` | `POST /sessions/:sessionId/workflow-definitions/save` | `session:manage` |
| `startSessionWorkflowDefinition` | `POST /sessions/:sessionId/workflow-definitions/start` | `session:manage` |
| `copySessionWorkflowDefinition` | `POST /sessions/:sessionId/workflow-definitions/copy` | `session:manage` |
| `updateSessionWorkflowPackage` | `POST /sessions/:sessionId/workflow-definitions/update-package` | `session:manage` |
| `deleteSessionWorkflowDefinition` | `POST /sessions/:sessionId/workflow-definitions/delete` | `session:manage` |
| `updateWorkflow` | `POST /sessions/:sessionId/workflow/commands` | `session:manage` |
| `createSessionForWorkflow` | `POST /sessions/for-workflow` | `session:create`; creates an ordinary coordinating session with a visible package definition attached |

Route evidence: `packages/sdk/api/src/protocol.js:68-78`. Adapter evidence: `packages/app/web/runtime.js:817-896`, `:1122-1135`; `packages/sdk/src/management-client.ts:2274-2335`. A direct management client is a trusted host API, not a replacement for the portal's authentication boundary (`packages/sdk/src/workflow/human-commands.ts:19-24`).

The portal enforces the new Workflow read/manage methods even when the older ownership-enforcement switch is off. Manage means the owner or an administrator permitted by the configured admin scope. The actor comes from the authenticated principal, not from command JSON. A share that grants read access does not expose YAML, literal schema values, detailed author diagnostics or owner-only base-instruction artifacts. See `packages/app/web/runtime.js:123-134`, `:411-462`, `:817-896`.

`startSessionWorkflowDefinition` accepts revision, `runAgainOf`, inputs, variables, notification preference, operation ID and optional per-node model choices. It checks those choices against the Workflow's effective spending owner. An explicit empty model map clears inherited Run-again choices. A changed model permission can prevent a new start, but a repeat of an already-admitted operation returns its original receipt. See `packages/sdk/src/workflow/session-definitions.ts:87-119`, `:324-386`; `packages/sdk/src/workflow/service.ts:365-414`.

## MCP surface

`packages/app/mcp/src/tools/workflows.ts:23-113` registers two Workflow tools:

| MCP tool | Calls | Important difference from the internal agent tool |
|---|---|---|
| `read_workflow` | `ctx.mgmt.readWorkflow` | Person-mode read; supports run, cursor, execution, KV, agent-version, definition-revision and step-input selectors |
| `update_workflow` | `ctx.mgmt.updateWorkflow` | Person-mode command; only registered when commands are enabled; no recover operation; originating session comes from server context first |

There is no dedicated MCP `workflow_definition` save/start/list tool in this module. The reusable-definition RPC/HTTP methods exist, but this MCP wrapper exposes the low-level Workflow read/command surface. Do not assume parity merely because similarly named internal agent tools exist.

Test-mode operations are omitted from MCP descriptions and refused as unknown when the deployment flag is off. Person-mode adapters reject an agent actor and restrict a Workflow in an agent subtree to pause, stop and cancel. See `packages/app/mcp/src/tools/workflows.ts:24-26`, `:74-110` and `packages/sdk/src/workflow/human-commands.ts:27-54`, `:217-225`.

## Authority and data validation

| Boundary | Enforcement |
|---|---|
| Typed input | Trusted parent must match both session row and definition. Other senders require equal non-blank owner provider/subject and neither session may be system-owned. Unknown or partial ownership grants nothing. |
| Request response | Only the frozen responder. A deleted requesting Workflow permits historical read/replay decisions only; it cannot accept a new answer. |
| Human input to agent steps | Deny prompt, answer, steer, custom event, canvas write/action, workspace command and definition mutation throughout the step's subtree. Read access and authorized brakes remain. |
| Script tools | Host-captured grant; same tool aliases and schema hash; filtered control/admin/model/task/scheduling tools; argument guard rejects forbidden forms such as detached shell work. |
| Agent tool limit | `tools: none` or an explicit list limits native, SDK and MCP surfaces and descendants; own completion tool remains. |
| Schema | Strict JSON Schema validation with local named references. Reject regex-based pattern features and unsafe expansion shapes; cap schema expansion. Validation does not coerce output into a valid answer. |
| Bindings | Whole-value expressions from inputs, input, kv, runtime and branch; optional JSON default. No arbitrary expression execution. |
| Errors | Sanitize runtime errors and previews. Business data is still data supplied by the author or a tool; the system is not a universal secret detector. |

Evidence: `packages/sdk/src/workflow/authority.ts:4-104`; `packages/sdk/src/workflow/input-policy.ts:1-29`, `:109-145`; `packages/sdk/src/workflow/tool-policy.ts:18-30`, `:71-190`; `packages/sdk/src/session-manager.ts:425-439`, `:2942-2977`; `packages/sdk/src/workflow/schema.ts:234-299`, `:425-447`; `packages/sdk/src/workflow/bindings.ts:1-18`, `:106-170`, `:217`; `packages/sdk/src/workflow/store.ts:1800-1806`.

## Package interfaces and admission

Later in this PR (`e27de05f`), any session may start any package Workflow Definition its owner can see, as the portal's new-session picker shows them: a shared package's to everyone, a user's own package's only to that user; one the owner cannot see is refused (`PACKAGE_WORKFLOW_NOT_FOUND`). At the source pin a session could start only those its agent's `workflows:` named or its coordinating session was made for (`PACKAGE_WORKFLOW_NOT_ALLOWED`, now retired); an agent's `workflows:` now only suggests them, first in `list`. A package Workflow Definition is attached under `<package>/<name>` and locked. A newer package version creates a new attached revision for future Workflows; it does not rewrite running copies. A person can make an editable copy. An agent step cannot use an agent that itself brings Workflow definitions. See `packages/sdk/src/workflow/session-definitions.ts:16-23`, `:465-690` and `packages/sdk/src/workflow/service.ts:154-184`.

A packaged agent can export `workflowInterface` in agent schema version 5. The package validator reads bounded schema files from inside the package, rejects outside/symlink/remote references and publishes the schemas, outcomes and digest. Publication requires exact interface name/version, outcome set and schema match; it does not infer safe schema subtyping. See `packages/sdk/src/workflow/package-interface.ts:9-44`, `:112-165`, `:191-219`.

These checks validate shape and visibility. They do not constitute host-owned admission of package code or MCP endpoints. Pinned older packages can still load worker modules. That separate security gap is in [Known issues](known-issues.md#package-admission).

## Portal and terminal presentation

The current portal keeps the owner session's conversation and shows a Workflow tab beside Canvas. Definition view provides revisions, YAML/graph and start controls. Workflows view provides numbered executions, graph, node details, log and variables. Selecting an agent step opens its real session read-only. The terminal projects the same underlying data but does not have the portal's graphical side tab. See `packages/app/ui/core/src/workflow-owner.js:1-29`, `packages/app/ui/core/src/workflow-session-definitions.js:1-12`, and the [developer guide](../../developer/building/workflow-sessions.md#sessions-own-their-workflows-stage-1).

| Core module (`packages/app/ui/core/src/`) | Responsibility |
|---|---|
| `workflow-owner.js:1` | Owner/Workflow selection, numbered children, side-tab context and panel layout |
| `workflow-session-definitions.js:1` | Definition/revision views, package provenance, guarded editor state, start/delete choices |
| `workflow-view.js:1` | Read-model normalization, selected run/execution, paging, joins, replay timeline and detail projections |
| `workflow-commands.js:6` | Command controls/wire shapes, revision guards, variable drafts, confirmations, tests and input forms |
| `workflow-sessions.js:1` | Workflow identification and event-to-transcript wording |
| `workflow-progress.js:13` | Collapse repeated progress into rows scoped to the same run and branch |
| `workflow-run-picker.js:1` | Select a live or test run without mixing their details |
| `workflow-node-summary.js:1` | Explain one node's task, current state, visits, result and next routes |
| `workflow-node-code.js:1` | Authorized source/schema display and clearly labelled samples |
| `workflow-agent-log.js:1` | Group agent prompt, result and session log by visit; protect base instructions |
| `workflow-graph-layout.js:1` | Dagre graph placement, named-branch lanes, join bars and edge geometry |
| `workflow-layouts.js:1` | Persist bounded user-specific graph positions |
| `workflow-transitions.js:1` | Highlight the latest four transitions; repeat traversals get a stronger mark |
| `workflow-lifecycle.js:1` | Auto-open once, then attention marker on meaningful lifecycle changes; bounded background reads |
| `workflow-words.js:1` | Shared state/outcome/duration/time/model wording |
| `workflow-error-words.js:1` | Short readable error headlines with separate detail |
| `workflow-tui.js:1` | Terminal projections, controls and input-policy messages |
| `themes/workflow-colors.js:1` | Theme-dependent graph colors and contrast |

The read model separates newest paged rows from still-open rows, even if those open rows are older. A caller can fetch older pages or one whole result rather than treating a clipped preview as the full value. Read errors and stale editor responses must not overwrite another definition's draft. See `packages/app/mcp/src/tools/workflows.ts:31-52`, `packages/app/ui/core/src/workflow-view.js:377-450`, `packages/app/ui/core/src/workflow-session-definitions.js:291-398`.

Test mode and scripts are independent deployment choices. `PILOTSWARM_WORKFLOW_TEST_MODE=on` exposes low-level test controls; other values keep them hidden. Script nodes default on, with `0`, `false`, `no` or `off` as opt-out values. A definition-only test remains a separate agent facility. See `packages/sdk/src/workflow/test-mode-switch.ts:1-36`, `packages/sdk/src/workflow/scripts-gate.ts:20-43`, `packages/sdk/src/workflow/definition-tool.ts:38-57`.
