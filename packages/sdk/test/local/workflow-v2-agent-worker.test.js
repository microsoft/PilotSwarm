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
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-worker-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-v2-agent-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(250);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
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
        await withScriptedModel(env, { respond, worker: { pluginDirs: [pluginDir], testOptions: { workflowRequests: true } } }, async ({ client }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            try {
                const store = catalog.workflowStore();
                const parent = randomUUID();
                await catalog.createSession(parent, { owner: OWNER });
                const workflowSessionId = randomUUID();
                // Published and started as a 1.9.0 host's tools would (the worker's controller runs it).
                const created = await createWorkflowV2({ catalog, store, duroxideClient: client._getDuroxideClient(), requests: true }, {
                    workflowSessionId, parentSessionId: parent, yaml: WORKFLOW, actor: ACTOR, operationId: "create", publish: true,
                    start: { inputs: {} }, notifyParent: false,
                });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                const run = await until(async () => {
                    const row = await store.readRun(runId);
                    return row && ENDED.includes(row.status) ? row : null;
                }, "the run to end");
                expect(run).toMatchObject({ status: "completed", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, terminalOutput: { verdict: "approved" } });
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
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
                expect(turns.length).toBeGreaterThanOrEqual(1);
                expect(turns[0].prompt).toContain("WORKFLOW NODE INVOCATION");
                expect(turns[0].prompt).toContain("Apply your role (agent workflow-reviewer) to the input above.");
                expect(turns[0].system).toContain("WORKFLOW-REVIEWER-MARKER");
                expect(JSON.parse(turns[0].result)).toMatchObject({ ok: true, kind: "result", outcome: "accepted", nodeExecutionId, runId });

                // After the agent's own completion the controller ends the child: done, handed to its queue while it ran (it had
                // continued as new at 1.0.83, not failed), and the child completes.
                const ended = await until(async () => {
                    const row = await store.readAgentInvocation(nodeExecutionId);
                    return row?.endSentAt ? row : null;
                }, "the child's end to be sent");
                expect(ended.endRequested).toBe("done");
                expect(ended.endChildStatus).not.toMatch(/fail|terminat|notfound/i);
                await until(async () => (await client._getDuroxideClient().getStatus(`session-${child}`))?.status === "Completed",
                    "the child to complete");
                expect(await sessionOrchestrationVersion(client, child)).toBe(DURABLE_SESSION_INTAKE_VERSION);
            } finally {
                await catalog.close();
            }
        });
    });
});
