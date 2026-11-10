/**
 * Named branches (IR 11, owner decision 2026-11-08T00:35Z) on a REAL model: one parallel state with two named branches,
 * quick and careful, each with its own agent node mapped to its own model at start. Both run at once; each completes on
 * its own model and effort, never on the other's or the chat's; the join passes { quick: output, careful: output }.
 * Local target only: a worker in this process on its own test
 * schemas and the model catalog of PS_MODEL_PROVIDERS_PATH.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run with PS_WORKFLOW_REAL_MODEL_REF
 * (the chat's provider:model). The branches' choices: PS_WORKFLOW_AGENT_MODEL_REF (quick) and PS_WORKFLOW_AGENT_MODEL_REF_2
 * (careful), two provider:model refs of the same catalog (default: the chat's model); PS_WORKFLOW_AGENT_MODEL_EFFORT (quick,
 * default low) and PS_WORKFLOW_AGENT_MODEL_EFFORT_2 (careful, default medium), so two choices of one model still differ.
 * Asked but unable to run, it fails as BLOCKED. One start, no retry. The receipt goes to PS_WORKFLOW_REAL_MODEL_RECEIPT
 * when set; a bounded summary is printed.
 *
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> PS_WORKFLOW_AGENT_MODEL_REF=<provider:model> \
 *     PS_WORKFLOW_AGENT_MODEL_REF_2=<provider:model> npx vitest run test/local/workflow-named-branches-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { childRecord, realModelPlan, servesModel } from "../helpers/workflow-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { branchScopeId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const OWNER = { provider: "test", subject: "workflow-named-branches-real-model", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-named-branches-real-model-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const STATE_TIMEOUT_SECONDS = 300;
const RUN_MS = (STATE_TIMEOUT_SECONDS + 120) * 1_000;
const CHILD_END_MS = 60_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const PROMPT = "Your input has a whole number n. Decide whether n is even or odd, then complete this workflow state with "
    + "complete_workflow_node: outcome even or odd, and output { \"n\": <the number> }. Do not ask anyone a question.";
const lane = (name, number) => ({
    initial: `${name}_classify`,
    input: { n: number },
    states: {
        [`${name}_classify`]: {
            type: "agent", outcomes: ["even", "odd"], timeoutSeconds: STATE_TIMEOUT_SECONDS, invoke: { prompt: PROMPT },
            transition: { next: { even: `${name}_done`, odd: `${name}_done`, failure: `${name}_failed` } },
        },
        [`${name}_done`]: { type: "terminal", outcome: "succeeded", output: { branch: "${branch.name}", n: "${input.n}" } },
        [`${name}_failed`]: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
});
const YAML = JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "named-branches-real", version: "1.0.0" },
    initial: "views",
    states: {
        views: {
            type: "parallel", timeoutSeconds: STATE_TIMEOUT_SECONDS + 60,
            branches: { quick: lane("quick", 7), careful: lane("careful", 12) },
            transition: { next: { joined: "done", blocked: "failed", timed_out: "failed", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${input}" },
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
const TITLE = "two named branches run at once, each agent node on the model chosen for it at start, and join by name";

/** A branch's choice, checked against the local catalog: { choice, model } or { blocked }. */
function choiceOf(refVariable, effortVariable, defaultEffort) {
    const registry = catalogOrNull();
    const named = process.env[refVariable]?.trim() || plan.model.ref;
    const ref = registry?.normalize(named);
    const resolved = ref ? registry.resolve(ref) : null;
    if (!resolved) return { blocked: `${refVariable} ${named} is not a model the local catalog serves.` };
    const effort = process.env[effortVariable]?.trim() || defaultEffort;
    const supported = registry.getDescriptor?.(ref)?.supportedReasoningEfforts;
    if (Array.isArray(supported) && supported.length && !supported.includes(effort)) {
        return { blocked: `${ref} does not take reasoning effort ${effort} (it takes ${supported.join(", ")}).` };
    }
    return { choice: { model: ref, reasoningEffort: effort }, model: { ref, provider: resolved.providerId, name: resolved.modelName } };
}

