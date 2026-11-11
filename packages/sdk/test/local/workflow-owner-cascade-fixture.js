import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { testTime } from "../helpers/local-env.js";
import { registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { startSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { resolveStorageConfig } from "../../src/storage-config.ts";
import { getDuroxideStorageProvider } from "../../src/storage-providers.ts";

const { Runtime, Client } = createRequire(import.meta.url)("duroxide");
export const CASCADE_OWNER = { provider: "test", subject: "workflow-owner-cascade" };
export const CASCADE_ACTOR = { kind: "system", name: "workflow-owner-cascade-tests" };
export const CASCADE_TIMEOUT = testTime.ms(180_000);
export const ACTIVE_RUNS = ["admitted", "running", "paused"];
export const WORKFLOW_SESSION_END_STATE = "cancelled";

export const waitYaml = name => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 3600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

export const terminalYaml = (name, outcome) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: done
states:
  done: { type: terminal, outcome: ${outcome} }
`;

/** Real Workflow registrations, catalog and native runtime; no model or substitute controller. */
export async function openOwnerCascadeRuntime(env) {
    const h = await openWorkflowStore(env);
    let runtime;
    try {
        const storage = resolveStorageConfig({ options: {
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
        } });
        const provider = await getDuroxideStorageProvider(storage.duroxide.provider).createDuroxideProvider(storage.duroxide);
        const client = new Client(provider);
        runtime = new Runtime(provider, {
            dispatcherPollIntervalMs: 10, logLevel: "error",
            workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        });
        registerWorkflow(runtime, {
            store: h.store, catalog: h.catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("These Workflows call no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => { throw new Error("These Workflows notify no parent."); },
            deleteSession: id => h.catalog.softDeleteSession(id),
            sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
            wakeBackstopMs: 100,
            testPollMs: 50,
        });
        await runtime.start();
        const host = { catalog: h.catalog, store: h.store, duroxideClient: client, scripts: true };
        return {
            ...h, host, client, runtime,
            async stop() {
                try { await runtime.shutdown(100); } finally { await h.stop(); }
            },
        };
    } catch (error) {
        try { if (runtime) await runtime.shutdown(100); } finally { await h.stop(); }
        throw error;
    }
}

export async function saveCascadeDefinition(host, ownerId, name, yaml = waitYaml(name)) {
    const saved = (await saveSessionWorkflowDefinition(host, {
        ownerSessionId: ownerId, name, yaml, expected: null,
        actor: { kind: "session", sessionId: ownerId }, operationId: `save-${randomUUID()}`, by: "session",
    })).receipt;
    expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
    return saved;
}

export async function startCascadeLive(host, ownerId, name, yaml = waitYaml(name)) {
    const saved = await saveCascadeDefinition(host, ownerId, name, yaml);
    const started = await startSessionWorkflowDefinition(host, {
        ownerSessionId: ownerId, definition: { definitionId: saved.definitionId }, inputs: {},
        actor: CASCADE_ACTOR, operationId: `start-${randomUUID()}`, notifyParent: false,
    });
    expect(started.runId).toBeTruthy();
    return { ...started, definitionId: saved.definitionId, ...(await host.store.readRun(started.runId)) };
}

export async function startCascadeBench(host, ownerId, name) {
    const saved = await saveCascadeDefinition(host, ownerId, name);
    // No waitSessionWorkflowTest: the test clock is never advanced, so the controller stays at hold.
    const bench = await startSessionWorkflowTest(host, {
        ownerSessionId: ownerId, definition: { definitionId: saved.definitionId }, inputs: {}, fixtures: [],
        actor: CASCADE_ACTOR, operationId: `test-${randomUUID()}`,
        owner: async () => CASCADE_OWNER, binding: async () => null,
    });
    const run = await host.store.readRun(bench.runId);
    expect(run).toMatchObject({ mode: "test", controllerInstanceId: `wft-${bench.runId}` });
    expect(await host.catalog.getSession(bench.testId)).toMatchObject({
        sessionKind: "workflow", serviceKind: "workflow-test", parentSessionId: ownerId,
    });
    return { ...run, workflowId: bench.testId, definitionId: saved.definitionId };
}

export async function pendingCascadeNode(store, run) {
    await expect.poll(async () => (await store.listNodeExecutions(run.runId)).filter(node => node.state === "pending").length,
        { timeout: testTime.ms(30_000) }).toBeGreaterThan(0);
    expect((await store.readRun(run.runId)).status).toBe("running");
    return (await store.listNodeExecutions(run.runId)).find(node => node.state === "pending");
}

export async function cascadeControllerEnded(client, run) {
    await expect.poll(async () => (await client.getStatus(run.controllerInstanceId)).status,
        { timeout: CASCADE_TIMEOUT }).not.toMatch(/^(Running|Pending)$/);
}

/** The same oracle is exercised against an active fixture before every end; it must reject an orphan. */
export async function assertNoActiveCascadeRuns(q, workflowIds) {
    const rows = await q(`SELECT run_id, status FROM SCHEMA.workflow_runs
        WHERE workflow_session_id = ANY($1::text[]) AND status = ANY($2::text[]) ORDER BY run_id`,
    [workflowIds, ACTIVE_RUNS]);
    expect(rows, "no active run may survive its owner's end").toEqual([]);
}

export async function assertCancelledCascadeNodes(store, run, expectedMessage) {
    const nodes = await store.listNodeExecutions(run.runId);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
        expect(node).toMatchObject({ state: "completed", outcome: "cancelled", resultKind: "runtime_error" });
        expect(node.completedAt).not.toBeNull();
        if (expectedMessage !== undefined) expect(node.error).toMatchObject({ code: "cancelled", message: expectedMessage });
    }
}
