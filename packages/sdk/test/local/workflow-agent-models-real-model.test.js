/**
 * OF-S2-7 on a REAL model: one agent node mapped to a model at start completes on that model, while the session that owns
 * the Workflow is on its own model and effort (an unset node would inherit those). Local target only: a worker in this
 * process on its own test schemas and the model catalog of
 * PS_MODEL_PROVIDERS_PATH.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run with PS_WORKFLOW_REAL_MODEL_REF
 * (the session's provider:model). The node's choice: PS_WORKFLOW_AGENT_MODEL_REF (another provider:model from the same
 * catalog; default the session's model) and PS_WORKFLOW_AGENT_MODEL_EFFORT (default low, so a choice of the same model still
 * differs from the session's default effort). Asked but unable to run, it fails as BLOCKED. One start, no retry. The receipt
 * goes to PS_WORKFLOW_REAL_MODEL_RECEIPT when set; a bounded summary is printed.
 *
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> PS_WORKFLOW_AGENT_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-agent-models-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { childRecord, realModelPlan, servesModel } from "../helpers/workflow-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const OWNER = { provider: "test", subject: "workflow-agent-models-real-model", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-agent-models-real-model-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const STATE_TIMEOUT_SECONDS = 300;
const RUN_MS = (STATE_TIMEOUT_SECONDS + 120) * 1_000;
const CHILD_END_MS = 60_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const YAML = JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "agent-models-real", version: "1.0.0" },
    initialInput: { n: 7 }, initial: "classify",
    states: {
        classify: {
            type: "agent", outcomes: ["even", "odd"], timeoutSeconds: STATE_TIMEOUT_SECONDS,
            invoke: { prompt: "Your input has a whole number n. Decide whether n is even or odd, then complete this workflow state with "
                + "complete_workflow_node: outcome even or odd, and output { \"n\": <the number> }. Do not ask anyone a question." },
            transition: { next: { even: "done", odd: "done", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
}, null, 2);

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function poll(check, timeoutMs, everyMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await pause(everyMs);
    }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "an agent node mapped to a model at start completes on that model, not on its session's";

/** The node's choice, checked against the local catalog: { choice, model } or { blocked }. */
function nodeChoice() {
    const registry = catalogOrNull();
    const named = process.env.PS_WORKFLOW_AGENT_MODEL_REF?.trim() || plan.model.ref;
    const ref = registry?.normalize(named);
    const resolved = ref ? registry.resolve(ref) : null;
    if (!resolved) return { blocked: `PS_WORKFLOW_AGENT_MODEL_REF ${named} is not a model the local catalog serves.` };
    const effort = process.env.PS_WORKFLOW_AGENT_MODEL_EFFORT?.trim() || "low";
    const supported = registry.getDescriptor?.(ref)?.supportedReasoningEfforts;
    if (Array.isArray(supported) && supported.length && !supported.includes(effort)) {
        return { blocked: `${ref} does not take reasoning effort ${effort} (it takes ${supported.join(", ")}).` };
    }
    return { choice: { model: ref, reasoningEffort: effort }, model: { ref, provider: resolved.providerId, name: resolved.modelName } };
}

describe("OF-S2-7: per-node models on a real model (local target)", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: RUN_MS + CHILD_END_MS + 300_000 }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this test runs on the local target only (PS_WORKFLOW_REAL_MODEL_TARGET=local).");
        const node = nodeChoice();
        if (node.blocked) throw new Error(`BLOCKED: ${node.blocked}`);
        const receipt = { test: "workflow-agent-models-real-model", startedAt: new Date().toISOString(), session: { model: plan.model.ref, effort: plan.effort ?? null },
            chosen: node.choice, run: null, child: null, failures: [] };
        const fail = text => receipt.failures.push(text);
        const env = createTestEnv("wf-agent-models-real");
        try {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            try {
                const worker = { workerPool: "default", logLevel: "warning" };
                await withClient(env, { worker }, async (client) => {
                    const store = catalog.workflowStore();
                    // Review OF7-R1: the start's choice is checked as a worker checks it, against the owning session's catalog.
                    const host = { catalog, store, duroxideClient: client._getDuroxideClient(),
                        checkAgentModel: client._workflowAgentModelCheck() };
                    const parent = randomUUID();
                    await catalog.createSession(parent, { owner: OWNER, model: plan.model.ref, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                    const workflowSessionId = randomUUID();
                    const created = await createWorkflow(host, {
                        workflowSessionId, parentSessionId: parent, yaml: YAML, actor: ACTOR, operationId: "create", publish: true, notifyParent: false,
                        start: { inputs: {}, agentModels: { classify: node.choice } },
                    });
                    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                    const runId = created.receipt.run.runId;
                    const run = await poll(async () => {
                        const row = await store.readRun(runId);
                        return row && ENDED.includes(row.status) ? row : null;
                    }, RUN_MS);
                    receipt.run = run ? { status: run.status, outcome: run.terminalOutcome, terminal: run.terminalNodeId } : null;
                    if (!run) fail(`the run did not end within ${RUN_MS / 60_000} min`);
                    else if (run.status !== "completed" || run.terminalOutcome !== "succeeded") {
                        fail(`the run ended ${run.status} at ${run.terminalNodeId}: ${JSON.stringify(run.terminalError ?? run.terminalOutput).slice(0, 600)}`);
                    }
                    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "classify", 1);
                    const invocation = await poll(async () => {
                        const row = await store.readAgentInvocation(nodeExecutionId);
                        return row?.endSentAt ? row : null;
                    }, CHILD_END_MS) ?? await store.readAgentInvocation(nodeExecutionId);
                    if (!invocation?.childSessionId) fail("classify has no child session");
                    else {
                        const [row, events] = await Promise.all([catalog.getSession(invocation.childSessionId),
                            catalog.getSessionEvents(invocation.childSessionId, 0, 2_000)]);
                        const child = childRecord({ ...(row ?? {}), sessionId: invocation.childSessionId }, events);
                        receipt.child = { model: child.model, reasoningEffort: child.reasoningEffort, requests: child.requests, observedModels: child.observedModels };
                        if (!servesModel(child.model, node.model)) fail(`classify's child was created on ${child.model}, not ${node.model.ref}`);
                        if (child.reasoningEffort !== node.choice.reasoningEffort) fail(`classify's child has effort ${child.reasoningEffort}, not ${node.choice.reasoningEffort}`);
                        if (child.requests === 0) fail("classify's child made no model call");
                        const others = child.observedModels.filter(model => !servesModel(model, node.model));
                        if (others.length) fail(`classify's child was served by ${others.join(", ")}, not ${node.model.ref}`);
                    }
                });
            } finally {
                await catalog.close();
            }
        } finally {
            await env.cleanup();
            receipt.endedAt = new Date().toISOString();
            const path = process.env.PS_WORKFLOW_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            console.info("workflow agent models real-model receipt", JSON.stringify(receipt).slice(0, 4_000));
        }
        expect(receipt.failures, receipt.failures.join("\n")).toEqual([]);
    });
});
