import type { PermissionRequestResult } from "@github/copilot-sdk";
import { resolveEffectiveSpawnOwner } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import { COMPLETE_WORKFLOW_NODE_TOOL } from "./agent-node-service.js";
import { boundedCanonicalJson, canonicalJson, previewJson, sha256Hex, WorkflowJsonError } from "./json.js";
import { redactThenClip } from "./redact.js";
import { matchTestFixture, storedTestFixtures, toolCallResultOf, WORKFLOW_V2_TEST_POLL_MS, workflowTestNoticePrompt } from "./test-mode.js";
import { ACTIVE_RUN_STATUSES, WorkflowStoreError, type WorkflowLineage, type WorkflowStore, type WorkflowTestInterception } from "./store.js";

/**
 * Workflow v2 real-agent test runs (design 05 agent mode real; R19, R20,
 * T112). Every worker wires it on a 1.0.83 turn of a session in a test run's
 * agent state's subtree (session-proxy); test runs start only while workflow
 * test mode is on (test-mode-switch.ts; off by default).
 *
 * An agent state of a real-agent test run has a real child: an ordinary
 * agent session, created and bound as a live run's is (agent-host.ts: the
 * same owner, visibility, depth and system-agent rules, and the package
 * revision the test pinned). What the framework brokers for that child, and
 * for any session in its subtree, is intercepted instead of running: each
 * call of a framework tool (a worker or package tool, a system tool such as
 * wait, cron, cron_at or spawn_agent, a workflow tool) becomes an
 * interception record of the agent state (`<node execution>/call-<n>`,
 * store.interceptAgentToolCall), answered by a tool.call fixture (its tool
 * and the exact hash of its arguments) or by the test's parent
 * (update_workflow test_respond), and the call returns that answer to the
 * model. Two tools are not intercepted: complete_workflow_node, the state's
 * own completion, and ask_user, which a session in an agent state's subtree
 * is refused as in a live run (R14). The model's own built-in tools (shell,
 * files) are not framework calls: they run normally, as a script's direct
 * effects do. MCP tools cannot be intercepted, so a turn under a real-agent
 * test refuses them (workflowTestPermission); none runs live.
 *
 * Nothing falls back to a live call. A call that no fixture answers waits
 * for the parent's answer for at most `waitMs` (a turn's inactivity guard
 * ends a silent turn after 5 minutes by default), then fails; a later
 * answer is recorded and changes nothing. A call after the state was decided
 * or the run ended is refused, and nothing runs.
 */

/** The tools a session under a real-agent test calls as in a live run: the state's completion, and ask_user's refusal (R14). */
export const WORKFLOW_V2_TEST_AGENT_UNINTERCEPTED_TOOLS: readonly string[] = [COMPLETE_WORKFLOW_NODE_TOOL, "ask_user"];
/** How long an intercepted tool call of a real agent waits for the parent's answer by default (milliseconds). */
export const WORKFLOW_V2_TEST_AGENT_TOOL_WAIT_MS = 180_000;
/** Why a turn under a real-agent test refuses an MCP tool (workflowTestPermission). */
export const WORKFLOW_V2_TEST_MCP_REFUSAL = "This session runs under a workflow test with real agents: its framework tools are mocked, "
    + "and an MCP tool cannot be mocked, so it is refused. Use a framework tool, or complete the state.";

/** A framework tool call of a session under a real-agent test: its answer (a JSON value), or an error when it gets none. */
export type WorkflowTestToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The agent state whose real child (or a session in its subtree) makes the calls, and its test run. */
export interface WorkflowTestAgentScope {
    workflowSessionId: string;
    runId: string;
    nodeExecutionId: string;
    stateId: string;
    /** The agent state's child (the root of the subtree). */
    agentSessionId: string;
}

/**
 * The real-agent test scope of a session from its lineage: its nearest
 * agent state's node execution, when that state belongs to a test run (null
 * for a live run's, or outside every agent state). Fails closed: a node or
 * run that cannot be read throws, so the turn is not run with live tools.
 */
