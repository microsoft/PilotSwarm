/**
 * Stage 2.0's real-model scenario (spec "Order of work": "switch off: no surface"): a REAL model on a worker with
 * Workflows off (its `workflows.enabled: false`; scripts on, so only the switch keeps them away) is asked, in plain words,
 * to create and start a Workflow. Off means off: the model is declared no workflow tool, so it calls none, and no workflow
 * child is created; the turn completes as an ordinary turn (the model says it cannot, or does the work another way).
 *
 * PASS: no tool call named spawn_workflow, update_workflow, read_workflow or send_workflow_input; no child session of kind
 * workflow; no "No response was returned"; the chat idle. Its answer is recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. One model turn.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflows-switch-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";
import { WORKFLOW_AGENT_TOOL_NAMES } from "../../src/workflow/workflows-switch.ts";

const OWNER = { provider: "test", subject: "workflows-switch-real-model" };
const TURN_MS = 240_000;
const TEST_TIMEOUT = 10 * 60_000;

const ASK = "Create a Workflow Definition named five-second-check that waits 5 seconds and then ends, and start one Workflow of it. "
    + "Use your workflow tools if you have them. Then tell me in one line what you did.";

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "with Workflows off a real model asked to start a Workflow calls no workflow tool and creates no Workflow";

describe("Workflows switched off (stage 2.0), on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflows-switch-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, verdict: null };
        const env = createTestEnv("workflows-switch-real-model");
        try {
            const worker = { workflowScripts: { enabled: true }, workflows: { enabled: false }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                await chat.sendAndWait(ASK, TURN_MS);
                const events = types => client._catalog.getSessionEvents(chat.sessionId, 0, 2_000, types);
                const toolCalls = (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                const workflowChildren = (await client._catalog.pool.query(
                    `SELECT session_id FROM "${env.cmsSchema}".sessions WHERE parent_session_id = $1 AND session_kind = 'workflow'`, [chat.sessionId]))
                    .rows.map(row => row.session_id);
                const errors = (await events(["session.error"])).map(event => String(event.data?.message ?? ""));
                const answers = (await events(["assistant.message"])).map(event => event.data?.content).filter(text => typeof text === "string" && text);
                receipt.toolCalls = toolCalls;
                receipt.workflowToolCalls = toolCalls.filter(name => WORKFLOW_AGENT_TOOL_NAMES.includes(name));
                receipt.workflowChildren = workflowChildren;
                receipt.errors = errors;
                receipt.answers = answers.map(text => text.slice(0, 300));
                receipt.state = (await client._catalog.getSession(chat.sessionId))?.state ?? null;
                receipt.verdict = receipt.workflowToolCalls.length ? "FAIL: a workflow tool was called"
                    : workflowChildren.length ? "FAIL: a Workflow was created"
                        : errors.some(text => /No response was returned/.test(text)) ? "FAIL: the turn failed" : "PASS";
                expect(receipt.workflowToolCalls, JSON.stringify(receipt)).toEqual([]);
                expect(workflowChildren, JSON.stringify(receipt)).toEqual([]);
                expect(errors.filter(text => /No response was returned/.test(text))).toEqual([]);
                expect(receipt.state).toBe("idle");
            });
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflows-switch-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await env.cleanup();
        }
    });
});
