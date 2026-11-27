import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileWorkflow, workflowScriptNodes, workflowTestModeFromEnv } from "pilotswarm-sdk";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { cacheSessionHandle } from "./sessions.js";
import { jsonResult, errorResult, withToolErrors, type ToolResult } from "../util/respond.js";

const WORKFLOW_SKILL_MCP_NOTE =
    "This skill is written for agents inside a PilotSwarm session. Over MCP: load_skill(name) is read_workflow_skill { name }; "
    + "definitions are workflow_definition with your own operation_id; runs are read_workflow / update_workflow (pause, resume, stop, cancel, set_vars); "
    + "test, recover, send_workflow_input, respond_session_request and child_workflows are not available, and nothing notifies you: poll read_workflow.";

const PERSON_START_TOOL_BINDING_WARNING = {
    code: "WORKFLOW_PERSON_START_NO_TOOL_BINDING",
    path: "$",
    message:
        "A Workflow started by a person has no captured tool grant from owner_session_id: a dynamic callTool name in a script state "
        + "finds no permitted tool except child_workflows (literal callTool requirements are refused at Start with 409 WORKFLOW_TOOLS_UNAVAILABLE). "
        + "To grant session tools to scripts, have the session's agent start the definition.",
};

function graphHasScriptState(states: unknown): boolean {
    if (!Array.isArray(states)) return false;
    for (const s of states) {
        if (!s || typeof s !== "object") continue;
        const st = s as Record<string, unknown>;
        if (st.type === "script") return true;
        if (graphHasScriptState(st.states) || graphHasScriptState((st.body as Record<string, unknown> | undefined)?.states)) return true;
        if (Array.isArray(st.branches) && st.branches.some(b => graphHasScriptState((b as Record<string, unknown> | undefined)?.states))) return true;
    }
    return false;
}

async function startedRevisionHasScriptState(ctx: ServerContext, ownerSessionId: string, definitionId: unknown, revision: unknown): Promise<boolean> {
    if (typeof definitionId !== "string" || !definitionId) return false;
    if (typeof ctx.mgmt.readSessionWorkflowDefinition !== "function") return false;
    try {
        const read: any = await ctx.mgmt.readSessionWorkflowDefinition(ownerSessionId, {
            definitionId,
            ...(typeof revision === "number" && Number.isInteger(revision) ? { revision } : {}),
        });
        if (typeof read?.revision?.yaml === "string") {
            const compiled = compileWorkflow(read.revision.yaml);
            if (compiled.ir) return workflowScriptNodes(compiled.ir).length > 0;
        }
        return graphHasScriptState(read?.graph?.states);
    } catch {
        return false;
    }
}

/**
 * Workflow over MCP (design 04 REST/SDK/MCP mapping; Phase 4 Unit G):
 *
 * Always registered:
 *   read_workflow                the read-only view of a workflow session
 *   list_creatable_workflows     packaged <package>/<name> Workflows visible to this caller
 *   create_session_for_workflow  create a coordinating session for a packaged Workflow
 *   read_workflow_skill          list or read the deployment's packaged Workflow authoring skills
 *
 * Registered when ctx.workflowCommands === true (every production server; false only in tests passing workflowCommands: null):
 *   update_workflow              person command to one running Workflow session (approval_respond refused 403)
 *   workflow_definition          list | read | save | start | delete | copy | card | validate
 */
