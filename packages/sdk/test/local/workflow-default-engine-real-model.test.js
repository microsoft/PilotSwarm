/**
 * Always-on review AOS-F1, on a REAL model and the DEFAULT engine: a worker made with no test options (no
 * testOptions.workflowRequests, so its turns' Workflow host has no `requests: true` and compiles only script, wait,
 * messaging (receive and send) and terminal states) is asked one plain thing, first with script nodes on and then off:
 * "Set up a Workflow that waits 2 seconds and then tells me done."
 *
 * PASS, for each: the chat saved at least one revision and at least one is valid, every valid revision uses only the states
 * this engine runs (and no script node with scripts off), and no save attempt was refused or saved with WORKFLOW_NODE_TYPE_UNSUPPORTED or
 * WORKFLOW_FEATURE_UNSUPPORTED (an agent, parallel or request state). Whether the chat also starts it is recorded, not
 * judged. Every other real-model Workflow check runs the full engine (workflowRequests: true); this is the only one that
 * runs what a default deployment runs.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. Two asked turns, one per
 * worker, plus the turns any started Workflow's ending notice starts.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-default-engine-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-default-engine-real-model" };
const ASK = "Set up a Workflow that waits 2 seconds and then tells me done.";
const TURN_MS = 240_000;
const SETTLE_MS = 120_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);
const REFUSED_CODES = /WORKFLOW_NODE_TYPE_UNSUPPORTED|WORKFLOW_FEATURE_UNSUPPORTED/;
const DEFAULT_ENGINE_STATES = new Set(["script", "wait", "messaging:receive", "messaging:send", "terminal"]);

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
const TITLE = "on the default engine, a real model sets up a waiting Workflow with only the states that engine runs, scripts on and off";

describe("Workflow guidance follows the engine (AOS-F1), on a real model and the default engine", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-default-engine-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, ask: ASK, runs: {}, verdict: null };
        try {
            for (const scripts of [true, false]) {
                const label = scripts ? "scripts on" : "scripts off";
                const run = receipt.runs[label] = {};
                const env = createTestEnv(`workflow-default-engine-real-model-${scripts ? "on" : "off"}`);
                try {
                    // The default engine: no testOptions at all, so no workflowRequests (the full engine) on any turn.
                    const worker = { workflowScripts: { enabled: scripts }, logLevel: "warning" };
                    await withClient(env, { worker }, async (client) => {
                        const catalog = client._catalog;
                        const chatStore = catalog.workflowStore().chat;
                        const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                        const events = types => catalog.getSessionEvents(chat.sessionId, 0, 5_000, types);
                        await chat.sendAndWait(ASK, TURN_MS);

                        run.toolCalls = (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                        const toolResults = (await events(["tool.execution_complete"])).map(event => JSON.stringify(event.data ?? {}));
                        run.refusedInToolResults = toolResults.filter(text => REFUSED_CODES.test(text)).map(text => text.slice(0, 400));
                        const definitions = await chatStore.listDefinitions(chat.sessionId, { includeDeleted: true });
                        run.definitions = [];
                        run.valid = [];
                        for (const definition of definitions) {
                            const revisions = [];
                            for (const summary of await chatStore.listRevisions(definition.definitionId)) {
                                const row = await chatStore.readRevision(definition.definitionId, summary.revision);
                                const codes = (row?.diagnostics ?? []).filter(item => item?.severity !== "warning").map(item => item.code);
                                revisions.push({ revision: summary.revision, valid: summary.valid, errorCodes: codes });
                                if (summary.valid) {
                                    const ir = await chatStore.readRevisionIr(definition.definitionId, summary.revision);
                                    run.valid.push({ name: definition.name, revision: summary.revision, states: stateKinds(ir) });
                                }
                            }
                            run.definitions.push({ name: definition.name, revisions });
                        }
                        run.workflows = (await chatStore.listWorkflows({ ownerSessionId: chat.sessionId }))
                            .map(item => ({ revision: item.revision, status: item.runStatus }));
                        run.answer = (await events(["assistant.message"])).map(event => event.data?.content).filter(value => typeof value === "string" && value)
                            .at(-1)?.slice(0, 300) ?? null;

                        // Recorded, not judged: a Workflow it started ends and the chat settles before the worker stops.
                        run.settled = Boolean(await until(async () => {
                            const live = (await chatStore.listWorkflows({ ownerSessionId: chat.sessionId })).some(item => ACTIVE.has(item.runStatus));
                            return !live && (await catalog.getSession(chat.sessionId))?.state === "idle";
                        }, SETTLE_MS));

                        const why = JSON.stringify(receipt);
                        expect(run.definitions.flatMap(item => item.revisions).length, `${label}: a revision is saved. ${why}`).toBeGreaterThan(0);
                        expect(run.valid.length, `${label}: a valid revision. ${why}`).toBeGreaterThan(0);
                        const unsupported = run.valid.flatMap(item => item.states).filter(kind => !DEFAULT_ENGINE_STATES.has(kind) || (!scripts && kind === "script"));
                        expect(unsupported, `${label}: only states this engine runs. ${why}`).toEqual([]);
                        expect(run.definitions.flatMap(item => item.revisions).filter(item => item.errorCodes.some(code => REFUSED_CODES.test(code))),
                            `${label}: no revision saved with an unsupported state. ${why}`).toEqual([]);
                        expect(run.refusedInToolResults, `${label}: no save refused with an unsupported state. ${why}`).toEqual([]);
                    });
                } finally {
                    await env.cleanup();
                }
            }
            receipt.verdict = "PASS";
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-default-engine-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
        }
    });
});
