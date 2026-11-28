import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileWorkflow, scriptToolRequirements, workflowTestModeFromEnv } from "pilotswarm-sdk";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { cacheSessionHandle } from "./sessions.js";
import { jsonResult, errorResult, withToolErrors, type ToolResult } from "../util/respond.js";

const WORKFLOW_MCP_GAP_WORKAROUND =
    "Over MCP there is no test; workaround: ask the owner session to run it via send_and_wait. "
    + "To deliver typed input to a waiting receive step, call send_workflow_input directly.";

const WORKFLOW_SKILL_MCP_NOTE =
    "This skill is written for agents inside a PilotSwarm session. Over MCP: load_skill(name) is read_workflow_skill { name }; "
    + "definitions are workflow_definition with your own operation_id; runs are read_workflow / update_workflow (pause, resume, stop, cancel, set_vars) and send_workflow_input; "
    + "a re-run from a step (workflow-rerun) is workflow_definition start with rerun_from (omit inputs and workspace), and its plan is read_workflow rerun_plan; "
    + "over MCP a re-run never reuses an answered approval; "
    + "test, recover, respond_session_request and child_workflows are not available, and nothing notifies you: poll read_workflow. "
    + WORKFLOW_MCP_GAP_WORKAROUND;

const RERUN_FROM_KEYS = ["workflow_id", "execution_id", "mode", "result", "note"];
const RERUN_SUPPLY_NOTE_MAX_CHARS = 2000;
// Text PostgreSQL stores as given (the SDK's isStorableText): no NUL and no lone surrogate.
const UNSTORABLE_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RERUN_PLAN_KEYS = ["execution_id", "mode", "revision", "outcome"];
const READ_SELECTORS = ["run_id", "cursor", "execution_id", "limit", "kv_revision", "kv_key", "agent_versions", "definition_revision", "step_input"] as const;

const PERSON_START_TOOL_BINDING_WARNING = {
    severity: "warning" as const,
    code: "WORKFLOW_PERSON_START_NO_TOOL_BINDING",
    path: "$",
    message:
        "A Workflow started by a person has no captured tool grant from owner_session_id: a dynamic callTool name in a script state "
        + "finds no permitted tool except child_workflows (literal callTool requirements are refused at Start with 409 WORKFLOW_TOOLS_UNAVAILABLE). "
        + "To grant session tools to scripts, have the session's agent start the definition.",
};

function updateOperationIdFor(opId: string, key?: string): string {
    const candidate = key !== undefined ? `key:${key}:update` : `${opId}:update`;
    if (candidate.length <= 256) return candidate;
    return `update:${createHash("sha256").update(candidate).digest("hex")}`;
}

function isOlderPortalWithoutPhase4Definitions(ctx: ServerContext): boolean {
    if (!ctx.webMode) return false;
    if (!ctx.workflowsAdvert || typeof ctx.workflowsAdvert !== "object") return true;
    return !ctx.workflowsAdvert.validate || !ctx.workflowsAdvert.card;
}

function isOlderPortalWithoutWorkflowInput(ctx: ServerContext): boolean {
    if (!ctx.webMode) return false;
    if (!ctx.workflowsAdvert || typeof ctx.workflowsAdvert !== "object") return true;
    return ctx.workflowsAdvert.input !== true;
}

/**
 * Phase 3 I7 (M1): a web-mode portal that does not advertise workflows.rerun (or whose /bootstrap could not be read) predates
 * re-run from a step; it would ignore rerun_from and start from step 1, so rerun_from and rerun_plan fail closed.
 */
function rerunUnavailable(ctx: ServerContext, session_id: string): ToolResult | null {
    if (!ctx.webMode || ctx.workflowsAdvert?.rerun === true) return null;
    return errorResult(
        "This deployment is older than this MCP server and cannot re-run a Workflow from a step (workflows.rerun is not advertised); upgrade the portal.",
        { code: "WORKFLOW_API_UNAVAILABLE", status: 501, session_id },
    );
}

