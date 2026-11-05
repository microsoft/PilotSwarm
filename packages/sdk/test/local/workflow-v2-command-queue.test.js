/**
 * Workflow v2 controllers and their command queue under duroxide 0.1.32's limits (duroxide races review, S7-DX), on the
 * real durable runtime and store.
 *
 * - DX-1: duroxide carries at most 100 unread queue messages into the next execution and drops the newer ones. Before a
 *   controller continues as new it reads the whole queue, batch by batch; a lifecycle command it finds is applied instead
 *   of continuing as new. A cancel sent once, behind more than 100 wake messages at controller 1.9.0's paused
 *   continue-as-new, ends the run.
 * - DX-2: duroxide fails a turn whose orchestration takes more than 100 queued messages in a row. A command read takes at
 *   most 32 (WORKFLOW_V2_COMMAND_READ_BATCH), then the pass goes on to its store activities. 150 wakes queued behind a
 *   held plan activity do not fail controller 1.8.0 or 1.9.0, and a cancel behind them still ends the run.
 *
 * The wakes are queued while an activity of the controller is held, so they are all queued when it goes on. No model
 * runs. Not an activation proof.
 *
 * Run: npx vitest run test/local/workflow-v2-command-queue.test.js (from packages/sdk).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_COMMAND_READ_BATCH, WORKFLOW_V2_IDLE_WAITS_PER_EXECUTION,
    WORKFLOW_V2_REQUEST_ACTIVITIES,
} from "../../src/workflow/v2/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const ACTOR = { kind: "system", name: "workflow-v2-command-queue-test" };
/** More than duroxide's 100: its carry-forward and per-turn limits. */
const WAKES = 150;

/** One wait of ten minutes: the run stays active, its cursor waiting on the controller's timer. */
const HOLD = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "command-queue", version: "1.0.0" },
    initial: "hold",
    states: {
        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
        done: { type: "terminal", outcome: "succeeded" },
    },
};

async function until(check, label, timeoutMs = 60_000, diagnose = async () => null) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}; diagnosis: ${JSON.stringify(await diagnose())}`);
}

/** A gate the test opens; `reached` resolves when code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: () => arrive(), wait: () => opened, open: () => open() };
}

/**
 * A worker-equivalent registration: controller 1.9.0 with its tagged activities when `requests`, else 1.8.0. An activity
 * named in `wrap` is wrapped (to hold it).
 */
async function harness(env, { requests, wrap = {} }) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", ...(requests ? { workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } } : {}),
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, wrap[name] ? wrap[name](fn) : fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        ...(requests ? { workflowRequests: true, sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" } } : {}),
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client, ...(requests ? { requests: true } : {}) },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A started run of HOLD: its workflow session, run and controller instance. */
async function started(h) {
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, { workflowSessionId, parentSessionId: null, yaml: JSON.stringify(HOLD, null, 2), actor: ACTOR,
        operationId: "start", start: { inputs: {} } });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { workflowSessionId, runId: created.receipt.run.runId, controller: created.receipt.run.controllerInstanceId };
}

/** Queue `count` wakes (hints only) to the controller, in order. */
async function queueWakes(h, controller, runId, count) {
    for (let n = 0; n < count; n += 1) {
        await h.client.enqueueEvent(controller, "messages", JSON.stringify({ type: "workflow-wake", runId, reason: `test-${n}` }));
    }
}

/** The controller's status, executions and the last events of its latest execution, for a failure's message. */
function diagnosis(h, controller) {
    return async () => {
        const status = await h.client.getStatus(controller).catch(error => ({ unread: String(error?.message ?? error) }));
        const executions = await h.client.listExecutions(controller).catch(() => []);
        const history = executions.length ? await h.client.readExecutionHistory(controller, executions.at(-1)).catch(() => []) : [];
        return { status, executions, last: history.slice(-8) };
    };
}

const ended = (h, runId, diagnose) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`, 90_000, diagnose);