export async function workflowTestAgentScope(store: Pick<WorkflowStore, "readNodeExecution" | "readRun">, lineage: Pick<WorkflowLineage, "agentRoot"> | null)
    : Promise<WorkflowTestAgentScope | null> {
    const root = lineage?.agentRoot ?? null;
    if (root === null) return null;
    const node = await store.readNodeExecution(root.nodeExecutionId);
    if (!node || node.nodeType !== "agent") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${root.nodeExecutionId} cannot be read.`);
    const run = await store.readRun(node.runId);
    if (!run) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `The run of agent state ${root.nodeExecutionId} cannot be read.`);
    if (run.mode !== "test") return null;
    return { workflowSessionId: run.workflowSessionId, runId: run.runId, nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId,
        agentSessionId: root.childSessionId };
}

export interface WorkflowTestAgentToolDeps {
    store: Pick<WorkflowStore, "readTestFixtures" | "interceptAgentToolCall" | "readInterception" | "readNodeExecution" | "readRun"
        | "readDefinition" | "recordSessionEvents">;
    /**
     * Tell the test's parent that a call waits for its answer (best effort, as a test run's other notices): only when
     * `authorizeNotice` allows it. Without either, the parent reads the call through read_workflow.
     */
    authorizeNotice?: (workflowSessionId: string, parentSessionId: string) => Promise<boolean>;
    notice?: (parentSessionId: string, prompt: string, clientMessageId: string) => Promise<void>;
    /** How often a waiting call looks for its answer (default WORKFLOW_V2_TEST_POLL_MS). */
    pollMs?: number;
    /** How long a call waits for the parent's answer (default WORKFLOW_V2_TEST_AGENT_TOOL_WAIT_MS). */
    waitMs?: number;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A run's workflow name and version, or null when the store cannot say (best effort: a notice never fails for it). */
async function workflowLabelOf(store: unknown, runId: string): Promise<{ name: string | null; version: string | null } | null> {
    const reader = store as { readRun?: (id: string) => Promise<{ workflowSessionId: string; revision: number } | null>;
        readRevisionLabel?: (id: string, revision: number) => Promise<{ name?: string | null; semver?: string | null } | null> };
    if (typeof reader.readRun !== "function" || typeof reader.readRevisionLabel !== "function") return null;
    try {
        const run = await reader.readRun(runId);
        const label = run ? await reader.readRevisionLabel(run.workflowSessionId, run.revision) : null;
        return label ? { name: label.name ?? null, version: label.semver ?? null } : null;
    } catch {
        return null;
    }
}

/**
 * The framework tool calls of a session under a real-agent test (see the
 * module's comment): `callerSessionId` is the session that calls (the
 * agent state's child, or a session in its subtree).
 */
export function workflowTestAgentToolCall(deps: WorkflowTestAgentToolDeps, scope: WorkflowTestAgentScope, callerSessionId: string): WorkflowTestToolCall {
    const { store } = deps;
    const pollMs = deps.pollMs ?? WORKFLOW_V2_TEST_POLL_MS;
    const waitMs = deps.waitMs ?? WORKFLOW_V2_TEST_AGENT_TOOL_WAIT_MS;
    const notify = async (record: WorkflowTestInterception): Promise<void> => {
        if (!deps.notice || !deps.authorizeNotice) return;
        try {
            const definition = await store.readDefinition(scope.workflowSessionId);
            if (!definition?.parentSessionId || !await deps.authorizeNotice(scope.workflowSessionId, definition.parentSessionId)) return;
            // The workflow's name for the header (w-1), when this store can say it; the notice goes without it otherwise.
            const label = await workflowLabelOf(store, scope.runId);
            await deps.notice(definition.parentSessionId, workflowTestNoticePrompt({
                sessionId: scope.workflowSessionId, runId: scope.runId, interceptionId: record.interceptionId, operation: record.operation,
                stateId: scope.stateId, tool: record.tool, arguments: previewJson(record.arguments, 2_000), responseSchema: record.responseSchema,
                agentSessionId: callerSessionId,
            }, label), `workflow-test:${record.interceptionId}`);
        } catch (error) {
            await store.recordSessionEvents(scope.workflowSessionId, [{ eventType: "workflow.test_notice_failed", data: {
                // S6-SF2: its secrets hidden in full before it is cut.
                runId: scope.runId, interceptionId: record.interceptionId, error: redactThenClip(error instanceof Error ? error.message : String(error), 1_000),
            } }]).catch(() => undefined);
        }
    };
    return async (tool, args) => {
        let argumentsText: string;
        try { argumentsText = boundedCanonicalJson(args, `The arguments of ${tool}`); }
        catch (error) {
            if (error instanceof WorkflowJsonError) throw new Error(`The arguments of ${tool} cannot be recorded: ${error.message}`);
            throw error;
        }
        const fixtures = storedTestFixtures(await store.readTestFixtures(scope.runId));
        const fixture = matchTestFixture(fixtures, { operation: "tool.call", tool, state: null, argumentsSha256: sha256Hex(argumentsText) });
        const { record } = await store.interceptAgentToolCall({
            runId: scope.runId, nodeExecutionId: scope.nodeExecutionId, tool, argumentsText,
            fixture: fixture ? { kind: fixture.response.kind, valueText: canonicalJson(fixture.response.value) } : null,
            projection: intercepted => ({ sessionId: scope.workflowSessionId, events: [{ eventType: "workflow.test_intercepted", data: {
                runId: scope.runId, nodeExecutionId: scope.nodeExecutionId, stateId: scope.stateId, interceptionId: intercepted.interceptionId,
                operation: intercepted.operation, tool: intercepted.tool, state: intercepted.state, disposition: intercepted.response?.disposition ?? null,
                realAgent: { agentSessionId: scope.agentSessionId, callerSessionId },
            } }], update: { touch: true } }),
        });
        let current = record;
        if (current.state === "awaiting_parent") await notify(current);
        const deadline = Date.now() + waitMs;
        while (current.state !== "responded") {
            const node = await store.readNodeExecution(scope.nodeExecutionId);
            const run = await store.readRun(scope.runId);
            if (!node || node.state !== "pending" || !run || !ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new Error(`The test run stopped waiting for the answer to ${current.interceptionId}: its state was decided or the run ended.`);
            }
            if (Date.now() >= deadline) {
                throw new Error(`The test's parent did not answer ${current.interceptionId} (${tool}) within ${Math.round(waitMs / 1000)} seconds; `
                    + "the call did not run. A tool.call fixture answers a call in advance.");
            }
            await pause(pollMs);
            current = (await store.readInterception(current.interceptionId)) ?? current;
        }
        const answered = toolCallResultOf(current);
        if ("error" in answered) throw new Error(answered.error);
        return answered.value;
    };
}