/**
 * Phase 3 I7: start's rerun_from as Start takes it (rerunFrom). A re-run takes its source's inputs and workspace and repeats no
 * other Workflow, so those arguments (and any other rerun_from field) are refused before anything is read or attached.
 */
function rerunFromArg(args: Record<string, unknown>)
    : { workflowId: string; executionId?: string; mode?: "run_again" | "continue" | "supply"; result?: unknown; note?: unknown } {
    const from = args.rerun_from;
    const refused = (message: string) => Object.assign(new Error(message), { code: "RERUN_ARGUMENT_REFUSED", status: 400 });
    if (!from || typeof from !== "object" || Array.isArray(from)) throw refused("rerun_from must be { workflow_id, execution_id?, mode?, result?, note? }.");
    const value = from as Record<string, unknown>;
    const extra = Object.keys(value).filter(key => !RERUN_FROM_KEYS.includes(key));
    if (extra.length) throw refused(`rerun_from takes ${RERUN_FROM_KEYS.join(", ")}; leave out ${extra.join(", ")}.`);
    if (typeof value.workflow_id !== "string" || !value.workflow_id.trim()) throw refused("rerun_from.workflow_id must name an ended Workflow.");
    // Review H3: a supplied result and note, checked as Start checks them (design §6.3), before update attaches anything.
    if (value.mode !== "supply" && (value.result != null || value.note != null)) {
        throw refused("rerun_from.result and rerun_from.note are only allowed when mode is 'supply'.");
    }
    if (value.mode === "supply") {
        const result = value.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) throw refused("mode 'supply' requires result: { outcome, output? }.");
        const extraResult = Object.keys(result).filter(key => key !== "outcome" && key !== "output");
        if (extraResult.length) throw refused(`rerun_from.result takes outcome and output; leave out ${extraResult.join(", ")}.`);
        const outcome = (result as Record<string, unknown>).outcome;
        if (typeof outcome !== "string" || !outcome.trim() || UNSTORABLE_TEXT.test(outcome)) {
            throw refused("rerun_from.result.outcome must be a non-empty string.");
        }
        const note = value.note;
        if (typeof note !== "string" || !note.trim() || UNSTORABLE_TEXT.test(note) || [...note].length > RERUN_SUPPLY_NOTE_MAX_CHARS) {
            throw refused(`mode 'supply' requires a non-blank note of at most ${RERUN_SUPPLY_NOTE_MAX_CHARS} characters explaining how the result was verified.`);
        }
    }
    const inputs = args.inputs;
    if (inputs !== undefined && !(inputs && typeof inputs === "object" && Object.keys(inputs).length === 0)) {
        throw refused("A re-run takes the source Workflow's inputs: omit inputs with rerun_from.");
    }
    if (args.workspace !== undefined) throw refused("A re-run keeps the source Workflow's workspace: omit workspace with rerun_from.");
    if (args.run_again_of !== undefined) throw refused("rerun_from cannot be combined with run_again_of.");
    return {
        workflowId: value.workflow_id,
        ...(value.execution_id !== undefined ? { executionId: value.execution_id as string } : {}),
        ...(value.mode !== undefined ? { mode: value.mode as "run_again" | "continue" | "supply" } : {}),
        ...(value.result !== undefined ? { result: value.result } : {}),
        ...(value.note !== undefined ? { note: value.note } : {}),
    };
}

/** The session definition an ended Workflow was started from, which must be `ownerSessionId`'s (M4a). */
async function rerunSourceDefinition(ctx: ServerContext, ownerSessionId: string, workflowId: string): Promise<string> {
    const read: any = await ctx.mgmt.readWorkflow(workflowId, { limit: 1 });
    const fail = (code: string, status: number, message: string) => Object.assign(new Error(message), { code, status });
    if (read?.deleted === true) {
        throw Object.assign(fail("RERUN_SOURCE_GONE", 409, `Workflow ${workflowId} was cleaned up. Only its result is kept. Use Run again.`),
            { details: { workflowId, outcome: read.run?.outcome ?? null } });
    }
    const source = read?.definition?.source;
    if (typeof source?.definitionId !== "string") {
        throw fail("RERUN_NOT_A_WORKFLOW", 422, `Workflow ${workflowId} was not started from a saved Workflow Definition, so it cannot be re-run from a step.`);
    }
    if (source.ownerSessionId !== ownerSessionId) {
        throw fail("WORKFLOW_NOT_FOUND", 404, `Workflow ${workflowId} was not started from a Workflow Definition of this session.`);
    }
    return source.definitionId;
}