export function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
    // Workflow test mode is hidden unless this process's deployment flag is on (spec 16): off, neither tool names it, and the
    // read shows no test run (review SF-5).
    const testMode = ctx.workflowTestMode ?? workflowTestModeFromEnv();
    server.registerTool(
        "read_workflow",
        {
            title: "Read Workflow",
            description:
                "Read a Workflow without changing it, as a person: its definition (state, current revision, "
                + "diagnostics), graph and runs, and one run (run_id, default the live run). Each section of the run holds its newest rows, "
                + "oldest first; rows still open are listed apart, however old (openExecutions, openInbox, openOutbox"
                + `${testMode ? ", run.test.openInterceptions" : ""}). run.pages gives each section's nextCursor: give it back as cursor (a JSON object; limit may `
                + "go with it) for that section's next, older page; null means none is older. execution_id, kv_revision, agent_versions, "
                + "definition_revision and step_input are separate reads: each argument says what it returns. Refusals carry their code: "
                + "WORKFLOW_NOT_FOUND, RUN_NOT_FOUND, EXECUTION_NOT_FOUND, KV_REVISION_NOT_FOUND, DEFINITION_REVISION_NOT_FOUND, WORKFLOW_CURSOR_INVALID, WORKFLOW_READ_INVALID, "
                + "and WORKFLOW_STORE_UNAVAILABLE (with its reason) when the store cannot be reached or has no room now.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to read"),
                run_id: z.string().optional().describe("A run of the workflow; default the live run"),
                cursor: z.record(z.string(), z.unknown()).optional()
                    .describe("A nextCursor from run.pages (or from a page), given back as it was: that section's next, older page"),
                execution_id: z.string().optional().describe("With run_id, not with cursor: one step execution's whole input and whole output or error instead of their previews"),
                limit: z.number().int().optional().describe("Rows per page of each section, 1 to 200"),
                kv_revision: z.number().int().optional().describe("A revision of the run's variables, 1 to its kvRevision, each with its size and sha256"),
                kv_key: z.string().optional().describe("With kv_revision: one variable of that revision, whole"),
                agent_versions: z.boolean().optional().describe("true, alone: the agent versions publishing the current revision would lock now; it locks nothing"),
                definition_revision: z.number().int().optional().describe("Alone: a revision of the definition, 1 to the current one: its YAML as saved and formatted"),
                step_input: z.record(z.string(), z.unknown()).optional()
                    .describe("{ state, input? }, alone: an agent step's input fields in the current draft; with input, the YAML that mapping proposes"),
            },
        },
        withToolErrors(async ({ session_id, run_id, cursor, execution_id, limit, kv_revision, kv_key, agent_versions, definition_revision, step_input }) => {
            try {
                return jsonResult(await ctx.mgmt.readWorkflow(session_id, {
                    ...(run_id !== undefined ? { runId: run_id } : {}),
                    ...(cursor !== undefined ? { cursor } : {}),
                    ...(execution_id !== undefined ? { executionId: execution_id } : {}),
                    ...(limit !== undefined ? { limit } : {}),
                    ...(kv_revision !== undefined ? { kvRevision: kv_revision } : {}),
                    ...(kv_key !== undefined ? { kvKey: kv_key } : {}),
                    ...(agent_versions !== undefined ? { agentVersions: agent_versions } : {}),
                    ...(definition_revision !== undefined ? { definitionRevision: definition_revision } : {}),
                    ...(step_input !== undefined ? { stepInput: step_input } : {}),
                }));
            } catch (err: unknown) {
                return refusal(err, session_id);
            }
        }),
    );

    server.registerTool(
        "list_creatable_workflows",
        {
            title: "List Creatable Workflows",
            description:
                "List packaged Workflow Definitions (<package>/<name>) available to start on this deployment, with each package's "
                + "version, description, inputs, outcomes, and checked effect facts. Use create_session_for_workflow with a returned ref "
                + "to start a coordinating session for one.",
            inputSchema: {},
        },
        withToolErrors(async () => {
            try {
                const items = await ctx.mgmt.listCreatableWorkflows(null);
                return jsonResult({ count: items.length, workflows: items });
            } catch (err: unknown) {
                return refusal(err);
            }
        }),
    );

    server.registerTool(
        "create_session_for_workflow",
        {
            title: "Create Session For Workflow",
            description:
                "Create a coordinating agent session for a packaged Workflow Definition '<package>/<name>' from list_creatable_workflows. "
                + "Attaches the exact prepared package version, sets the session title, and sends a bootstrap kickoff message. "
                + "Non-idempotent: calling twice creates two sessions.",
            inputSchema: {
                ref: z.string().min(1).describe("Package Workflow reference '<package>/<name>' from list_creatable_workflows"),
                model: z.string().optional().describe("Optional qualified provider:model override for the coordinating session"),
                reasoning_effort: z.string().optional().describe("Optional reasoning effort (low, medium, high, xhigh, max)"),
                context_tier: z.enum(["default", "long_context"]).optional().describe("Optional context-window tier"),
                group_id: z.string().optional().describe("Optional viewer session group ID to place the created session into"),
                originating_session_id: z.string().optional()
                    .describe("When proxied for an agent session, that session's ID; refused inside a Workflow (403 WORKFLOW_DEFINITION_TOOLS_REFUSED)"),
            },
        },
        withToolErrors(async ({ ref, model, reasoning_effort, context_tier, group_id, originating_session_id }) => {
            try {
                const originatingSessionId = ctx.originatingSessionId ?? originating_session_id;
                const created = await ctx.mgmt.createSessionForWorkflow(ref, {
                    ...(model !== undefined ? { model } : {}),
                    ...(reasoning_effort !== undefined ? { reasoningEffort: reasoning_effort } : {}),
                    ...(context_tier !== undefined ? { contextTier: context_tier } : {}),
                    ...(group_id !== undefined ? { groupId: group_id } : {}),
                    ...(originatingSessionId !== undefined ? { originatingSessionId } : {}),
                    ...(!ctx.webMode ? { client: ctx.client, onSession: (s) => cacheSessionHandle(s) } : {}),
                });
                return jsonResult({
                    session_id: created.sessionId,
                    workflow_ref: created.workflowRef,
                    title: created.title,
                    model: created.model ?? "default",
                    ...(created.reasoningEffort ? { reasoning_effort: created.reasoningEffort } : {}),
                    status: "created",
                    kickoff_sent: true,
                });
            } catch (err: unknown) {
                return refusal(err);
            }
        }),
    );

    server.registerTool(
        "read_workflow_skill",
        {
            title: "Read Workflow Skill",
            description:
                "Read Workflow authoring skills packaged with this deployment. Omit name to list all available Workflow skills; "
                + "pass name (start with 'workflow-authoring') to read that skill's full Markdown guide before authoring or saving a Workflow.",
            inputSchema: {
                name: z.string().min(1).max(128).optional().describe(
                    "Workflow skill name (e.g. 'workflow-authoring', 'workflow-reference', 'workflow-tools', 'workflow-patterns', "
                    + "'workflow-decision', 'workflow-carry', 'workflow-polling', 'workflow-schedules', 'workflow-approval', 'workflow-long-agent'). "
                    + "Omit to list all Workflow skills packaged with this deployment.",
                ),
            },
        },
        withToolErrors(async ({ name }) => {
            try {
                if (name === undefined) {
                    const listed: any = await ctx.mgmt.readWorkflowSkills();
                    const skills = Array.isArray(listed?.skills) ? listed.skills : [];
                    return jsonResult({ count: skills.length, skills });
                }
                const skill: any = await ctx.mgmt.readWorkflowSkills({ name });
                return jsonResult({
                    name: skill.name,
                    description: skill.description,
                    content: skill.content,
                    note: WORKFLOW_SKILL_MCP_NOTE,
                });
            } catch (err: unknown) {
                return refusal(err, undefined, "readWorkflowSkills");
            }
        }),
    );

    if (ctx.workflowCommands !== true) return;

    // Off, update_workflow names stop and no test operation; with test mode on, the test operations too.
    const operations = testMode
        ? "operation (replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel, stop, test, test_respond "
            + "and test_advance), operation_id (repeat it to retry the same command) and the operation's arguments (expected_revision, "
            + "definition_hash, yaml, inputs, vars, notify_on_completion, set, delete, expected_kv_revision, run_id, reason, grace_seconds, "
            + "agent_mode, fixtures, scenario, interception_id, response, seconds). "
        : "operation (replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel and stop), operation_id "
            + "(repeat it to retry the same command) and the operation's arguments (expected_revision, definition_hash, yaml, inputs, "
            + "vars, notify_on_completion, set, delete, expected_kv_revision, run_id, reason, grace_seconds). ";
    server.registerTool(
        "update_workflow",
        {
            title: "Update Workflow",
            description:
                "Send one command to a Workflow, as a person. command is the update_workflow agent tool's command: "
                + operations
                + "A live start (publish_and_start, start) tells the workflow's parent agent the result when the run ends unless "
                + "notify_on_completion is false. Answers the command's receipt. "
                + "A workflow started under another workflow's agent step takes only pause, stop and cancel; read a workflow with read_workflow "
                + "first.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to command"),
                command: z.record(z.string(), z.unknown()).describe("The command: { operation, operation_id, ...its arguments }"),
                originating_session_id: z.string().optional()
                    .describe("The session this command comes from, when an agent's call is passed on; a session inside a Workflow cannot change definitions"),
            },
        },
        withToolErrors(async ({ session_id, command, originating_session_id }) => {
            try {
                if (command.operation === "approval_respond") {
                    return errorResult("A person must read and answer this approval directly in the portal. MCP cannot give consent.",
                        { code: "FORBIDDEN", status: 403, session_id });
                }
                // The session this server acts for, when it was started for one, wins over the argument (review SF-2).
                const originatingSessionId = ctx.originatingSessionId ?? originating_session_id;
                return jsonResult(await ctx.mgmt.updateWorkflow(session_id, command,
                    ...(originatingSessionId !== undefined ? [{ originatingSessionId }] : [])));
            } catch (err: unknown) {
                return refusal(err, session_id);
            }
        }),
    );

    server.registerTool(
        "workflow_definition",
        {
            title: "Workflow Definition",
            description:
                "Validate, list, read, inspect cards, save, start, delete, or copy session-scoped Workflow Definitions as a person. "
                + "Use operation 'validate' (no owner_session_id needed) to compile and check YAML without writing a revision. "
                + "All other operations act on owner_session_id (create a top-level session with create_session). "
                + "Pass key (preferred) or operation_id on start; pass a fresh operation_id on save, delete, and copy (reuse unchanged only to retry). "
                + "On a fresh 0-turn owner_session_id, pass workspace: 'none' on start (or send one turn first to capture default folders).",
            inputSchema: {
                operation: z.enum(["list", "read", "save", "start", "delete", "copy", "card", "validate"])
                    .describe("Operation to run: validate needs only yaml; all other operations act on owner_session_id"),
                owner_session_id: sessionIdShape().optional()
                    .describe("Live non-Workflow session that owns the definitions (create one with create_session). Required except for validate"),
                name: z.string().optional()
                    .describe("Definition metadata.name, or '<package>/<name>' for card (and for copy/start when already attached to owner_session_id)"),
                definition_id: z.string().optional()
                    .describe("Definition ID returned by list/read/save"),
                revision: z.number().int().positive().optional()
                    .describe("Revision number (read: default newest; start: default newest valid; copy: default newest)"),
                expected_revision: z.number().int().positive().optional()
                    .describe("save over an existing definition: the current revision you read (omit on first save of a new name)"),
                yaml: z.string().max(262144).optional()
                    .describe("Workflow YAML (apiVersion: pilotswarm.dev/v1, <= 256 KiB) for validate or save"),
                inputs: z.record(z.string(), z.unknown()).optional()
                    .describe("start: Workflow run inputs matching inputs.schema"),
                vars: z.record(z.string(), z.unknown()).optional()
                    .describe("start: initial run variables"),
                run_again_of: z.string().optional()
                    .describe("start: prior Workflow session ID of this definition whose pinned revision and model choices to repeat"),
                notify_on_completion: z.boolean().optional()
                    .describe("start: notify owner_session_id when the Workflow ends (default true)"),
                workspace: z.union([z.record(z.string(), z.unknown()), z.null(), z.literal("none")]).optional()
                    .describe("start: omit to inherit owner_session_id's workspace and defaults (requires >=1 turn in owner_session_id); pass 'none' on a fresh 0-turn session or when no folders are needed"),
                agent_models: z.record(z.string(), z.unknown()).optional()
                    .describe("start: map of agent state id -> { model: 'provider:model', reasoningEffort?, contextTier? }"),
                decision_models: z.record(z.string(), z.unknown()).optional()
                    .describe("start: map of decision state id -> { model: 'provider:model' }"),
                update: z.boolean().optional()
                    .describe("start: when starting a '<package>/<name>' definition already attached to owner_session_id, update to the package's newer active version first"),
                key: z.string().min(1).max(128).optional()
                    .describe("start (preferred): exact session-scoped idempotency key; reuse unchanged on retry, use a new key for another run"),
                include_deleted: z.boolean().optional()
                    .describe("list: include deleted definitions (default false)"),
                operation_id: z.string().min(1).max(256).optional()
                    .describe("Required on save, delete, copy, and unkeyed start (optional when start passes key): choose a new id per change and reuse unchanged only to retry the same call"),
                originating_session_id: z.string().optional()
                    .describe("When proxied for an agent session, that session's ID; definition operations from inside a Workflow are refused (403 WORKFLOW_DEFINITION_TOOLS_REFUSED)"),
            },
        },
        withToolErrors(async (args) => {
            const {
                operation,
                owner_session_id,
                name,
                definition_id,
                revision,
                expected_revision,
                yaml,
                inputs,
                vars,
                run_again_of,
                notify_on_completion,
                workspace,
                agent_models,
                decision_models,
                update,
                key,
                include_deleted,
                operation_id,
                originating_session_id,
            } = args;

            if (operation === "validate") {
                if (typeof yaml !== "string") {
                    return errorResult("yaml is required for validate.", { code: "WORKFLOW_COMMAND_INVALID", status: 400 });
                }
                try {
                    const result = await ctx.mgmt.validateWorkflowDefinition(yaml);
                    return jsonResult({ operation: "validate", ...result });
                } catch (err: unknown) {
                    return refusal(err, undefined, "validateWorkflowDefinition");
                }
            }

            if (!owner_session_id) {
                return errorResult(`owner_session_id is required for ${operation}.`, { code: "WORKFLOW_COMMAND_INVALID", status: 400 });
            }

            const originatingSessionId = ctx.originatingSessionId ?? originating_session_id;
            const mutOpts = originatingSessionId !== undefined ? { originatingSessionId } : {};

            try {
                if (operation === "list") {
                    const definitions = await ctx.mgmt.listSessionWorkflowDefinitions(owner_session_id, {
                        ...(include_deleted !== undefined ? { includeDeleted: include_deleted } : {}),
                    });
                    return jsonResult({ operation: "list", owner_session_id, definitions });
                }

                if (operation === "read") {
                    if (!definition_id && !name) {
                        return errorResult("read needs name or definition_id.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                    }
                    const read = await ctx.mgmt.readSessionWorkflowDefinition(owner_session_id, {
                        ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                        ...(name !== undefined ? { name } : {}),
                        ...(revision !== undefined ? { revision } : {}),
                    });
                    return jsonResult({ operation: "read", owner_session_id, ...read });
                }

                if (operation === "card") {
                    if (!name) {
                        return errorResult("card needs name: <package>/<name>.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                    }
                    try {
                        const card = await ctx.mgmt.readSessionWorkflowCard(owner_session_id, { name });
                        return jsonResult({ operation: "card", owner_session_id, ...card });
                    } catch (err: unknown) {
                        return refusal(err, owner_session_id, "readSessionWorkflowCard");
                    }
                }

                if (operation === "save") {
                    if (!operation_id) {
                        return errorResult(
                            "operation_id is required for save: choose a new id for this change and reuse it unchanged only to retry this same call.",
                            { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                        );
                    }
                    if (!name || typeof yaml !== "string") {
                        return errorResult("save needs name and yaml.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                    }
                    const receipt = await ctx.mgmt.saveSessionWorkflowDefinition(
                        owner_session_id,
                        {
                            name,
                            yaml,
                            ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                            ...(expected_revision !== undefined ? { expectedRevision: expected_revision } : {}),
                            operationId: operation_id,
                        },
                        mutOpts,
                    );
                    return jsonResult({ ...receipt, operation: "save" });
                }

                if (operation === "delete") {
                    if (!operation_id) {
                        return errorResult(
                            "operation_id is required for delete: choose a new id for this change and reuse it unchanged only to retry this same call.",
                            { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                        );
                    }
                    if (!definition_id && !name) {
                        return errorResult("delete needs name or definition_id.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                    }
                    const receipt = await ctx.mgmt.deleteSessionWorkflowDefinition(
                        owner_session_id,
                        {
                            ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                            ...(name !== undefined ? { name } : {}),
                            operationId: operation_id,
                        },
                        mutOpts,
                    );
                    return jsonResult({ ...receipt, operation: "delete" });
                }

                if (operation === "copy") {
                    if (!operation_id) {
                        return errorResult(
                            "operation_id is required for copy: choose a new id for this change and reuse it unchanged only to retry this same call.",
                            { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                        );
                    }
                    if (!definition_id && !name) {
                        return errorResult("copy needs name or definition_id.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                    }
                    const receipt = await ctx.mgmt.copySessionWorkflowDefinition(
                        owner_session_id,
                        {
                            ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                            ...(name !== undefined ? { name } : {}),
                            ...(revision !== undefined ? { revision } : {}),
                            operationId: operation_id,
                        },
                        mutOpts,
                    );
                    return jsonResult({ ...receipt, operation: "copy" });
                }

                // operation === "start"
                if (!operation_id && !key) {
                    return errorResult(
                        "operation_id is required for start: choose a new id for this change and reuse it unchanged only to retry this same call.",
                        { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                    );
                }
                if (!definition_id && !name) {
                    return errorResult("start needs name or definition_id.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                }

                const opId = operation_id ?? `key:${key}`;
                let startRevision = revision;

                if (update === true) {
                    let target: any = null;
                    try {
                        target = await ctx.mgmt.readSessionWorkflowDefinition(owner_session_id, {
                            ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                            ...(name !== undefined ? { name } : {}),
                        });
                    } catch (err: any) {
                        if (err?.code === "DEFINITION_NOT_FOUND") {
                            return errorResult(
                                "update applies to a package definition attached to this session; make one with create_session_for_workflow",
                                { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                            );
                        }
                        throw err;
                    }
                    if (!target?.locked) {
                        return errorResult(
                            "update applies to a package definition attached to this session; make one with create_session_for_workflow",
                            { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                        );
                    }
                    const updated: any = await ctx.mgmt.updateSessionWorkflowPackage(
                        owner_session_id,
                        {
                            ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                            ...(name !== undefined ? { name } : {}),
                            operationId: `${opId}:update`,
                        },
                        mutOpts,
                    );
                    if (startRevision === undefined && updated?.revision != null) {
                        startRevision = Number(updated.revision);
                    }
                }

                const started: any = await ctx.mgmt.startSessionWorkflowDefinition(
                    owner_session_id,
                    {
                        ...(definition_id !== undefined ? { definitionId: definition_id } : {}),
                        ...(name !== undefined ? { name } : {}),
                        ...(startRevision !== undefined ? { revision: startRevision } : {}),
                        ...(run_again_of !== undefined ? { runAgainOf: run_again_of } : {}),
                        ...(inputs !== undefined ? { inputs } : {}),
                        ...(vars !== undefined ? { vars } : {}),
                        ...(notify_on_completion !== undefined ? { notifyParent: notify_on_completion } : {}),
                        ...(workspace !== undefined ? { workspace: workspace as any } : {}),
                        ...(agent_models !== undefined ? { agentModels: agent_models } : {}),
                        ...(decision_models !== undefined ? { decisionModels: decision_models } : {}),
                        ...(key !== undefined ? { key } : {}),
                        operationId: opId,
                    },
                    mutOpts,
                );

                const hasScript = await startedRevisionHasScriptState(ctx, owner_session_id, started?.definitionId, started?.revision);
                const existingWarnings = Array.isArray(started?.warnings) ? started.warnings : [];
                const alreadyWarned = existingWarnings.some((w: any) => w?.code === PERSON_START_TOOL_BINDING_WARNING.code);
                const warnings = hasScript && !alreadyWarned
                    ? [...existingWarnings, PERSON_START_TOOL_BINDING_WARNING]
                    : existingWarnings;

                return jsonResult({
                    ...started,
                    operation: "start",
                    ...(warnings.length ? { warnings } : {}),
                });
            } catch (err: unknown) {
                return refusal(err, owner_session_id);
            }
        }),
    );
}

/**
 * A workflow refusal: every one with a code answers in one JSON shape, with its status and details; a bare 403 and an
 * error without a code keep the standard answer (rethrown to withToolErrors).
 */
function refusal(err: unknown, session_id?: string, olderPortalOp?: string): ToolResult {
    const failure = (err ?? {}) as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    const code = failure.code;
    if (
        olderPortalOp
        && failure.status === 404
        && code === "NOT_FOUND"
        && typeof failure.message === "string"
        && /^Unknown API route:/i.test(failure.message)
    ) {
        return errorResult(
            `This deployment is older than this MCP server and has no ${olderPortalOp}; upgrade the portal.`,
            {
                code: "WORKFLOW_API_UNAVAILABLE",
                status: 501,
                ...(session_id ? { session_id } : {}),
            },
        );
    }
    if (typeof code !== "string" || (failure.status === 403 && code === "FORBIDDEN")) throw err;
    return errorResult(typeof failure.message === "string" ? failure.message : String(err), {
        code,
        ...(session_id ? { session_id } : {}),
        ...(Number.isInteger(failure.status) ? { status: failure.status } : {}),
        ...(failure.details !== undefined && failure.details !== null ? { details: failure.details } : {}),
    });
}
