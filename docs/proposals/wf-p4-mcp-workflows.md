# Workflows Over MCP — Picker, Skills, Session Kind, Definition Lifecycle & Validate

**Date:** 2026-11-27
**Status:** Proposed (built ahead of owner design sign-off)
**Target Repository:** `microsoft/PilotSwarm`

---

## Core Model & Glossary

| Term | Exact Meaning |
|---|---|
| **External MCP caller** | An LLM or tool host outside PilotSwarm (Claude Desktop, GitHub Copilot CLI, Claude Code, Cursor, or an MCP SDK client) connected only to `pilotswarm-mcp` (`packages/app/mcp`) over `stdio` or streamable `http`. |
| **MCP server credential** | The single outbound identity held by one `pilotswarm-mcp` process: in **web mode** (`--api-url`), the signed-in user or service token; in **direct mode** (`--store`), the trusted datastore process (`admin: true`, stamping `{ kind: "system", name: "management-client" }` when no `principal` is supplied). |
| **Owner session (`owner_session_id`)** | A live, non-Workflow PilotSwarm session (`sessionKind === "agent"`) that owns session-scoped Workflow Definitions (`workflow_session_definitions`). Created via `create_session` (custom definitions) or `create_session_for_workflow` (packaged `<package>/<name>` Workflow). |
| **Coordinating session** | An ordinary agent session created for a package Workflow `<package>/<name>` (`createSessionForWorkflow`): carries coordinating system instructions derived from the package card + static effect facts, has `<package>/<name>` attached and locked at the exact prepared `(packageId, sha256)` version, sets `workflowRef` and title `<name> · <package>`, and queues a bootstrap kickoff message. |
| **Originating session (`originating_session_id`)** | Optional session ID when an MCP call is proxied on behalf of a PilotSwarm session (`PILOTSWARM_ORIGINATING_SESSION_ID` env var on the MCP server always overrides any caller-supplied `originating_session_id` argument). When that session's stored lineage is inside a Workflow (`sessionInsideWorkflow === true`), all definition-changing/starting operations — and `create_session_for_workflow` *(proposed; owner to confirm)* — are refused with `403 WORKFLOW_DEFINITION_TOOLS_REFUSED` (SF-2). |
| **No-write validation (`validate`)** | Pure structural + host-capability compilation of a Workflow YAML string (`<= 256 KiB`) returning `{ valid, name, errors, warnings, graph, inputsSchema }` without reading or mutating any session or database row. |
| **Person-start tool-binding limit** | A Workflow started by a person (via Web API, TUI, or MCP `workflow_definition` `start`) has `binding = null` because no parent agent turn captured a tool grant. Scripts with literal `callTool("<name>")` (other than built-in `child_workflows`) are refused at Start with `409 WORKFLOW_TOOLS_UNAVAILABLE`. A successful MCP `start` appends warning `WORKFLOW_PERSON_START_NO_TOOL_BINDING` iff the started revision has a `script` state. |

---

## 1. Intent & Scope

Previously, `packages/app/mcp` exposed only `read_workflow` and `update_workflow`, leaving external MCP clients unable to discover or start packaged Workflows, read the deployment's Workflow authoring skills, distinguish Workflow sessions in `list_sessions`, validate YAML without writing a revision, or manage session Workflow Definitions.

This change adds complete Workflows-over-MCP parity across direct and Web API modes with **zero SQL migrations**, **zero session orchestration or Workflow controller version bumps**, and **zero edits to `packages/sdk/plugins/workflow/skills/*/SKILL.md`**:

