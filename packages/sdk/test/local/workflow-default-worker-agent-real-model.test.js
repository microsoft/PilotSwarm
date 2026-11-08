/**
 * The full Workflow engine on a DEFAULT worker, on a REAL model (owner decision 2026-11-08T15:30Z): a worker made with no
 * test options (as every deployment's is) serves controller 1.9.0 and session orchestration 1.0.83, so a chat started
 * there builds and runs a Workflow with an agent step. Asked once, with script nodes off (a default deployment's setting):
 * "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku."
 *
 * PASS: the chat is at the latest version (1.0.83); it saved a valid revision with at least one agent state; no save or
 * start was refused (WORKFLOW_NODE_TYPE_UNSUPPORTED, WORKFLOW_FEATURE_UNSUPPORTED, CONTROLLER_UNAVAILABLE); a Workflow of
 * it started at controller 1.9.0 and completed, through an agent node's chat. The answer is recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. One asked turn, the agent
 * node's turn, and the turn the Workflow's ending notice starts.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-default-worker-agent-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";
import { WORKFLOW_V2_MILESTONE_IR_VERSION } from "../../src/workflow/v2/compiler.ts";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-default-worker-agent-real-model" };
const ASK = "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku.";
const TURN_MS = 300_000;
const RUN_MS = 300_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);
const REFUSED_CODES = /WORKFLOW_NODE_TYPE_UNSUPPORTED|WORKFLOW_FEATURE_UNSUPPORTED|CONTROLLER_UNAVAILABLE/;

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function until(read, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) return null;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/** Every state of an IR, a parallel body's or branch's included, as `type` (`messaging:<mode>` for a messaging state). */
function stateKinds(ir) {
    const kinds = [];
    const visit = nodes => {
        for (const node of Object.values(nodes ?? {})) {
            kinds.push(node.type === "messaging" ? `messaging:${node.mode}` : node.type);
            if (node.body?.nodes) visit(node.body.nodes);
            for (const branch of Object.values(node.branches ?? {})) visit(branch?.nodes);
        }
    };
    visit(ir?.nodes);
    return kinds;
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "a default worker: a real model builds and runs a Workflow with an agent step (scripts off)";

describe("the full Workflow engine on a default worker, on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-default-worker-agent-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, ask: ASK, steps: {}, verdict: null };
        const env = createTestEnv("workflow-default-worker-agent-real-model");
        try {
            // A default worker: no test options; script nodes off, as a default deployment.
            const worker = { workflowScripts: { enabled: false }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                const catalog = client._catalog;
                const chatStore = catalog.workflowStore().chat;
                const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                const events = types => catalog.getSessionEvents(chat.sessionId, 0, 5_000, types);
                receipt.steps.chatVersion = await sessionOrchestrationVersion(client, chat.sessionId);
                await chat.sendAndWait(ASK, TURN_MS);

                receipt.steps.toolCalls = (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                receipt.steps.refused = (await events(["tool.execution_complete"])).map(event => JSON.stringify(event.data ?? {}))
                    .filter(text => REFUSED_CODES.test(text)).map(text => text.slice(0, 400));
                const valid = [];
                for (const definition of await chatStore.listDefinitions(chat.sessionId, { includeDeleted: true })) {
                    for (const summary of await chatStore.listRevisions(definition.definitionId)) {
                        if (!summary.valid) continue;
                        const ir = await chatStore.readRevisionIr(definition.definitionId, summary.revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
                        valid.push({ name: definition.name, revision: summary.revision, states: stateKinds(ir) });
                    }
                }
                receipt.steps.valid = valid;
                const ended = await until(async () => {
                    const rows = await chatStore.listWorkflows({ ownerSessionId: chat.sessionId });
                    return rows.length > 0 && rows.every(row => row.runStatus && !ACTIVE.has(row.runStatus)) ? rows : null;
                }, RUN_MS);
                receipt.steps.workflows = (ended ?? await chatStore.listWorkflows({ ownerSessionId: chat.sessionId }))
                    .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
                const runs = [];
                for (const row of receipt.steps.workflows) {
                    const run = (await catalog.pool.query(`SELECT controller_version FROM "${env.cmsSchema}".workflow_runs WHERE workflow_session_id = $1`,
                        [row.id])).rows[0];
                    runs.push(run?.controller_version ?? null);
                }
                receipt.steps.controllerVersions = runs;
                receipt.steps.answer = (await events(["assistant.message"])).map(event => event.data?.content)
                    .filter(value => typeof value === "string" && value).at(-1)?.slice(0, 300) ?? null;

                const why = JSON.stringify(receipt);
                expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
                expect(valid.some(item => item.states.includes("agent")), `a valid revision with an agent state. ${why}`).toBe(true);
                expect(receipt.steps.refused, `no refusal. ${why}`).toEqual([]);
                expect(receipt.steps.workflows.length, `a Workflow started. ${why}`).toBeGreaterThan(0);
                expect(receipt.steps.workflows.some(row => row.status === "completed"), `a Workflow completed. ${why}`).toBe(true);
                expect(runs.every(version => version === "1.9.0"), `every run at controller 1.9.0. ${why}`).toBe(true);
            });
            receipt.verdict = "PASS";
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-default-worker-agent-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await env.cleanup();
        }
    });
});
