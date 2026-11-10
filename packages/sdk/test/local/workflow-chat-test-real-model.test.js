/**
 * Stage 2.2's real-model scenario (spec "Order of work": "asked to test: build, test, fix, start"), on a REAL model with
 * Workflows on and a worker that runs Workflow tests: every worker serves 1.0.83's request turns, and a chat starts at the
 * latest version (1.0.83); only a request turn can test (stage 2.5):
 * 1. the chat is asked to build a definition and to test it before starting it, with no prepared answers: it saves it and
 *    tests it (workflow_definition test); the test fails, naming the tool call it had no answer for;
 * 2. it is asked to fix the test with a prepared answer for that call, test again, and start the revision once its test
 *    passes: a test of that revision passes, and a Workflow of that revision starts and ends.
 *
 * PASS: at least two tests of the definition, the first failed naming the read_facts call, a passed test of the revision
 * the Workflow runs, which ends completed; no test is a Workflow of the definition or a session list row; the chat got no
 * test notice. The model's answers and tool calls are recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run with PS_WORKFLOW_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_REAL_MODEL_RECEIPT when set; a summary is printed. Two asked turns.
 *
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-chat-test-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-chat-test-real-model" };
const NAME = "fact-count";
const TURN_MS = 360_000;
const RUN_MS = 180_000;
const TEST_TIMEOUT = 20 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);

const ASK_BUILD_AND_TEST = `Save a Workflow Definition named ${NAME}. Its one script step calls the read_facts tool with `
    + `{ "key_pattern": "wfs-test/%" } and then ends the Workflow succeeded, with the number of facts it found as its output. `
    + "Before you start it, test it with workflow_definition, with no prepared answers (no fixtures) at all. "
    + "Do not start it yet. Tell me in one line what the test said.";
const ASK_FIX_AND_START = `Test ${NAME} again, now with a prepared answer for its read_facts call (any arguments) that returns `
    + `{ "count": 0, "facts": [] }. If that test passes, start one Workflow of the revision you tested. `
    + "If it fails, fix the definition, save it, test it again, and start it only once a test passes. Tell me in one line which revision you started.";

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
const TITLE = "a real model builds a definition, tests it, fixes its test, and starts the revision that passed";

describe("An agent's test of a revision, on request (stage 2.2), on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-chat-test-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, steps: {}, verdict: null };
        const env = createTestEnv("workflow-chat-test-real-model");
        let mgmt = null;
        try {
            // Stage 2.5: a test runs only on a workflow request turn (chat-test.ts requires host.requests), so the chat starts
            // at the session version that has them, as a person's new chat does on TEST; a chat at the latest version has none.
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema });
                await mgmt.start();
                const catalog = client._catalog;
                const chatStore = catalog.workflowStore().chat;
                const store = catalog.workflowStore();
                const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                const events = types => catalog.getSessionEvents(chat.sessionId, 0, 5_000, types);
                const toolCalls = async () => (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                const definition = async () => chatStore.readDefinitionByName(chat.sessionId, NAME);
                const tests = async id => chatStore.listTests(chat.sessionId, id);

                // 1. Build and test, with no prepared answers: the test fails naming the call.
                await chat.sendAndWait(ASK_BUILD_AND_TEST, TURN_MS);
                const saved = await definition();
                const firstTests = saved ? await tests(saved.definitionId) : [];
                receipt.steps.buildAndTest = { toolCalls: await toolCalls(), revision: saved?.currentRevision ?? null,
                    tests: firstTests.map(item => ({ revision: item.revision, verdict: item.verdict, status: item.status })) };
                expect(saved, JSON.stringify(receipt)).toBeTruthy();
                expect(firstTests.length, JSON.stringify(receipt)).toBeGreaterThan(0);
                const firstTest = firstTests[firstTests.length - 1];
                expect(firstTest.verdict, JSON.stringify(receipt)).toBe("failed");
                const firstOpen = firstTest.runId ? (await store.listInterceptions(firstTest.runId, 50)).filter(item => item.state === "awaiting_parent") : [];
                receipt.steps.buildAndTest.unanswered = firstOpen.map(item => item.tool ?? item.operation);
                expect(firstOpen.map(item => item.tool), JSON.stringify(receipt)).toContain("read_facts");
                expect((await chatStore.listWorkflows({ definitionId: saved.definitionId })), JSON.stringify(receipt)).toEqual([]);

                // 2. Fix the test (a prepared answer), test again, and start the revision that passed.
                const before = (await toolCalls()).length;
                await chat.sendAndWait(ASK_FIX_AND_START, TURN_MS);
                const allTests = await tests(saved.definitionId);
                const workflows = await chatStore.listWorkflows({ definitionId: saved.definitionId });
                receipt.steps.fixAndStart = { toolCalls: (await toolCalls()).slice(before),
                    tests: allTests.map(item => ({ revision: item.revision, verdict: item.verdict, status: item.status })),
                    workflows: workflows.map(item => ({ revision: item.revision, status: item.runStatus })) };
                expect(allTests.length, JSON.stringify(receipt)).toBeGreaterThan(firstTests.length);
                expect(workflows.length, JSON.stringify(receipt)).toBe(1);
                const started = workflows[0];
                expect(allTests.some(item => item.revision === started.revision && item.verdict === "passed"), JSON.stringify(receipt)).toBe(true);
                const ended = await until(async () => {
                    const row = (await chatStore.listWorkflows({ definitionId: saved.definitionId })).find(item => item.workflowSessionId === started.workflowSessionId);
                    return row && row.runStatus && !ACTIVE.has(row.runStatus) ? row : null;
                }, "the Workflow ends", RUN_MS);
                receipt.steps.fixAndStart.ended = ended.runStatus;
                expect(ended.runStatus).toBe("completed");

                // No test is a session list row, and the chat got no test notice.
                const listed = (await mgmt.listSessions()).map(row => row.sessionId);
                for (const test of allTests) expect(listed).not.toContain(test.testId);
                const messages = (await events(["user.message"])).map(event => String(event.data?.content ?? ""));
                receipt.userMessages = messages.length;
                expect(messages.filter(text => text.includes("type=test_waiting")), JSON.stringify(receipt)).toEqual([]);
                const errors = (await events(["session.error"])).map(event => String(event.data?.message ?? ""));
                receipt.errors = errors;
                receipt.answers = (await events(["assistant.message"])).map(event => event.data?.content).filter(value => typeof value === "string" && value)
                    .map(value => value.slice(0, 300));
                expect(errors.filter(value => /No response was returned/.test(value)), JSON.stringify(receipt)).toEqual([]);
                receipt.verdict = "PASS";
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-chat-test-real-model] ${JSON.stringify(receipt)}`);
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