1. **Direct-mode `artifactStore` & `list_creatable_workflows`:** Direct mode (`packages/app/mcp/src/context.ts`) constructs an `artifactStore` identically to `NodeSdkTransport.createArtifactStore()` (Azure Blob Storage when configured, failing fast if misconfigured; otherwise `FilesystemArtifactStore`), and `list_creatable_workflows` wraps `ctx.mgmt.listCreatableWorkflows(null)`.
2. **SDK `createSessionForWorkflow` & MCP `create_session_for_workflow`:** Moves the 4-step coordinating-session chain (prepare -> createSession -> version-pinned attach with S2SF-F3 delete-on-failure -> bootstrap kickoff send) into `PilotSwarmManagementClient.createSessionForWorkflow` (keeping `principal` separate from `owner` so TUI/no-auth keeps `owner = null` when omitted) and adds the matching HTTP call on `WebPilotSwarmManagementClient`, removing `createSessionForWorkflow` from `NON_MANAGEMENT_OPERATION_OWNERS`.
3. **Workflow skills on request (`read_workflow_skill`):** Dynamically serves whatever Workflow skills the running deployment ships in `WORKFLOW_SKILLS_DIR` (+ `WORKFLOW_TEST_MODE_SKILLS_DIR` iff test mode is on) via `mgmt.readWorkflowSkills` and `GET /api/v1/workflow-definitions/skills`, with exact name lookup (never path joining) and a fixed MCP adaptation `note` *(proposed; owner to confirm)*.
4. **`list_sessions.session_kind`:** Projects `session_kind: s.sessionKind ?? "agent"` on every row of `list_sessions` (both unpaged and keyset-paginated).
5. **MCP `workflow_definition` (`validate | list | read | card | save | start | delete | copy`):**
   - Pure `validateWorkflowYaml` + `compileWorkflow` exported from `pilotswarm-sdk`, fronted by `mgmt.validateWorkflowDefinition` and `POST /api/v1/workflow-definitions/validate` (`access: "authed"`).
   - `readSessionWorkflowCard` (`GET /api/v1/sessions/:sessionId/workflow-definitions/card`, `access: "session:manage"`, enforced in `ENFORCED_NEW_METHODS`) using the owning session's owner as package viewer.
   - Name-or-ID lookup with receipt-first `operation_id` replay safety on `start`, `delete` (sharing `resolveDeleteTarget` with the session `workflow_definition` tool's `delete` operation), `copy`, and `updateSessionWorkflowPackage`.
   - `operation_id` required on `save`, `delete`, `copy`, and unkeyed `start` (optional on keyed `start`, passing `key:<key>`). Never synthesizes random UUIDs.
   - `start { update: true }` updates an already-attached locked package definition first (`${opId}:update`) and pins `receipt.revision` when `revision` is omitted.
   - Conditional `WORKFLOW_PERSON_START_NO_TOOL_BINDING` warning appended to MCP `start` receipts iff the started revision has a `script` state.
   - SF-2 (`403 WORKFLOW_DEFINITION_TOOLS_REFUSED`) enforced across `save`, `start`, `delete`, `copy`, `updateSessionWorkflowPackage`, and `create_session_for_workflow` *(proposed; owner to confirm)* when `ctx.originatingSessionId ?? originating_session_id` is inside a Workflow.
   - Approval consent (`approval_respond`) remains refused over MCP (`403 FORBIDDEN`) — portal-only.
6. **Older-portal version skew *(proposed; owner to confirm)*:** `workflowCapabilities()` adds additive `validate: true`, `skills: true`, `card: options.read === true`; MCP web mode reflects the `/api/v1/bootstrap` advert in `buildCapabilities().workflow_tools`; calls to `readWorkflowSkills`, `validateWorkflowDefinition`, or `readSessionWorkflowCard` hitting a missing route on an older portal return `501 WORKFLOW_API_UNAVAILABLE`.

---

## 2. Proposed Items Pending Owner Confirmation

Three small additions are isolated in separate `proposed:` commits so any one can be dropped cleanly if the owner declines:

1. **In-Workflow `create_session_for_workflow` refusal & hiding:** Refuses `create_session_for_workflow` (`403 WORKFLOW_DEFINITION_TOOLS_REFUSED`) when `originatingSessionId` is inside a Workflow and adds MCP-only `WORKFLOW_DEFINITION_MCP_TOOLS` in `input-policy.ts`. (Known limit: `create_session` + `send_message` remains outside SF-2.)
2. **Fixed MCP adaptation `note` on `read_workflow_skill { name }` responses:** Maps `load_skill` to `read_workflow_skill` and lists agent-only Workflow operations without modifying any `SKILL.md`.
3. **Newer MCP against older portal:** Additive `validate`/`skills`/`card` booleans in `workflowCapabilities()`, web-mode advert reflection in `workflow_tools`, and `501 WORKFLOW_API_UNAVAILABLE` translation for missing routes.

---

## 3. Non-Goals

- Push notifications, `wait_workflow`, or `pilotswarm://workflows/{id}` resources.
- Answering `type: approval` steps over MCP (remains portal-only).
- Person/MCP definition `test` with fixtures, external `send_workflow_input`, admin `recover` over MCP, or per-run prune.
- SQL migrations or orchestration/controller version bumps.