describe("workflow v2 controllers and their command queue (duroxide races review S7-DX; 1.9.0 test-only)", () => {
    // DX-1: the paused loop counts a wait for each wake it takes, and continues as new at its 50th. With 150 wakes queued
    // while it is held, about 100 of them and the cancel behind them are still unread then: more than duroxide carries.
    it("DX-1: a cancel sent once behind more than 100 wakes at the paused continue-as-new is applied there", { timeout: TIMEOUT }, async () => {
        const R = WORKFLOW_V2_REQUEST_ACTIVITIES;
        let hold = null;
        const h = await harness(getEnv(), { requests: true, wrap: {
            [R.collect]: fn => async (ctx, input) => {
                const held = hold;
                if (held) { hold = null; held.arrive(); await held.wait(); }
                return fn(ctx, input);
            },
        } });
        try {
            const { workflowSessionId, runId, controller } = await started(h);
            const diagnose = diagnosis(h, controller);
            await until(async () => (await h.store.listNodeExecutions(runId)).some(node => node.nodeId === "hold" && node.state === "pending") || null,
                "the wait to start", 60_000, diagnose);
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "hold still" },
                { actor: ACTOR, operationId: "pause-1" });
            await until(async () => (await h.store.readRun(runId))?.status === "paused" || null, "the pause", 30_000, diagnose);
            // Hold the paused loop's next collection, then queue the wakes and the cancel (sent once) behind them.
            const held = gate();
            hold = held;
            await held.reached;
            const executions = (await h.client.listExecutions(controller)).length;
            await queueWakes(h, controller, runId, WAKES);
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "behind the wakes" },
                { actor: ACTOR, operationId: "cancel-1" });
            held.open();
            const run = await ended(h, runId, diagnose);
            expect(run.status, JSON.stringify(await diagnose())).toBe("cancelled");
            // The cancel was read where the controller would have continued as new (its 50th wait came with more than 100
            // wakes still queued): it was applied there, in the same execution, and nothing was sent again.
            expect(WAKES - WORKFLOW_V2_IDLE_WAITS_PER_EXECUTION).toBeGreaterThanOrEqual(100);
            expect((await h.client.listExecutions(controller)).length).toBe(executions);
            expect((await h.client.waitForOrchestration(controller, 30_000)).status).toBe("Completed");
        } finally {
            await h.stop();
        }
    });

    for (const [version, requests, R] of [["1.8.0", false, WORKFLOW_V2_ACTIVITIES], ["1.9.0", true, WORKFLOW_V2_REQUEST_ACTIVITIES]]) {
        it(`DX-2 (${version}): ${WAKES} wakes queued behind a held plan do not fail the controller; a cancel behind them still ends the run`,
            { timeout: TIMEOUT }, async () => {
                const plan = gate();
                let planned = false;
                const h = await harness(getEnv(), { requests, wrap: {
                    [R.plan]: fn => async (ctx, input) => {
                        if (!planned) { planned = true; plan.arrive(); await plan.wait(); }
                        return fn(ctx, input);
                    },
                } });
                try {
                    const { runId, controller } = await started(h);
                    const diagnose = diagnosis(h, controller);
                    // The run has begun (its plan comes after its begin), so the cancel goes to the controller's queue.
                    await plan.reached;
                    await queueWakes(h, controller, runId, WAKES);
                    await h.client.enqueueEvent(controller, "messages",
                        JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "behind the wakes" } }));
                    plan.open();
                    const run = await ended(h, runId, diagnose);
                    expect(run.status, JSON.stringify(await diagnose())).toBe("cancelled");
                    // No turn took more than a batch: the controller ended normally, not with duroxide's quiescence failure.
                    expect(WORKFLOW_V2_COMMAND_READ_BATCH).toBeLessThan(100);
                    const status = await h.client.waitForOrchestration(controller, 30_000);
                    expect(status.status, JSON.stringify(status)).toBe("Completed");
                } finally {
                    await h.stop();
                }
            });
    }
});
