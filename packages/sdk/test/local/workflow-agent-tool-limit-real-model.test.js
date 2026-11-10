/**
 * Stage 2.1c, FU-17, on a REAL model: an agent node with `tools: none` cannot use a tool its task asks for.
 * A person saves and starts (through the management client) a definition whose one agent node has `tools: none` and a
 * task that asks it to fetch a web page with web_fetch, and, when it has no tool to fetch with, to say so in its typed
 * output. The node's agent session runs on the real model.
 *
 * PASS: the node's session made no tool call but complete_workflow_node (no web_fetch, no other tool); its state ended by the
 * agent's own completion (winner agent), so the one tool it keeps worked; the Workflow ended. What the model said it
 * fetched is recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run with PS_WORKFLOW_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_REAL_MODEL_RECEIPT when set; a summary is printed. One agent node visit.
 *
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-agent-tool-limit-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-agent-tool-limit-real-model" };
const PERSON = { provider: "test", subject: "ada", displayName: "Ada Lovelace" };
const NAME = "no-tools-probe";
const RUN_MS = 300_000;
const TEST_TIMEOUT = 10 * 60_000;
const ENDED = new Set(["completed", "failed", "cancelled", "stopped"]);

const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${NAME}, version: "1.0.0" }
initial: fetch
schemas:
  Fetched: { type: object, required: [fetched, why], properties: { fetched: { type: boolean }, why: { type: string } }, additionalProperties: false }
states:
  fetch:
    type: agent
    tools: none
    invoke:
      prompt: >-
        Fetch https://example.com with the web_fetch tool and read its page title. Then finish this step with outcome done and
        output { fetched: true, why: <the title> }. If you have no tool that can fetch it, do not try another way: finish with
        outcome done and output { fetched: false, why: <one sentence> }.
    outputSchema: { $ref: "#/schemas/Fetched" }
    timeoutSeconds: 240
    transition: { next: { done: finish, failure: failed } }
  finish: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function until(read, label, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "an agent node with tools: none makes no tool call but complete_workflow_node, and finishes its step with it";

describe("FU-17: an agent node's tool limit, on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-agent-tool-limit-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, steps: {}, verdict: null };
        const env = createTestEnv("workflow-agent-tool-limit-real-model");
        let mgmt = null;
        try {
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, workflowCommands: {} });
                await mgmt.start();
                const catalog = client._catalog;
                const store = catalog.workflowStore();
                const session = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });

                // The person saves and starts it: no session turn is needed to author it.
                const saved = await mgmt.saveSessionWorkflowDefinition(session.sessionId, { name: NAME, yaml: YAML, operationId: `save-${randomUUID()}` },
                    { principal: PERSON });
                receipt.steps.save = { revision: saved.revision, valid: saved.valid };
                expect(saved.valid, JSON.stringify(saved)).toBe(true);
                const started = await mgmt.startSessionWorkflowDefinition(session.sessionId, { definitionId: saved.definitionId, operationId: `start-${randomUUID()}` },
                    { principal: PERSON });
                receipt.steps.start = { workflowId: started.workflowId, runId: started.runId, revision: started.revision };

                const run = await until(async () => {
                    const row = await store.readRun(started.runId);
                    return row && ENDED.has(row.status) ? row : null;
                }, "the Workflow ends", RUN_MS);
                const nodes = await store.listNodeExecutions(started.runId);
                const visit = nodes.find(node => node.nodeId === "fetch") ?? null;
                const invocation = visit ? await store.readAgentInvocation(visit.nodeExecutionId) : null;
                const childId = invocation?.childSessionId ?? null;
                const toolCalls = childId === null ? [] : (await catalog.getSessionEvents(childId, 0, 5_000, ["tool.execution_start"]))
                    .map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                receipt.steps.run = { status: run.status, outcome: run.terminalOutcome, visit: visit && { outcome: visit.outcome, winner: visit.winner,
                    resultKind: visit.resultKind, output: visit.output }, childSessionId: childId, toolCalls };
                expect(childId, JSON.stringify(receipt)).toBeTruthy();
                // The limit: no tool call but the one the state keeps.
                expect(toolCalls.filter(name => name !== "complete_workflow_node"), JSON.stringify(receipt)).toEqual([]);
                expect(toolCalls).not.toContain("web_fetch");
                // The one tool it keeps worked: the agent's own completion decided the state.
                expect(visit, JSON.stringify(receipt)).toMatchObject({ state: "completed", winner: "agent" });
                expect(ENDED.has(run.status)).toBe(true);
                receipt.verdict = "PASS";
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-agent-tool-limit-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await mgmt?.stop().catch(() => {});
            await env.cleanup();
        }
    });
});