describe("named branches on a real model, two branches on two models (local target)", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: RUN_MS + CHILD_END_MS + 300_000 }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this test runs on the local target only (PS_WORKFLOW_REAL_MODEL_TARGET=local).");
        const branches = {
            quick: choiceOf("PS_WORKFLOW_AGENT_MODEL_REF", "PS_WORKFLOW_AGENT_MODEL_EFFORT", "low"),
            careful: choiceOf("PS_WORKFLOW_AGENT_MODEL_REF_2", "PS_WORKFLOW_AGENT_MODEL_EFFORT_2", "medium"),
        };
        for (const [name, branch] of Object.entries(branches)) if (branch.blocked) throw new Error(`BLOCKED: ${name}: ${branch.blocked}`);
        if (branches.quick.choice.model === branches.careful.choice.model && branches.quick.choice.reasoningEffort === branches.careful.choice.reasoningEffort) {
            throw new Error("BLOCKED: the two branches' choices are the same; give them two models or two efforts.");
        }
        const receipt = { test: "workflow-named-branches-real-model", startedAt: new Date().toISOString(),
            chat: { model: plan.model.ref, effort: plan.effort ?? null },
            chosen: { quick: branches.quick.choice, careful: branches.careful.choice }, run: null, children: {}, failures: [] };
        const fail = text => receipt.failures.push(text);
        const env = createTestEnv("wf-named-branches-real");
        try {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            try {
                const worker = { workerPool: "default", logLevel: "warning" };
                await withClient(env, { worker }, async (client) => {
                    const store = catalog.workflowStore();
                    // Each branch's agent node is its own state id, so each takes its own entry, checked against the owning
                    // chat's catalog as a worker checks it.
                    const host = { catalog, store, duroxideClient: client._getDuroxideClient(),
                        checkAgentModel: client._workflowAgentModelCheck() };
                    const parent = randomUUID();
                    await catalog.createSession(parent, { owner: OWNER, model: plan.model.ref, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                    const workflowSessionId = randomUUID();
                    const created = await createWorkflow(host, {
                        workflowSessionId, parentSessionId: parent, yaml: YAML, actor: ACTOR, operationId: "create", publish: true, notifyParent: false,
                        start: { inputs: {}, agentModels: { quick_classify: branches.quick.choice, careful_classify: branches.careful.choice } },
                    });
                    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                    const runId = created.receipt.run.runId;
                    const run = await poll(async () => {
                        const row = await store.readRun(runId);
                        return row && ENDED.includes(row.status) ? row : null;
                    }, RUN_MS);
                    receipt.run = run ? { status: run.status, outcome: run.terminalOutcome, terminal: run.terminalNodeId, output: run.terminalOutput } : null;
                    if (!run) fail(`the run did not end within ${RUN_MS / 60_000} min`);
                    else if (run.status !== "completed" || run.terminalOutcome !== "succeeded") {
                        fail(`the run ended ${run.status} at ${run.terminalNodeId}: ${JSON.stringify(run.terminalError ?? run.terminalOutput).slice(0, 600)}`);
                    } else {
                        // The join passes each branch's output by its name. A map's keys have no order: the store keeps its
                        // canonical JSON (keys sorted), so it is compared by its keys, exactly the two branches, and their values.
                        const output = run.terminalOutput;
                        const keys = output !== null && typeof output === "object" && !Array.isArray(output) ? Object.keys(output).sort() : null;
                        if (!isDeepStrictEqual(keys, ["careful", "quick"])) {
                            fail(`the joined output's keys are ${JSON.stringify(keys)}, not exactly careful and quick: ${JSON.stringify(output).slice(0, 600)}`);
                        } else if (!isDeepStrictEqual(output.quick, { branch: "quick", n: 7 }) || !isDeepStrictEqual(output.careful, { branch: "careful", n: 12 })) {
                            fail(`the joined output is ${JSON.stringify(output).slice(0, 600)}, not each branch's output by its name`);
                        }
                    }
                    const views = nodeExecutionIdFor(runId, "root", "views", 1);
                    const spans = [];
                    for (const [index, name] of ["quick", "careful"].entries()) {
                        const nodeExecutionId = nodeExecutionIdFor(runId, branchScopeId(views, index), `${name}_classify`, 1);
                        const invocation = await poll(async () => {
                            const row = await store.readAgentInvocation(nodeExecutionId);
                            return row?.endSentAt ? row : null;
                        }, CHILD_END_MS) ?? await store.readAgentInvocation(nodeExecutionId);
                        if (!invocation?.childSessionId) { fail(`${name}_classify has no child session`); continue; }
                        const [row, events] = await Promise.all([catalog.getSession(invocation.childSessionId),
                            catalog.getSessionEvents(invocation.childSessionId, 0, 2_000)]);
                        const child = childRecord({ ...(row ?? {}), sessionId: invocation.childSessionId }, events);
                        const want = branches[name];
                        receipt.children[name] = { model: child.model, reasoningEffort: child.reasoningEffort, requests: child.requests,
                            observedModels: child.observedModels };
                        if (!servesModel(child.model, want.model)) fail(`${name}_classify's child was created on ${child.model}, not ${want.model.ref}`);
                        if (child.reasoningEffort !== want.choice.reasoningEffort) {
                            fail(`${name}_classify's child has effort ${child.reasoningEffort}, not ${want.choice.reasoningEffort}`);
                        }
                        if (child.requests === 0) fail(`${name}_classify's child made no model call`);
                        const others = child.observedModels.filter(model => !servesModel(model, want.model));
                        if (others.length) fail(`${name}_classify's child was served by ${others.join(", ")}, not ${want.model.ref}`);
                        const node = await store.readNodeExecution(nodeExecutionId);
                        if (node) spans.push({ name, enteredAt: node.enteredAt.getTime(), completedAt: node.completedAt?.getTime() ?? null });
                    }
                    // Both at once: each branch's agent node entered before the other one ended.
                    if (spans.length === 2 && spans.every(span => span.completedAt !== null)) {
                        const [a, b] = spans;
                        receipt.overlapped = a.enteredAt < b.completedAt && b.enteredAt < a.completedAt;
                        if (!receipt.overlapped) fail("the two branches' agent nodes did not run at the same time");
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
            console.info("workflow named branches real-model receipt", JSON.stringify(receipt).slice(0, 4_000));
        }
        expect(receipt.failures, receipt.failures.join("\n")).toEqual([]);
    });
});