function irScriptsCallTools(ir: ReturnType<typeof compileWorkflow>["ir"]): boolean {
    if (!ir) return false;
    for (const node of Object.values(ir.nodes)) {
        if (node?.type !== "script") continue;
        const req = scriptToolRequirements(node.source);
        if (req.dynamic || req.unchecked || req.tools.some(t => t !== "child_workflows")) return true;
    }
    return false;
}

async function startedRevisionCallsTools(ctx: ServerContext, ownerSessionId: string, definitionId: unknown, revision: unknown): Promise<boolean> {
    if (typeof definitionId !== "string" || !definitionId) return false;
    if (typeof ctx.mgmt.readSessionWorkflowDefinition !== "function") return false;
    try {
        const read: any = await ctx.mgmt.readSessionWorkflowDefinition(ownerSessionId, {
            definitionId,
            ...(typeof revision === "number" && Number.isInteger(revision) ? { revision } : {}),
        });
        if (typeof read?.revision?.yaml === "string") {
            return irScriptsCallTools(compileWorkflow(read.revision.yaml).ir);
        }
        return false;
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
 *   update_workflow              person command to one running Workflow session (approval_respond answers as the owner)
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
                + "definition_revision, step_input and rerun_plan are separate reads: each argument says what it returns. A re-run's steps show "
                + "visit.reused and visit.supplied, its run run.rerunOf, and the source view.reruns. Refusals carry their code: "
                + "WORKFLOW_NOT_FOUND, RUN_NOT_FOUND, EXECUTION_NOT_FOUND, KV_REVISION_NOT_FOUND, DEFINITION_REVISION_NOT_FOUND, WORKFLOW_CURSOR_INVALID, WORKFLOW_READ_INVALID, "
                + "WORKFLOW_STORE_UNAVAILABLE (with its reason) when the store cannot be reached or has no room now, and for rerun_plan "
                + "RERUN_SOURCE_ACTIVE, RERUN_SOURCE_GONE, RERUN_NOT_A_WORKFLOW, RERUN_VISIT_REQUIRED, RERUN_VISIT_NOT_FOUND, RERUN_VISIT_NOT_ALLOWED, "
                + "RERUN_SUPPLY_NOT_ALLOWED, RERUN_SUPPLIED_RESULT_INVALID, RERUN_INCOMPATIBLE, RERUN_TOO_LARGE and RERUN_APPROVAL_REUSED.",
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
                rerun_plan: z.object({
                    execution_id: z.string().optional().describe("The visit to re-run from; omit to let the plan pick the failed step"),
                    mode: z.enum(["run_again", "continue", "supply"]).optional(),
                    revision: z.number().int().positive().optional().describe("Default the source Workflow's revision"),
                    outcome: z.string().optional().describe("supply: the outcome to check; never an output"),
                }).passthrough().optional()
                    .describe("Alone, on an ended Workflow: what workflow_definition start with rerun_from would do now (reused steps, the first "
                        + "step that runs, revision fit, allowed). Changes nothing. Call read_workflow_skill { name: 'workflow-rerun' } first"),
            },
        },
        withToolErrors(async ({ session_id, run_id, cursor, execution_id, limit, kv_revision, kv_key, agent_versions, definition_revision, step_input, rerun_plan }) => {
            if (rerun_plan !== undefined) {
                const given = { run_id, cursor, execution_id, limit, kv_revision, kv_key, agent_versions, definition_revision, step_input };
                const other = READ_SELECTORS.filter(key => given[key] !== undefined);
                const extra = Object.keys(rerun_plan).filter(key => !RERUN_PLAN_KEYS.includes(key));
                if (other.length || extra.length) {
                    return errorResult(other.length
                        ? `A re-run plan is a read of its own; leave out ${other.join(", ")}.`
                        : `rerun_plan takes ${RERUN_PLAN_KEYS.join(", ")}; leave out ${extra.join(", ")} (only start takes a supplied output).`,
                    { code: "WORKFLOW_READ_INVALID", status: 400, session_id });
                }
                const unavailable = rerunUnavailable(ctx, session_id);
                if (unavailable) return unavailable;
                try {
                    // OQ5: an MCP caller never reuses an answered approval, so the plan says allowed: false for one.
                    return jsonResult(await ctx.mgmt.readWorkflow(session_id, { rerunPlan: {
                        ...(rerun_plan.execution_id !== undefined ? { executionId: rerun_plan.execution_id } : {}),
                        ...(rerun_plan.mode !== undefined ? { mode: rerun_plan.mode } : {}),
                        ...(rerun_plan.revision !== undefined ? { revision: rerun_plan.revision } : {}),
                        ...(rerun_plan.outcome !== undefined ? { outcome: rerun_plan.outcome } : {}),
                        viaMcp: true,
                    } }));
                } catch (err: unknown) {
                    return refusal(err, session_id);
                }
            }
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
                + "It creates a chat session whose agent greets and asks for inputs (not a Workflow run); to start the run directly, "
                + "call workflow_definition start with name: '<package>/<name>' and inputs on the returned session. "
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
                if (originatingSessionId !== undefined && isOlderPortalWithoutPhase4Definitions(ctx)) {
                    return errorResult(
                        "This deployment is older than this MCP server and cannot enforce originating_session_id on createSessionForWorkflow; upgrade the portal.",
                        { code: "WORKFLOW_API_UNAVAILABLE", status: 501 },
                    );
                }
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
                    + "'workflow-decision', 'workflow-carry', 'workflow-polling', 'workflow-schedules', 'workflow-approval', 'workflow-long-agent', "
                    + "'workflow-rerun' to re-run an ended Workflow from a step). "
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
                    note: WORKFLOW_SKILL_MCP_NOTE,
                    name: skill.name,
                    description: skill.description,
                    content: skill.content,
                });
            } catch (err: unknown) {
                return refusal(err, undefined, "readWorkflowSkills");
            }
        }),
    );

    if (ctx.workflowCommands !== true) return;

    // Off, update_workflow names stop and no test operation; with test mode on, the test operations too.
    const operations = testMode
        ? "operation (set_vars, pause, resume, cancel, stop, approval_respond, test, test_respond and test_advance), operation_id "
            + "(repeat it to retry the same command) and the operation's arguments (expected_revision, definition_hash, inputs, vars, "
            + "set, delete, expected_kv_revision, run_id, reason, grace_seconds, approval_id, context_sha256, decision, "
            + "agent_mode, fixtures, scenario, interception_id, response, seconds). "
        : "operation (set_vars, pause, resume, cancel, stop and approval_respond), operation_id "
            + "(repeat it to retry the same command) and the operation's arguments (set, delete, expected_kv_revision, run_id, reason, grace_seconds, "
            + "approval_id, context_sha256, decision). ";
    const cmdOpId = z.string().min(1).max(256).describe("New id per change; reuse unchanged only to retry");
    const cmdRunId = z.string().optional().describe("Target run id (default the live run)");
    const cmdReason = z.string().optional().describe("Optional reason");
    const baseCommandBranches = [
        z.object({ operation: z.literal("pause"), operation_id: cmdOpId, run_id: cmdRunId, reason: cmdReason }).passthrough(),
        z.object({ operation: z.literal("resume"), operation_id: cmdOpId, run_id: cmdRunId, reason: cmdReason }).passthrough(),
        z.object({ operation: z.literal("cancel"), operation_id: cmdOpId, run_id: cmdRunId, reason: cmdReason }).passthrough(),
        z.object({
            operation: z.literal("stop"),
            operation_id: cmdOpId,
            run_id: cmdRunId,
            reason: cmdReason,
            grace_seconds: z.number().int().min(0).max(3600).optional().describe("Graceful stop window in seconds, 0 to 3600 (default 60)"),
        }).passthrough(),
        z.object({
            operation: z.literal("set_vars"),
            operation_id: cmdOpId,
            run_id: cmdRunId,
            set: z.record(z.string(), z.unknown()).optional().describe("Variables to set"),
            delete: z.array(z.string()).optional().describe("Variable names to delete"),
            expected_kv_revision: z.number().int().positive().describe("Current kvRevision from read_workflow"),
        }).passthrough(),
        z.object({
            operation: z.literal("approval_respond"),
            operation_id: cmdOpId,
            run_id: z.string().describe("The approval's run id"),
            approval_id: z.string().describe("The approval id from read_workflow"),
            context_sha256: z.string().describe("The approval's contextSha256 from read_workflow"),
            decision: z.enum(["approved", "rejected"]),
            reason: z.string().optional().describe("Required to reject"),
        }).passthrough(),
    ] as const;
    const commandSchema = testMode
        ? z.discriminatedUnion("operation", [
            ...baseCommandBranches,
            z.object({ operation: z.literal("test"), operation_id: cmdOpId }).passthrough(),
            z.object({ operation: z.literal("test_respond"), operation_id: cmdOpId }).passthrough(),
            z.object({ operation: z.literal("test_advance"), operation_id: cmdOpId }).passthrough(),
        ])
        : z.discriminatedUnion("operation", baseCommandBranches);
    const updateGapWorkaround = testMode
        ? "To deliver typed input to a waiting receive step, call send_workflow_input directly."
        : WORKFLOW_MCP_GAP_WORKAROUND;
    server.registerTool(
        "update_workflow",
        {
            title: "Update Workflow",
            description:
                "Send one command to a running Workflow, as a person: "
                + operations
                + "Persons are refused recover (the parent agent recovers runs). approval_respond answers an approval as its owner; the first answer wins. "
                + `${updateGapWorkaround} `
                + "Answers the command's receipt. "
                + "A workflow started under another workflow's agent step takes only pause, stop and cancel; read a workflow with read_workflow "
                + "first.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to command"),
                command: commandSchema.describe("The command: { operation, operation_id, ...its arguments }"),
                originating_session_id: z.string().optional()
                    .describe("The session this command comes from, when an agent's call is passed on; a session inside a Workflow cannot change definitions"),
            },
        },
        withToolErrors(async ({ session_id, command, originating_session_id }) => {
            try {
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
                + "On a fresh 0-turn owner_session_id, pass workspace: 'none' on start (or send one turn first to capture default folders). "
                + "To go on from a step of an ended Workflow, start with rerun_from (name and definition_id may be omitted; omit inputs and workspace, "
                + "even on a 0-turn session); read read_workflow_skill { name: 'workflow-rerun' } first. "
                + WORKFLOW_MCP_GAP_WORKAROUND,
            inputSchema: {
                operation: z.enum(["list", "read", "save", "start", "delete", "copy", "card", "validate"])
                    .describe("Operation to run: validate needs only yaml; all other operations act on owner_session_id"),
                owner_session_id: sessionIdShape().optional()
                    .describe("Live non-Workflow session that owns the definitions (create one with create_session). Required except for validate"),
                name: z.string().optional()
                    .describe("Required for save (definition metadata.name); optional for read/start/delete/copy when definition_id is given; '<package>/<name>' for card (and for copy/start when already attached to owner_session_id)"),
                definition_id: z.string().optional()
                    .describe("Definition ID returned by list/read/save"),
                revision: z.number().int().positive().optional()
                    .describe("Revision number (read: default newest; start: default newest valid, with rerun_from the source Workflow's revision; copy: default newest)"),
                expected_revision: z.number().int().positive().optional()
                    .describe("save over an existing definition: the current revision you read (omit on first save of a new name)"),
                yaml: z.string().max(262144).optional()
                    .describe('Workflow YAML (apiVersion: pilotswarm.dev/v1, metadata.version must be a quoted semver such as "1.0.0", <= 256 KiB) for validate or save'),
                inputs: z.record(z.string(), z.unknown()).optional()
                    .describe("start: Workflow run inputs matching inputs.schema"),
                vars: z.record(z.string(), z.unknown()).optional()
                    .describe("start: initial run variables"),
                run_again_of: z.string().optional()
                    .describe("start: prior Workflow session ID of this definition whose pinned revision and model choices to repeat"),
                notify_on_completion: z.boolean().optional()
                    .describe("start: notify owner_session_id when the Workflow ends (default true)"),
                workspace: z.union([z.record(z.string(), z.unknown()), z.null(), z.literal("none")]).optional()
                    .describe("start: omit to inherit owner_session_id's workspace and defaults (requires >=1 turn in owner_session_id); pass 'none' on a fresh 0-turn session or when no folders are needed; omit with rerun_from (a re-run keeps its source's)"),
                agent_models: z.record(z.string(), z.unknown()).optional()
                    .describe("start: map of agent state id -> { model: 'provider:model', reasoningEffort?, contextTier? }"),
                decision_models: z.record(z.string(), z.unknown()).optional()
                    .describe("start: map of decision state id -> { model: 'provider:model' }"),
                update: z.boolean().optional()
                    .describe("start: when starting a '<package>/<name>' definition already attached to owner_session_id, update to the package's newer active version first"),
                key: z.string().min(1).max(128).optional()
                    .describe("start (preferred): exact session-scoped idempotency key; reuse unchanged on retry, use a new key for another run"),
                rerun_from: z.object({
                    workflow_id: z.string().describe("The ended Workflow to re-run"),
                    execution_id: z.string().optional().describe("The visit to re-run from; omit to re-run from the failed step"),
                    mode: z.enum(["run_again", "continue", "supply"]).optional()
                        .describe("run_again: run the step again; continue: keep the step's result and go on; supply: give a script or agent step's result"),
                    // Review H3: result and note pass the wire as given; the handler checks them as Start does (400 RERUN_ARGUMENT_REFUSED).
                    result: z.unknown().optional()
                        .describe("supply: the step's result { outcome, output? }, checked in the external system"),
                    note: z.unknown().optional().describe("supply only: the evidence you checked (at most 2,000 characters)"),
                }).passthrough().optional()
                    .describe("start: re-run an ended Workflow from a step, reusing the steps before it. Omit inputs and workspace; the "
                        + "revision defaults to the source Workflow's. Over MCP a re-run never reuses an answered approval (403 RERUN_APPROVAL_REUSED)"),
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
                rerun_from,
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
            const isMutation = operation === "save" || operation === "start" || operation === "delete" || operation === "copy";

            // Phase 3 I7: a re-run's arguments are checked, and an older portal refused (M1), before anything is read or changed.
            let rerunFrom: ReturnType<typeof rerunFromArg> | null = null;
            if (operation === "start" && rerun_from !== undefined) {
                try {
                    rerunFrom = rerunFromArg(args);
                } catch (err: unknown) {
                    return refusal(err, owner_session_id);
                }
                const unavailable = rerunUnavailable(ctx, owner_session_id);
                if (unavailable) return unavailable;
            }

            if (isMutation && isOlderPortalWithoutPhase4Definitions(ctx)) {
                if (originatingSessionId !== undefined) {
                    return errorResult(
                        "This deployment is older than this MCP server and cannot enforce originating_session_id on workflow_definition; upgrade the portal.",
                        { code: "WORKFLOW_API_UNAVAILABLE", status: 501, session_id: owner_session_id },
                    );
                }
                if (operation !== "save" && !definition_id && name) {
                    return errorResult(
                        "This deployment is older than this MCP server and requires definition_id (name lookup is unavailable); upgrade the portal.",
                        { code: "WORKFLOW_API_UNAVAILABLE", status: 501, session_id: owner_session_id },
                    );
                }
            }

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
                if (!definition_id && !name && !rerunFrom) {
                    return errorResult("start needs name or definition_id.", { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id });
                }

                const opId = operation_id ?? `key:${key}`;
                let startRevision = revision;
                // M4a/M4b: a re-run that names no definition starts the one its Workflow was started from, before update attaches a newer version.
                const startDefinitionId = definition_id ?? (rerunFrom && !name
                    ? await rerunSourceDefinition(ctx, owner_session_id, rerunFrom.workflowId) : undefined);

                if (update === true) {
                    if (run_again_of) {
                        return errorResult(
                            "update cannot be combined with run_again_of: run_again_of repeats the prior run's pinned revision.",
                            { code: "WORKFLOW_COMMAND_INVALID", status: 400, session_id: owner_session_id },
                        );
                    }
                    let target: any = null;
                    try {
                        target = await ctx.mgmt.readSessionWorkflowDefinition(owner_session_id, {
                            ...(startDefinitionId !== undefined ? { definitionId: startDefinitionId } : {}),
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
                            ...(startDefinitionId !== undefined ? { definitionId: startDefinitionId } : {}),
                            ...(name !== undefined ? { name } : {}),
                            operationId: updateOperationIdFor(opId, key),
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
                        ...(startDefinitionId !== undefined ? { definitionId: startDefinitionId } : {}),
                        ...(name !== undefined ? { name } : {}),
                        ...(startRevision !== undefined ? { revision: startRevision } : {}),
                        ...(run_again_of !== undefined ? { runAgainOf: run_again_of } : {}),
                        ...(inputs !== undefined && !rerunFrom ? { inputs } : {}),
                        ...(vars !== undefined ? { vars } : {}),
                        ...(notify_on_completion !== undefined ? { notifyParent: notify_on_completion } : {}),
                        ...(workspace !== undefined ? { workspace: workspace as any } : {}),
                        ...(agent_models !== undefined ? { agentModels: agent_models } : {}),
                        ...(decision_models !== undefined ? { decisionModels: decision_models } : {}),
                        ...(key !== undefined ? { key } : {}),
                        operationId: opId,
                        // OQ5: an MCP caller never reuses an answered approval (only a re-run sends it; an older portal takes no such field).
                        ...(rerunFrom ? { rerunFrom, viaMcp: true } : {}),
                    },
                    mutOpts,
                );

                // A re-run that inherited its source's tool grant (OQ1) is not a person's Start without one.
                const callsTools = started?.rerun?.grant !== "inherited"
                    && await startedRevisionCallsTools(ctx, owner_session_id, started?.definitionId, started?.revision);
                const existingWarnings = Array.isArray(started?.warnings) ? started.warnings : [];
                const alreadyWarned = existingWarnings.some((w: any) => w?.code === PERSON_START_TOOL_BINDING_WARNING.code);
                const warnings = callsTools && !alreadyWarned
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

    server.registerTool(
        "send_workflow_input",
        {
            title: "Send Workflow Input",
            description:
                "Deliver one typed contract message (Name@version + JSON payload + optional correlation) to a Workflow waiting at an open receive step "
                + "(receive steps with `from:` bound to a session are refused with 409 UNSUPPORTED_CONTRACT). "
                + "Accepts workflow_id (canonical) or session_id (alias); if both are given they must match. "
                + "Idempotent per (workflow, caller, operation_id): reuse operation_id unchanged only to retry the same message. "
                + "Refused for calls that declare an originating session via originating_session_id or PILOTSWARM_ORIGINATING_SESSION_ID (403 FORBIDDEN; agents use their native send_workflow_input tool) and agent-controlled child Workflows (403 WORKFLOW_HUMAN_INPUT_DENIED). "
                + "Returns the stored receipt including claimedBy ({ nodeExecutionId, stateId } | null); poll read_workflow to observe completion.",
            inputSchema: {
                workflow_id: sessionIdShape().optional()
                    .describe("Target Workflow session ID (alias: session_id)"),
                session_id: sessionIdShape().optional()
                    .describe("Target Workflow session ID (alias of workflow_id; must match if both are provided)"),
                contract: z.string().min(1)
                    .describe("Message contract name declared under contracts: in the Workflow YAML (e.g. DeploySignal@1)"),
                payload: z.unknown()
                    .describe("JSON value validated against the contract schema (<= 256 KiB, max nesting depth 64)"),
                correlation: z.record(z.string(), z.unknown()).optional()
                    .describe("Optional correlation key-value object matching the receive step's correlate values (<= 4 KiB, default {})"),
                operation_id: z.string().min(1).max(256)
                    .describe("Caller idempotency token (choose a fresh id per message; reuse unchanged only to retry)"),
                ttl_seconds: z.number().int().min(1).max(86400).optional()
                    .describe("Inbox expiry in seconds, 1..86400 (default 86400)"),
                run_id: z.string().min(1).optional()
                    .describe("Optional target run ID (defaults to the Workflow's live run)"),
                originating_session_id: z.string().optional()
                    .describe("Originating agent session ID when proxied; agent-originated MCP calls are refused with 403 FORBIDDEN"),
            },
        },
        withToolErrors(async ({ workflow_id, session_id, contract, payload, correlation, operation_id, ttl_seconds, run_id, originating_session_id }) => {
            const originatingSessionId = ctx.originatingSessionId ?? originating_session_id;
            if (originatingSessionId !== undefined && originatingSessionId !== null) {
                if (typeof originatingSessionId !== "string" || !originatingSessionId.trim()) {
                    return errorResult("originating_session_id, when given, must be a non-empty session id.", {
                        code: "WORKFLOW_COMMAND_INVALID",
                        status: 400,
                    });
                }
                return errorResult(
                    "Agent sessions must use their native send_workflow_input tool so session sender identity is preserved.",
                    { code: "FORBIDDEN", status: 403 },
                );
            }
            if (!workflow_id && !session_id) {
                return errorResult("workflow_id (or session_id) is required.", {
                    code: "WORKFLOW_COMMAND_INVALID",
                    status: 400,
                });
            }
            if (workflow_id && session_id && workflow_id !== session_id) {
                return errorResult("workflow_id and session_id must match when both are provided.", {
                    code: "WORKFLOW_COMMAND_INVALID",
                    status: 400,
                });
            }
            const targetId = (workflow_id ?? session_id)!;
            if (payload === undefined) {
                return errorResult("payload is required.", {
                    code: "WORKFLOW_COMMAND_INVALID",
                    status: 400,
                    session_id: targetId,
                });
            }
            if (isOlderPortalWithoutWorkflowInput(ctx)) {
                return errorResult(
                    "This deployment is older than this MCP server and has no sendWorkflowInput; upgrade the portal.",
                    { code: "WORKFLOW_API_UNAVAILABLE", status: 501, session_id: targetId },
                );
            }
            try {
                const input: {
                    contract: string;
                    payload: unknown;
                    operationId: string;
                    correlation?: Record<string, unknown>;
                    ttlSeconds?: number;
                    runId?: string;
                } = {
                    contract,
                    payload,
                    operationId: operation_id,
                    ...(correlation !== undefined ? { correlation } : {}),
                    ...(ttl_seconds !== undefined ? { ttlSeconds: ttl_seconds } : {}),
                    ...(run_id !== undefined ? { runId: run_id } : {}),
                };
                return jsonResult(await ctx.mgmt.sendWorkflowInput(targetId, input));
            } catch (err: unknown) {
                return refusal(err, targetId, "sendWorkflowInput");
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