/**
 * A turn's tool handlers with every framework tool but the uninterceptable
 * ones (WORKFLOW_V2_TEST_AGENT_UNINTERCEPTED_TOOLS) intercepted: each call
 * goes to `call` and returns its answer (text as it is, any other value as
 * JSON); a call that gets no answer returns `failure(error)`. The tools'
 * declarations are unchanged, so the model sees the tools it would see in a
 * live run.
 */
export function interceptWorkflowTestTools<T extends { name: string }>(tools: T[], call: WorkflowTestToolCall, failure: (error: unknown) => unknown): T[] {
    return tools.map(tool => WORKFLOW_V2_TEST_AGENT_UNINTERCEPTED_TOOLS.includes(tool.name) ? tool : {
        ...tool,
        handler: async (args: unknown) => {
            try {
                const plain = args !== null && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
                const value = await call(tool.name, plain);
                return typeof value === "string" ? value : JSON.stringify(value ?? null);
            } catch (error) {
                return failure(error);
            }
        },
    });
}

/**
 * A session's permission handler that refuses MCP tools (and MCP model
 * sampling) while `active()` (a turn under a real-agent test: an MCP tool
 * cannot be intercepted, so it never runs live there); everything else, and
 * every other turn, goes to `base` unchanged.
 */
export function workflowTestPermission<A extends unknown[], R>(base: (request: { kind?: string } | undefined, ...rest: A) => R, active: () => boolean)
    : (request: { kind?: string } | undefined, ...rest: A) => R | PermissionRequestResult {
    return (request, ...rest) => (active() && (request?.kind === "mcp" || request?.kind === "mcp-sampling")
        ? { kind: "reject", feedback: WORKFLOW_V2_TEST_MCP_REFUSAL } as PermissionRequestResult
        : base(request, ...rest));
}

/**
 * Whether a session under a test may notify the test's parent, as a test
 * run's other notices are authorized (the worker's rule): the workflow is the
 * parent's child, the parent is live and not ended, and both have the same
 * effective owner.
 */
export async function authorizeWorkflowTestNotice(getSession: (sessionId: string) => Promise<{
    parentSessionId?: string | null; deletedAt?: unknown; state?: string | null; owner?: SessionOwnerInfo | null; isSystem?: boolean;
} | null | undefined>, workflowSessionId: string, parentSessionId: string): Promise<boolean> {
    const [workflow, parent] = await Promise.all([getSession(workflowSessionId), getSession(parentSessionId)]);
    if (!workflow || workflow.parentSessionId !== parentSessionId || !parent || parent.deletedAt
        || ["completed", "failed", "cancelled"].includes(parent.state ?? "")) return false;
    const [workflowOwner, parentOwner] = await Promise.all([
        resolveEffectiveSpawnOwner(getSession, workflowSessionId), resolveEffectiveSpawnOwner(getSession, parentSessionId),
    ]);
    return Boolean(workflowOwner && parentOwner && workflowOwner.provider === parentOwner.provider && workflowOwner.subject === parentOwner.subject);
}
