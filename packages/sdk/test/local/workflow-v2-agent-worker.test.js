/**
 * Workflow v2 agent states on a real worker (INACTIVE: the test-only worker
 * option testOptions.workflowRequests; workflow/v2/milestone-worker.ts). A
 * full PilotSwarmWorker (PostgreSQL, Duroxide and the Copilot CLI) with the
 * model scripted (scripted-model.mjs), as the scripted-harness tests run.
 *
 * - The worker runs controller 1.9.0: a published workflow whose agent state
 *   names the worker's own deployment agent starts a live run, and the
 *   worker's agent host resolves that agent (the registry-backed resolver
 *   over the agent registry and the worker's agents) and creates the child
 *   through a client of the worker's store: under the workflow, owned as the
 *   workflow's owner, bound to that agent, at the durable intake's
 *   orchestration (1.0.83).
 * - The child's real turn gets the wrapper as its first prompt, the bound
 *   agent's prompt and complete_workflow_node; the model's completion
 *   decides the state (winner agent), the run completes with its output, and
 *   the controller ends the child (done, sent while it ran: it had continued
 *   as new at 1.0.83), which then completes.
 *
 * Test double: the model (scripted). Not an activation: one worker serves
 * everything here, and nothing in a deployment sets the option; duroxide
 * cannot route orchestration items by version, so a deployment would need
 * every worker to serve 1.9.0 and 1.0.83.
 *
 * Diagnostics: the case waits boundary by boundary (the state entered, the
 * child spawned, its turn at the model, the state decided, the run ended, the
 * child ended). A boundary that is not reached prints one bounded evidence
 * record before the schemas are dropped: the run, its node executions, the
 * agent invocation, the child's row, orchestration and events, the histories
 * of the controller and the agent orchestration (their failed events first),
 * the workflow's events, every model request and the worker's trace tail.
 * The worker logs at warning level, so a retried activity's warning shows.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { systemText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { PgSessionCatalog } from "../../src/cms.ts";
import { DURABLE_SESSION_INTAKE_VERSION } from "../../src/orchestration-version.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowAgentInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const TIMEOUT = 480_000;
/** Each boundary's own wait: together within TIMEOUT. */
const BOUNDARY_MS = 60_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-worker-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-v2-agent-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A value as bounded JSON: whole when short, otherwise its head and size. */
function bounded(value, limit = 1_500) {
    let text;
    try { text = JSON.stringify(value); } catch (error) { return { unserializable: String(error?.message ?? error) }; }
    if (text === undefined) return null;
    return text.length <= limit ? JSON.parse(text) : { truncated: true, chars: text.length, head: text.slice(0, limit) };
}

/** A read for the evidence: its value, or the error that kept it from being read. */
async function read(fn) {
    try { return await fn(); } catch (error) { return { readError: String(error?.message ?? error) }; }
}

/** An orchestration instance's status, version and history: failed events first, then the last events. */
async function instanceEvidence(duroxide, instanceId) {
    return read(async () => {
        const [status, info, executions] = await Promise.all([duroxide.getStatus(instanceId), duroxide.getInstanceInfo(instanceId).catch(() => null),
            duroxide.listExecutions(instanceId).catch(() => [])]);
        const history = [];
        for (const executionId of executions) history.push(...(await duroxide.readExecutionHistory(instanceId, executionId)).map(event => ({ executionId, ...event })));
        const summary = event => ({ executionId: event.executionId, kind: event.kind, data: bounded(event.data, 600) });
        return {
            status: bounded(status, 1_500), orchestrationVersion: info?.orchestrationVersion ?? null, executions: executions.length, events: history.length,
            failed: history.filter(event => /fail|error/i.test(String(event.kind))).slice(-12).map(summary),
            scheduled: history.filter(event => event.kind === "ActivityScheduled").map(event => /"name":"([^"]+)"/.exec(String(event.data))?.[1] ?? "?"),
            last: history.slice(-15).map(summary),
        };
    });
}

