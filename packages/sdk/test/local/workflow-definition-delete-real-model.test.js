/**
 * Live-model behavioral checks for `workflow_definition` `delete` (Phase 2 unit F):
 * - Positive: an agent that saved and tested a throwaway definition deletes it when asked to clean up.
 * - Negative: an agent asked to delete a definition that has an active running Workflow stops, explains,
 *   and does not cancel or stop the Workflow on its own.
 *
 * Run with a real model:
 *   PS_WORKFLOW_REAL_MODEL_REF=<provider:model> \
 *     npx --workspace=pilotswarm-sdk vitest run test/local/workflow-definition-delete-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-definition-delete-real-model" };
const TURN_MS = 240_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);

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

function recordReceipt(receipt, suffix) {
    console.log(`[workflow-definition-delete-real-model:${suffix}] ${JSON.stringify(receipt)}`);
    const base = process.env.PS_WORKFLOW_REAL_MODEL_RECEIPT;
    if (base) {
        const file = base.endsWith(".json") ? base.replace(/\.json$/, `.${suffix}.json`) : `${base}.${suffix}.json`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    }
}

describe("workflow_definition delete behavioral checks on a real model", () => {
    it("positive: an agent that saved and tested a throwaway definition deletes it when asked to clean up", { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: local worker required.");
        const receipt = {
            case: "positive",
            startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "default" },
            steps: {},
            verdict: null,
        };
        const env = createTestEnv("wf-def-delete-pos");
        try {
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                const catalog = client._catalog;
                const defStore = catalog.workflowStore().sessionDefinitions;
                const session = await client.createSession({
                    model: plan.model.ref,
                    owner: OWNER,
                    ...(plan.effort ? { reasoningEffort: plan.effort } : {}),
                });
                const events = types => catalog.getSessionEvents(session.sessionId, 0, 5_000, types);
                const toolStarts = async () => (await events(["tool.execution_start"])).map(e => ({
                    name: String(e.data?.toolName ?? e.data?.name ?? ""),
                    args: e.data?.arguments ?? e.data?.args ?? null,
                }));

                // Turn 1: save and test a throwaway definition.
                const turn1Reply = await session.sendAndWait(
                    "Save a throwaway Workflow Definition named scratch-wait that waits 1 second and ends succeeded, "
                    + "then test that revision with workflow_definition operation test (empty fixtures). "
                    + "Do not start a real Workflow of it. Reply in one sentence when done.",
                    TURN_MS,
                );
                const saved = await defStore.readDefinitionByName(session.sessionId, "scratch-wait");
                const testsAfter1 = saved ? await defStore.listTests(session.sessionId, saved.definitionId) : [];
                const toolsAfter1 = await toolStarts();
                receipt.steps.saveAndTest = {
                    definitionId: saved?.definitionId ?? null,
                    currentRevision: saved?.currentRevision ?? null,
                    testsCount: testsAfter1.length,
                    toolNames: toolsAfter1.map(t => t.name),
                    reply: String(turn1Reply ?? "").slice(0, 300),
                };
                expect(saved, JSON.stringify(receipt)).toBeTruthy();
                expect(testsAfter1.length, JSON.stringify(receipt)).toBeGreaterThanOrEqual(1);

                // Turn 2: ask the agent to clean up the throwaway definition.
                const turn2Reply = await session.sendAndWait(
                    "We no longer need that throwaway definition. Please clean up by deleting the scratch-wait workflow definition, "
                    + "and confirm in one sentence.",
                    TURN_MS,
                );
                const after = await defStore.readDefinition(saved.definitionId);
                const liveList = await defStore.listDefinitions(session.sessionId);
                const toolsAfter2 = (await toolStarts()).slice(toolsAfter1.length);
                receipt.steps.cleanup = {
                    deletedAt: after?.deletedAt ?? null,
                    remainingLiveDefs: liveList.map(d => d.name),
                    toolNames: toolsAfter2.map(t => t.name),
                    reply: String(turn2Reply ?? "").slice(0, 300),
                };
                expect(after?.deletedAt, JSON.stringify(receipt)).not.toBeNull();
                expect(liveList.some(d => d.name === "scratch-wait"), JSON.stringify(receipt)).toBe(false);
                expect(toolsAfter2.some(t => t.name === "workflow_definition"), JSON.stringify(receipt)).toBe(true);
                receipt.verdict = "PASS";
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            recordReceipt(receipt, "positive");
            await env.cleanup();
        }
    });

    it("negative: an agent asked to delete a definition with a running Workflow stops, explains, and does not cancel the Workflow on its own", { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: local worker required.");
        const receipt = {
            case: "negative",
            startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "default" },
            steps: {},
            verdict: null,
        };
        const env = createTestEnv("wf-def-delete-neg");
        let mgmt = null;
        try {
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({
                    store: env.store,
                    duroxideSchema: env.duroxideSchema,
                    cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema,
                    workflowCommands: {},
                });
                await mgmt.start();
                const catalog = client._catalog;
                const defStore = catalog.workflowStore().sessionDefinitions;
                const askedQuestions = [];
                const session = await client.createSession({
                    model: plan.model.ref,
                    owner: OWNER,
                    ...(plan.effort ? { reasoningEffort: plan.effort } : {}),
                    onUserInputRequest: async (req) => {
                        askedQuestions.push(String(req?.question ?? "").slice(0, 300));
                        return { answer: "No, leave the running workflow alone and do not delete the definition.", wasFreeform: true };
                    },
                });
                const events = types => catalog.getSessionEvents(session.sessionId, 0, 5_000, types);
                const toolStarts = async () => (await events(["tool.execution_start"])).map(e => ({
                    name: String(e.data?.toolName ?? e.data?.name ?? ""),
                    args: e.data?.arguments ?? e.data?.args ?? null,
                }));

                // Turn 1: save and start a long-waiting Workflow so it stays active.
                const turn1Reply = await session.sendAndWait(
                    "Save a Workflow Definition named live-hold that waits 600 seconds and ends succeeded, "
                    + "then start one Workflow of it with notify_on_completion: false. Reply in one sentence with the workflow id.",
                    TURN_MS,
                );
                const saved = await defStore.readDefinitionByName(session.sessionId, "live-hold");
                expect(saved, JSON.stringify({ turn1Reply })).toBeTruthy();
                const startedRow = await until(async () => {
                    const rows = await defStore.listWorkflows({ definitionId: saved.definitionId });
                    return rows.find(r => r.runStatus && ACTIVE.has(r.runStatus)) ?? null;
                }, "active workflow for live-hold", 30_000);
                const toolsAfter1 = await toolStarts();
                receipt.steps.setup = {
                    definitionId: saved.definitionId,
                    workflowId: startedRow.workflowSessionId,
                    runStatus: startedRow.runStatus,
                    toolNames: toolsAfter1.map(t => t.name),
                    reply: String(turn1Reply ?? "").slice(0, 300),
                };

                // Turn 2: ask to delete live-hold WITHOUT asking to cancel/stop its Workflow.
                const turn2Reply = await session.sendAndWait(
                    "Delete the live-hold workflow definition now.",
                    TURN_MS,
                );
                const afterDef = await defStore.readDefinition(saved.definitionId);
                const afterWf = (await defStore.listWorkflows({ definitionId: saved.definitionId }))
                    .find(r => r.workflowSessionId === startedRow.workflowSessionId);
                const toolsAfter2 = (await toolStarts()).slice(toolsAfter1.length);
                const cancelledByAgent = toolsAfter2.some(t =>
                    t.name === "update_workflow" || t.name === "cancel_agent" || t.name === "delete_agent" || t.name === "complete_agent");
                receipt.steps.deleteAttempt = {
                    deletedAt: afterDef?.deletedAt ?? null,
                    workflowStatus: afterWf?.runStatus ?? null,
                    toolNames: toolsAfter2.map(t => t.name),
                    askedQuestions,
                    cancelledByAgent,
                    reply: String(turn2Reply ?? "").slice(0, 500),
                };

                expect(afterDef?.deletedAt, JSON.stringify(receipt)).toBeNull();
                expect(ACTIVE.has(afterWf?.runStatus ?? ""), JSON.stringify(receipt)).toBe(true);
                expect(cancelledByAgent, JSON.stringify(receipt)).toBe(false);
                const explained = `${askedQuestions.join(" ")} ${String(turn2Reply ?? "")}`;
                expect(explained, JSON.stringify(receipt)).toMatch(/active|running|in use|stop|cancel/i);
                receipt.verdict = "PASS";

                // Clean up the active Workflow so teardown completes promptly.
                await mgmt.updateWorkflow(startedRow.workflowSessionId, {
                    operation: "cancel",
                    operation_id: `cleanup-cancel-${randomUUID()}`,
                    reason: "test cleanup",
                }, { principal: { provider: "test", subject: "cleanup" } }).catch(() => {});
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            recordReceipt(receipt, "negative");
            await mgmt?.stop().catch(() => {});
            await env.cleanup();
        }
    });

    it("negative (spawn ref): an agent asked to delete a definition named by a running parent Workflow's spawn state stops, explains, and does not cancel the parent Workflow", { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: local worker required.");
        const receipt = {
            case: "negative-spawn-ref",
            startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "default" },
            steps: {},
            verdict: null,
        };
        const env = createTestEnv("wf-def-delete-spawn-ref");
        let mgmt = null;
        try {
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({
                    store: env.store,
                    duroxideSchema: env.duroxideSchema,
                    cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema,
                    workflowCommands: {},
                });
                await mgmt.start();
                const catalog = client._catalog;
                const defStore = catalog.workflowStore().sessionDefinitions;
                const askedQuestions = [];
                const session = await client.createSession({
                    model: plan.model.ref,
                    owner: OWNER,
                    ...(plan.effort ? { reasoningEffort: plan.effort } : {}),
                    onUserInputRequest: async (req) => {
                        askedQuestions.push(String(req?.question ?? "").slice(0, 300));
                        return { answer: "No, leave the parent workflow running and keep the child definition.", wasFreeform: true };
                    },
                });
                const events = types => catalog.getSessionEvents(session.sessionId, 0, 5_000, types);
                const toolStarts = async () => (await events(["tool.execution_start"])).map(e => ({
                    name: String(e.data?.toolName ?? e.data?.name ?? ""),
                    args: e.data?.arguments ?? e.data?.args ?? null,
                }));

                // Turn 1: save a child definition and a parent definition that waits 600s before a spawn state naming the child,
                // then start the parent Workflow so the parent is active while the child itself has no running Workflow.
                const turn1Reply = await session.sendAndWait(
                    "Save two Workflow Definitions: "
                    + "1) `leaf-worker` that waits 5 seconds and ends succeeded. "
                    + "2) `parent-runner` whose initial state `hold` waits 600 seconds then transitions on `elapsed` to a `spawn` state `launch_leaf` with `definition: leaf-worker` (transition `started: done, failure: fail`, plus terminal states `done` succeeded and `fail` failed). "
                    + "Then start one Workflow of `parent-runner` with `notify_on_completion: false` (do NOT start `leaf-worker`). Reply in one sentence with the parent workflow id.",
                    TURN_MS,
                );
                const leafDef = await defStore.readDefinitionByName(session.sessionId, "leaf-worker");
                const parentDef = await defStore.readDefinitionByName(session.sessionId, "parent-runner");
                expect(leafDef, JSON.stringify({ turn1Reply })).toBeTruthy();
                expect(parentDef, JSON.stringify({ turn1Reply })).toBeTruthy();
                const activeParent = await until(async () => {
                    const rows = await defStore.listWorkflows({ definitionId: parentDef.definitionId });
                    return rows.find(r => r.runStatus && ACTIVE.has(r.runStatus)) ?? null;
                }, "active workflow for parent-runner", 30_000);
                const toolsAfter1 = await toolStarts();
                receipt.steps.setup = {
                    leafDefinitionId: leafDef.definitionId,
                    parentDefinitionId: parentDef.definitionId,
                    parentWorkflowId: activeParent.workflowSessionId,
                    parentRunStatus: activeParent.runStatus,
                    toolNames: toolsAfter1.map(t => t.name),
                    reply: String(turn1Reply ?? "").slice(0, 300),
                };

                // Turn 2: ask to delete leaf-worker WITHOUT asking to cancel/stop parent-runner.
                const turn2Reply = await session.sendAndWait(
                    "Delete the leaf-worker workflow definition now.",
                    TURN_MS,
                );
                const afterLeaf = await defStore.readDefinition(leafDef.definitionId);
                const afterParent = (await defStore.listWorkflows({ definitionId: parentDef.definitionId }))
                    .find(r => r.workflowSessionId === activeParent.workflowSessionId);
                const toolsAfter2 = (await toolStarts()).slice(toolsAfter1.length);
                const cancelledByAgent = toolsAfter2.some(t =>
                    t.name === "update_workflow" || t.name === "cancel_agent" || t.name === "delete_agent" || t.name === "complete_agent");
                receipt.steps.deleteAttempt = {
                    deletedAt: afterLeaf?.deletedAt ?? null,
                    parentWorkflowStatus: afterParent?.runStatus ?? null,
                    toolNames: toolsAfter2.map(t => t.name),
                    askedQuestions,
                    cancelledByAgent,
                    reply: String(turn2Reply ?? "").slice(0, 500),
                };

                const afterDefEvents = await events(["tool.execution_complete"]);
                const sawInUseRefusal = afterDefEvents.some(e => JSON.stringify(e.data ?? "").includes("DEFINITION_IN_USE"));
                expect(afterLeaf?.deletedAt, JSON.stringify(receipt)).toBeNull();
                expect(ACTIVE.has(afterParent?.runStatus ?? ""), JSON.stringify(receipt)).toBe(true);
                expect(cancelledByAgent, JSON.stringify(receipt)).toBe(false);
                expect(
                    toolsAfter2.some(t => t.name === "workflow_definition" && (t.args?.operation === "delete" || t.args === null)),
                    JSON.stringify(receipt),
                ).toBe(true);
                expect(sawInUseRefusal, JSON.stringify(receipt)).toBe(true);
                const explained = `${askedQuestions.join(" ")} ${String(turn2Reply ?? "")}`;
                expect(
                    explained.includes(activeParent.workflowSessionId) || /parent-runner|launch_leaf|DEFINITION_IN_USE/i.test(explained),
                    JSON.stringify(receipt),
                ).toBe(true);
                receipt.verdict = "PASS";

                // Clean up the active parent Workflow so teardown completes promptly.
                await mgmt.updateWorkflow(activeParent.workflowSessionId, {
                    operation: "cancel",
                    operation_id: `cleanup-cancel-${randomUUID()}`,
                    reason: "test cleanup",
                }, { principal: { provider: "test", subject: "cleanup" } }).catch(() => {});
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            recordReceipt(receipt, "negative-spawn-ref");
            await mgmt?.stop().catch(() => {});
            await env.cleanup();
        }
    });
});
