/**
 * Workflow controller versions (owner 2026-11-12T03:02Z: FB-005, FB-007 and FB-002 share controller 1.1.0; FB-064: a
 * running Workflow moves to the latest controller at continue-as-new, as a durable session does).
 * A run is admitted at the newest controller version. Its first execution is started (and, before it begins, recovered)
 * at the version it was admitted for: a run admitted at 1.0.0 (by the previous build) is started at 1.0.0, and a version
 * this build does not run is refused before anything is started. Every continue-as-new then moves the run to the latest
 * version, on the real Duroxide runtime; the run's stored version stays its admission version.
 *
 * Run: npx vitest run test/local/workflow-controller-versions.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { createWorkflow, dispatchWorkflowRun } from "../../src/workflow/service.ts";
import { registerWorkflow, sessionQueueTransport, WORKFLOW_CONTROLLER_NAME, WORKFLOW_CONTROLLER_VERSION } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { WORKFLOW_COMMAND_QUEUE } from "../../src/workflow/commands.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-controller-versions" };
const ACTOR = { kind: "system", name: "workflow-controller-versions-test" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: hold, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A hold long enough to outlast execution 1's 50 idle waits, and short enough to end the run in execution 2. */
const MOVING = YAML.replace("name: hold", "name: moving-hold").replace("pause: { type: wait, seconds: 30,", "pause: { type: wait, seconds: 20,");

describe("Workflow controller versions", () => {
    it("a new run is admitted and started at 1.1.0; a run admitted at 1.0.0 is started at 1.0.0; an unknown version is refused", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const starts = [];
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: {
                    startOrchestrationVersioned: async (instanceId, name, input, version) => { starts.push({ instanceId, name, input, version }); },
                    getStatus: async () => ({ status: "Running" }),
                    enqueueEvent: async () => {},
                },
            };
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            const create = async () => (await createWorkflow(host, { workflowSessionId: randomUUID(), parentSessionId: parent, yaml: YAML, actor: ACTOR,
                operationId: `create-${randomUUID()}`, publish: true, start: { inputs: {} } })).receipt;

            // A new run: admitted at the newest version, and its controller started there.
            expect(WORKFLOW_CONTROLLER_VERSION).toBe("1.1.0");
            const fresh = await create();
            const freshRun = await h.store.readRun(fresh.run.runId);
            expect(freshRun.controllerVersion).toBe("1.1.0");
            expect(starts.at(-1)).toMatchObject({ name: WORKFLOW_CONTROLLER_NAME, version: "1.1.0", input: { v: 1, runId: fresh.run.runId } });

            // A run the previous build admitted at 1.0.0: its controller is started at 1.0.0, not at the newest version.
            const older = await create();
            await h.q("UPDATE SCHEMA.workflow_runs SET controller_version = '1.0.0' WHERE run_id = $1", [older.run.runId]);
            starts.length = 0;
            await dispatchWorkflowRun(host, older);
            expect(starts).toEqual([expect.objectContaining({ name: WORKFLOW_CONTROLLER_NAME, version: "1.0.0", input: { v: 1, workflowSessionId: older.workflowSessionId, runId: older.run.runId } })]);

            // A version this build does not run: refused before anything is started.
            await h.q("UPDATE SCHEMA.workflow_runs SET controller_version = '0.9.0' WHERE run_id = $1", [older.run.runId]);
            starts.length = 0;
            let refused = null;
            try { await dispatchWorkflowRun(host, older); } catch (error) { refused = error; }
            expect(refused?.code, refused?.message).toBe("CONTROLLER_UNAVAILABLE");
            expect(refused.details).toMatchObject({ controllerVersion: "0.9.0", hostControllerVersion: "1.1.0" });
            expect(starts).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("a run admitted at 1.0.0 begins at 1.0.0, continues as new on the latest controller and ends normally there", { timeout: TIMEOUT }, async () => {
        expect(MOVING).toContain("name: moving-hold");
        expect(MOVING).toContain("seconds: 20,");
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
        registerWorkflow({
            registerActivity: (name, fn) => runtime.registerActivity(name, fn),
            registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
        }, {
            store: h.catalog.workflowStore(), catalog: h.catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => {},
            deleteSession: async sessionId => h.catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
            sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        });
        await runtime.start();
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            // Admitted by this build, then stored as the previous build admitted it: its controller is not started yet.
            const admitting = { catalog: h.catalog, store: h.store, duroxideClient: {
                startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
            } };
            const receipt = (await createWorkflow(admitting, { workflowSessionId: randomUUID(), parentSessionId: parent, yaml: MOVING, actor: ACTOR,
                operationId: `create-${randomUUID()}`, publish: true, start: { inputs: {} } })).receipt;
            const { runId, controllerInstanceId } = receipt.run;
            await h.q("UPDATE SCHEMA.workflow_runs SET controller_version = '1.0.0' WHERE run_id = $1", [runId]);
            await dispatchWorkflowRun({ catalog: h.catalog, store: h.store, duroxideClient: client }, receipt);

            // Once the hold waits, 50 wakes that bring nothing are 50 idle waits: execution 1 continues as new.
            const hold = await until(async () => {
                const node = await h.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "pause", 1));
                return node?.state === "pending" ? node : null;
            }, "the hold to wait");
            for (let wake = 0; wake < 50; wake += 1) {
                await client.enqueueEvent(controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({ type: "workflow-wake", runId, reason: `test-${wake}` }));
            }
            await until(async () => (await client.listExecutions(controllerInstanceId)).length >= 2, "a continue-as-new");
            expect(Date.now(), "VOID (not a product result): the continue-as-new was seen only after the hold's deadline; run the case again")
                .toBeLessThan(hold.deadlineAt.getTime());

            const done = await client.waitForOrchestration(controllerInstanceId, 60_000);
            expect(done.status).toBe("Completed");
            const started = async executionId => {
                const [first] = await client.readExecutionHistory(controllerInstanceId, executionId);
                expect(first.kind).toBe("OrchestrationStarted");
                return JSON.parse(first.data);
            };
            const executions = await client.listExecutions(controllerInstanceId);
            expect(executions).toEqual([1, 2]);
            expect(await started(1)).toMatchObject({ name: WORKFLOW_CONTROLLER_NAME, version: "1.0.0", input: { v: 1, runId } });
            // Execution 2 runs on the latest controller, from the state 1.0.0 carried: the hold still pending.
            const second = await started(2);
            expect(WORKFLOW_CONTROLLER_VERSION).not.toBe("1.0.0");
            expect(second).toMatchObject({ name: WORKFLOW_CONTROLLER_NAME, version: WORKFLOW_CONTROLLER_VERSION, input: { v: 1, runId } });
            expect(second.input.state.cursors).toEqual([expect.objectContaining({ nodeId: "pause", pending: hold.nodeExecutionId })]);
            expect((await client.getInstanceInfo(controllerInstanceId)).orchestrationVersion).toBe(WORKFLOW_CONTROLLER_VERSION);

            // The hold elapsed on the latest controller and the run ended normally; the run keeps its admission version.
            const run = await h.store.readRun(runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", controllerVersion: "1.0.0" });
            expect(await h.store.readNodeExecution(hold.nodeExecutionId)).toMatchObject({ outcome: "elapsed" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "pause", 2))).toBeFalsy();
        } finally {
            await runtime.shutdown(100);
            await h.stop();
        }
    });
});