/** One agent state naming the worker's deployment agent, then terminals. As a document (JSON is YAML). */
const WORKFLOW = JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "worker-review", version: "1.0.0" },
    initialInput: { change: "rename a field" }, initial: "review",
    schemas: { Review: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false } },
    states: {
        review: {
            type: "agent", invoke: { agent: { name: "workflow-reviewer" } }, outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 600,
            transition: { next: { accepted: "done", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
}, null, 2);

describe("workflow v2 agent states on a real worker (test-only option, inactive)", () => {
    it("runs an agent state's child through the worker's own agent host: resolved, created, bound, at 1.0.83, completing its state", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const pluginDir = join(env.baseDir, `agent-worker-plugin-${env.runId}`);
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "wfv2-agents", version: "1.0.0" }));
        writeFileSync(join(pluginDir, "agents", "workflow-reviewer.agent.md"),
            "---\nname: workflow-reviewer\ndescription: Reviews a change for a workflow.\n---\nWORKFLOW-REVIEWER-MARKER: review the change you are given.\n");
        // The child's turn: complete the state at once, then end the turn. Any other session answers "ok".
        const turns = [];
        const respond = (body, position) => {
            const tools = (body.tools ?? []).map(tool => tool.function?.name);
            if (!tools.includes("complete_workflow_node")) return { content: "ok" };
            if (position.step === 0) {
                turns.push({ prompt: position.lastUserText, system: systemText(body), tools });
                return { tools: [{ name: "complete_workflow_node", args: { outcome: "accepted", output: { verdict: "approved" }, operation_id: "review-1" } }] };
            }
            turns.at(-1).result = position.toolResults.at(-1);
            return { content: "STATE_COMPLETED" };
        };
        // The worker's trace tail, for the evidence.
        const traces = [];
        const traceWriter = line => { traces.push(String(line)); if (traces.length > 300) traces.shift(); };
        const worker = { pluginDirs: [pluginDir], testOptions: { workflowRequests: true }, logLevel: "warning", traceWriter };
        await withScriptedModel(env, { respond, worker }, async ({ client, model }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const duroxide = client._getDuroxideClient();
            try {
                const store = catalog.workflowStore();
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                const workflowSessionId = randomUUID();
                // Published and started as a 1.9.0 host's tools would (the worker's controller runs it).
                const created = await createWorkflowV2({ catalog, store, duroxideClient: duroxide, requests: true }, {
                    workflowSessionId, parentSessionId: parent, yaml: WORKFLOW, actor: ACTOR, operationId: "create", publish: true,
                    start: { inputs: {} }, notifyParent: false,
                });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);

                /** Where the run stands: every durable record a boundary depends on (see the file's comment). */
                const evidence = async () => {
                    const run = await read(() => store.readRun(runId));
                    const invocation = await read(() => store.readAgentInvocation(nodeExecutionId));
                    const child = invocation && !invocation.readError ? invocation.childSessionId : null;
                    const events = async sessionId => (await catalog.getSessionEvents(sessionId, 0, 300)).slice(-40)
                        .map(event => ({ seq: event.seq, eventType: event.eventType, data: bounded(event.data, 300) }));
                    return {
                        run: bounded(run, 2_000),
                        nodes: bounded(await read(async () => (await store.listNodeExecutions(runId)).map(node => ({
                            nodeExecutionId: node.nodeExecutionId, nodeId: node.nodeId, state: node.state, outcome: node.outcome, winner: node.winner,
                            resultKind: node.resultKind, output: node.output, error: node.error }))), 2_000),
                        invocation: bounded(invocation, 2_000),
                        child: child ? {
                            row: bounded(await read(() => catalog.getSession(child)), 1_500),
                            instance: await instanceEvidence(duroxide, `session-${child}`),
                            events: bounded(await read(() => events(child)), 6_000),
                        } : null,
                        controller: run && !run.readError ? await instanceEvidence(duroxide, run.controllerInstanceId) : null,
                        agentOrchestration: await instanceEvidence(duroxide, workflowAgentInstanceId(nodeExecutionId)),
                        workflowEvents: bounded(await read(() => events(workflowSessionId)), 6_000),
                        model: model.requests.map(request => ({
                            index: request.index, session: request.session, turn: request.position.turn, step: request.position.step,
                            tools: (request.body?.tools ?? []).map(tool => tool.function?.name).filter(Boolean).slice(0, 40),
                            user: String(request.position.lastUserText ?? "").slice(0, 200),
                            toolResults: (request.position.toolResults ?? []).map(result => String(result).slice(0, 300)), answer: bounded(request.answer, 300),
                        })),
                        turns: bounded(turns, 2_000),
                        traces: traces.slice(-80),
                    };
                };
                /** Wait for one boundary; one not reached prints the evidence once and fails naming it. */
                const boundary = async (label, check, timeoutMs = BOUNDARY_MS) => {
                    const deadline = Date.now() + timeoutMs;
                    let last = null;
                    while (Date.now() < deadline) {
                        last = await check();
                        if (last) return last;
                        await pause(250);
                    }
                    console.info("workflow agent worker evidence", JSON.stringify({ boundary: label, last: bounded(last, 500), ...(await evidence()) }));
                    throw new Error(`boundary not reached: ${label} (the evidence record is printed above)`);
                };

                await boundary("the agent state is entered", () => store.readNodeExecution(nodeExecutionId));
                await boundary("the child is spawned", async () => (await store.readAgentInvocation(nodeExecutionId))?.spawnedAt ?? null);
                await boundary("the child's turn reaches the model with complete_workflow_node", async () => (turns.length > 0 ? turns[0] : null));
                await boundary("the state is decided", async () => {
                    const node = await store.readNodeExecution(nodeExecutionId);
                    return node?.state === "completed" ? node : null;
                });
                const run = await boundary("the run ends", async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                });
                expect(run).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "approved" } });
                expect(await store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent", output: { verdict: "approved" } });
                const invocation = await store.readAgentInvocation(nodeExecutionId);
                expect(invocation).toMatchObject({ workflowSessionId, controllingSessionId: parent,
                    task: { source: "agent", name: "workflow-reviewer", package: null, version: null } });
                expect(invocation.spawnedAt).not.toBeNull();
                const child = invocation.childSessionId;

                // The child: under the workflow, owned as its owner, bound to the worker's deployment agent, at 1.0.83.
                expect(await catalog.getSession(child)).toMatchObject({ parentSessionId: workflowSessionId, agentId: "workflow-reviewer",
                    owner: { provider: OWNER.provider, subject: OWNER.subject } });
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_INTAKE_VERSION);
                // Its real turn: the wrapper first, the bound agent's prompt, the completion tool; the completion was accepted.
                expect(turns[0].prompt).toContain("WORKFLOW NODE INVOCATION");
                expect(turns[0].prompt).toContain("Apply your role (agent workflow-reviewer) to the input above.");
                expect(turns[0].system).toContain("WORKFLOW-REVIEWER-MARKER");
                expect(JSON.parse(turns[0].result)).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId, runId });

                // After the agent's own completion the controller ends the child: done, handed to its queue while it ran (it had
                // continued as new at 1.0.83, not failed), and the child completes.
                const ended = await boundary("the child's end is sent", async () => {
                    const row = await store.readAgentInvocation(nodeExecutionId);
                    return row?.endSentAt ? row : null;
                });
                expect(ended.endRequested).toBe("done");
                expect(ended.endChildStatus).not.toMatch(/fail|terminat|notfound/i);
                await boundary("the child completes", async () => ((await duroxide.getStatus(`session-${child}`))?.status === "Completed" ? true : null));
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_INTAKE_VERSION);
            } finally {
                await catalog.close();
            }
        });
    });
});
