/**
 * PR 270 (owner decision; the TEST run whose two For each items waited 75 minutes): an agent step whose chat's turn fails
 * for good fails execution_failed at once and its failure route runs, instead of waiting for its deadline. A full
 * PilotSwarmWorker (PostgreSQL, Duroxide and the Copilot CLI) with the model scripted (scripted-model.mjs), as
 * workflow-v2-agent-worker.test.js runs one.
 *
 * - The model fails every request of the step's chat (HTTP 400): each turn ends in an error, the session orchestration
 *   retries it (15 s, then 30 s), and when its retries are spent it reports the failed turn
 *   (orchestration/workflow-turn-failure.ts): the step fails execution_failed (winner controller), the run takes its
 *   failure route, and the chat is cancelled, long before the step's 30-minute deadline.
 * - Text, then the failure: the model answers the step's prompt with text and a tool call, then fails the next request.
 *   Before, the turn ended "completed" with that text (the error was dropped), so no retry ran, no reminder was given and
 *   the step waited for its deadline. Now the chat's turn ends as an error, retries, and the failure is reported.
 *
 * At 01caf109 the step stays pending until its deadline in both cases, so both fail there.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const TIMEOUT = 480_000;
/** The step's own deadline: far beyond what the test waits for. */
const STEP_DEADLINE_SECONDS = 1_800;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-turn-failure-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-agent-turn-failure-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One agent step with an inline prompt, a 30-minute deadline and a failure route. As a document (JSON is YAML). */
const STEP_YAML = JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "failing-step", version: "1.0.0" }, initial: "summarize",
    states: {
        summarize: {
            type: "agent", invoke: { prompt: "Summarize the change in one line." }, session: "new", outcomes: ["success"],
            timeoutSeconds: STEP_DEADLINE_SECONDS, transition: { next: { success: "done", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
}, null, 2);

async function startStep(catalog, store, duroxide) {
    const parent = randomUUID();
    await catalog.createSession(parent, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2({ catalog, store, duroxideClient: duroxide }, {
        workflowSessionId, parentSessionId: parent, yaml: STEP_YAML, actor: ACTOR, operationId: "create", publish: true,
        start: { inputs: {} }, notifyParent: false,
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    return { workflowSessionId, runId, nodeExecutionId: nodeExecutionIdFor(runId, "root", "summarize", 1) };
}

async function waitFor(label, check, timeoutMs, evidence) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(500);
    }
    console.info("workflow agent turn failure evidence", JSON.stringify({ boundary: label, ...(await evidence()) }).slice(0, 20_000));
    throw new Error(`boundary not reached: ${label}`);
}

/** Run one case: `respond` answers the step chat's requests; returns what the case checks. */
async function runCase(respond) {
    const env = getEnv();
    const requests = [];
    const model = (body, position) => {
        const tools = (body.tools ?? []).map(tool => tool.function?.name);
        if (!tools.includes("complete_workflow_node")) return { content: "ok" };
        requests.push({ step: position.step, turn: position.turn, prompt: position.lastUserText.slice(0, 200) });
        return respond(body, position);
    };
    const traces = [];
    const worker = { logLevel: "warning", traceWriter: line => { traces.push(String(line)); if (traces.length > 300) traces.shift(); } };
    let outcome = null;
    await withScriptedModel(env, { respond: model, worker }, async ({ client }) => {
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const duroxide = client._getDuroxideClient();
        try {
            const store = catalog.workflowStore();
            const { workflowSessionId, runId, nodeExecutionId } = await startStep(catalog, store, duroxide);
            const startedAt = Date.now();
            const evidence = async () => ({
                run: await store.readRun(runId).catch(String),
                nodes: await store.listNodeExecutions(runId).then(rows => rows.map(row => [row.nodeId, row.state, row.outcome, row.winner, row.error])).catch(String),
                invocation: await store.readAgentInvocation(nodeExecutionId).catch(String),
                requests, traces: traces.slice(-60),
            });
            const run = await waitFor("the run ends", async () => {
                const row = await store.readRun(runId);
                return row && ENDED.includes(row.status) ? row : null;
            }, 300_000, evidence);
            const elapsedMs = Date.now() - startedAt;
            const node = await store.readNodeExecution(nodeExecutionId);
            const invocation = await waitFor("the chat's end is sent", async () => {
                const row = await store.readAgentInvocation(nodeExecutionId);
                return row?.endSentAt ? row : null;
            }, 60_000, evidence);
            const failed = (await catalog.getSessionEvents(workflowSessionId, 0, 500, ["workflow.state_failed"])).map(event => event.data);
            outcome = { run, node, invocation, failed, elapsedMs, requests: [...requests] };
        } finally {
            await catalog.close();
        }
    });
    return outcome;
}

function expectFailedStep({ run, node, invocation, failed, elapsedMs }) {
    expect(node).toMatchObject({ nodeId: "summarize", state: "completed", outcome: "execution_failed", winner: "controller", resultKind: "runtime_error" });
    expect(run).toMatchObject({ status: "failed", terminalOutcome: "failed", terminalNodeId: "failed" });
    expect(elapsedMs).toBeLessThan(STEP_DEADLINE_SECONDS * 1_000 / 4);
    expect(invocation.endRequested).toBe("cancel");
    expect(failed).toContainEqual(expect.objectContaining({ nodeExecutionId: node.nodeExecutionId, outcome: "execution_failed", cause: "agent_turn_failed" }));
}

describe("a Workflow agent step whose chat's turn fails for good (PR 270, real worker)", () => {
    it("the model fails every request: after the turn's retries the step fails execution_failed and its failure route runs", { timeout: TIMEOUT }, async () => {
        const outcome = await runCase(() => ({ httpStatus: 400, message: "scripted model failure: exceeded token rate limit" }));
        expectFailedStep(outcome);
        // Three attempts of the turn (the first and its two retries), each failing at its first request.
        expect(outcome.requests.filter(request => request.step === 0).length).toBeGreaterThanOrEqual(3);
    });

    it("text, then the failure: the chat's turn ends as an error, not completed, so it retries and the step fails", { timeout: TIMEOUT }, async () => {
        const outcome = await runCase((_body, position) => (position.step === 0
            ? { content: "Let me look at the models first.", tools: [{ name: "list_available_models", args: {} }] }
            : { httpStatus: 400, message: "scripted model failure after text" }));
        expectFailedStep(outcome);
        // Each attempt gave text and a tool call, then failed: three attempts, so the turn was retried.
        expect(outcome.requests.filter(request => request.step === 0).length).toBeGreaterThanOrEqual(3);
        expect(outcome.requests.some(request => request.step >= 1)).toBe(true);
    });
});
