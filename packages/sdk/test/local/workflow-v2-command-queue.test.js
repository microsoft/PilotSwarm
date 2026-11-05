/**
 * Workflow v2 lifecycle commands as store state, and the controller's command queue under duroxide 0.1.32's limits
 * (duroxide races review S7-DX and its verification, S7-DX2), on the real durable runtime and store.
 *
 * An accepted cancel or done of a begun run ends the run in the store as it is accepted (the first run-ending commit
 * wins); a delete soft-deletes the workflow there, which ends its run. The controller's queue carries only hints: the
 * controller finds the ended run at its next store call (an admission, a collection) and does its post-end work (it stops
 * the cancelled effects, ends agent children, tells the parent, publishes its status). A command read from the queue (also
 * one an older build queued) is still applied to the run as it is.
 *
 * - V-3: a terminal-first workflow with 33 wakes and then a cancel: no state is admitted after the acceptance, and the run
 *   ends cancelled (1.8.0 and 1.9.0).
 * - V-2: wakes queued all the time do not hold back a graceful stop or the run deadline (1.9.0).
 * - DX-1: at controller 1.9.0's paused continue-as-new, a cancel behind more than 100 wakes: the run ended when the cancel
 *   was accepted, and the controller finishes.
 * - A cancel accepted while the controller is admitting the next state: no further state is admitted (1.8.0 and 1.9.0).
 * - done and delete from the parent's session (the sendCommandToSession path): done ends the run cancelled "Stopped",
 *   delete deletes the workflow; both before the controller reads anything.
 * - DX-2, R5: 150 wakes and a cancel an older build queued (only in the queue), behind a held plan: no turn reads more
 *   than 32 messages in a row, so the controller does not fail, and the queued cancel still ends the run (1.8.0, 1.9.0).
 *
 * No model runs. Not an activation proof.
 *
 * Run: npx vitest run test/local/workflow-v2-command-queue.test.js (from packages/sdk).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { applySessionCommandToWorkflowV2, controlWorkflowV2Run, createWorkflowV2, SESSION_COMMAND_OPERATION_PREFIX } from "../../src/workflow/v2/service.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_COMMAND_READ_BATCH, WORKFLOW_V2_REQUEST_ACTIVITIES,
} from "../../src/workflow/v2/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const ACTOR = { kind: "system", name: "workflow-v2-command-queue-test" };
/** More than duroxide's 100: its carry-forward and per-turn limits. */
const WAKES = 150;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });
/** One wait of ten minutes (with `limits` when given): the run stays active, its cursor waiting on the controller's timer. */
const HOLD = ({ limits } = {}) => ({
    ...head("command-queue"), ...(limits ? { limits } : {}),
    initial: "hold",
    states: {
        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
});
/** A workflow whose first state is its terminal. */
const TERMINAL_FIRST = { ...head("terminal-first"), initial: "done", states: { done: { type: "terminal", outcome: "succeeded" } } };
/** A one-second wait, then a ten-minute one. */
const TWO_WAITS = {
    ...head("two-waits"),
    initial: "first",
    states: {
        first: { type: "wait", seconds: 1, transition: { next: { elapsed: "next" } } },
        next: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
        done: { type: "terminal", outcome: "succeeded" },
    },
};

async function until(check, label, timeoutMs = 60_000, diagnose = async () => null) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
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

/** A started run of `doc` (with a parent session when `parent`): its workflow session, run and controller instance. */
async function started(h, doc, { parent = null } = {}) {
    if (parent) await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, { workflowSessionId, parentSessionId: parent, yaml: JSON.stringify(doc, null, 2), actor: ACTOR,
        operationId: "start", start: { inputs: {} } });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { workflowSessionId, runId: created.receipt.run.runId, controller: created.receipt.run.controllerInstanceId };
}

const wake = (runId, n) => JSON.stringify({ type: "workflow-wake", runId, reason: `test-${n}` });

/** Queue `count` wakes (hints only) to the controller, in order. */
async function queueWakes(h, controller, runId, count) {
    for (let n = 0; n < count; n += 1) await h.client.enqueueEvent(controller, "messages", wake(runId, n));
}

/** Queue a wake every few milliseconds until stopped: the queue is never empty for long. */
function pumpWakes(h, controller, runId) {
    let on = true;
    let sent = 0;
    const running = (async () => {
        while (on) {
            await h.client.enqueueEvent(controller, "messages", wake(runId, sent)).catch(() => undefined);
            sent += 1;
            await pause(2);
        }
    })();
    return { sent: () => sent, stop: async () => { on = false; await running; } };
}

const cancel = (h, workflowSessionId, operationId = "cancel-1") =>
    controlWorkflowV2Run(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "behind the wakes" }, { actor: ACTOR, operationId });

/** The controller's status, executions and the last events of its latest execution, for a failure's message. */
function diagnosis(h, controller) {
    return async () => {
        const status = await h.client.getStatus(controller).catch(error => ({ unread: String(error?.message ?? error) }));
        const executions = await h.client.listExecutions(controller).catch(() => []);
        const history = executions.length ? await h.client.readExecutionHistory(controller, executions.at(-1)).catch(() => []) : [];
        return { status, executions, last: history.slice(-8) };
    };
}

const ended = (h, runId, diagnose, timeoutMs = 90_000) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs, diagnose);

/** The controller completed, with the run's end as its published status. */
async function controllerFinished(h, controller, status) {
    const done = await h.client.waitForOrchestration(controller, 30_000);
    expect(done.status, JSON.stringify(done)).toBe("Completed");
    const raw = done.customStatus ?? (await h.client.getStatus(controller)).customStatus;
    expect(typeof raw === "string" ? JSON.parse(raw) : raw).toMatchObject({ status });
}

const VERSIONS = [["1.8.0", false, WORKFLOW_V2_ACTIVITIES], ["1.9.0", true, WORKFLOW_V2_REQUEST_ACTIVITIES]];

describe("workflow v2 lifecycle commands as store state (duroxide races review S7-DX2; 1.9.0 test-only)", () => {
    for (const [version, requests, R] of VERSIONS) {
        // V-3: before S7-DX2 a full read of 32 wakes returned no command, the terminal was admitted and the run completed.
        it(`V-3 (${version}): a terminal-first run with 33 wakes and then an accepted cancel admits no state and ends cancelled`, { timeout: TIMEOUT }, async () => {
            const plan = gate();
            let planned = false;
            const h = await harness(getEnv(), { requests, wrap: {
                [R.plan]: fn => async (ctx, input) => {
                    if (!planned) { planned = true; plan.arrive(); await plan.wait(); }
                    return fn(ctx, input);
                },
            } });
            try {
                const { workflowSessionId, runId, controller } = await started(h, TERMINAL_FIRST);
                const diagnose = diagnosis(h, controller);
                // The run has begun (its plan comes after its begin): the cancel ends it in the store as it is accepted.
                await plan.reached;
                await queueWakes(h, controller, runId, WORKFLOW_V2_COMMAND_READ_BATCH + 1);
                const accepted = await cancel(h, workflowSessionId);
                expect(accepted.receipt).toMatchObject({ operation: "cancel", status: "cancelled" });
                expect(await h.store.readRun(runId)).toMatchObject({ status: "cancelled",
                    terminalError: { code: "cancelled", details: { command: "cancel", accepted: true, operationId: "cancel-1" } } });
                plan.open();
                await controllerFinished(h, controller, "cancelled");
                expect(await h.store.listNodeExecutions(runId), JSON.stringify(await diagnose())).toEqual([]);
                expect(await h.store.readRun(runId)).toMatchObject({ status: "cancelled", terminalNodeId: null });
            } finally {
                plan.open();
                await h.stop();
            }
        });

        it(`(${version}): a cancel accepted while the controller admits the next state: no further state is admitted`, { timeout: TIMEOUT }, async () => {
            const admit = gate();
            let held = false;
            const h = await harness(getEnv(), { requests, wrap: {
                [R.enter]: fn => async (ctx, input) => {
                    if (!held && input?.nodeId === "next") { held = true; admit.arrive(); await admit.wait(); }
                    return fn(ctx, input);
                },
            } });
            try {
                const { workflowSessionId, runId, controller } = await started(h, TWO_WAITS);
                // The controller is in the middle of its admission of "next": the cancel is accepted before that admission's store call.
                await admit.reached;
                await cancel(h, workflowSessionId);
                expect((await h.store.readRun(runId)).status).toBe("cancelled");
                admit.open();
                await controllerFinished(h, controller, "cancelled");
                expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId)).toEqual(["first"]);
            } finally {
                admit.open();
                await h.stop();
            }
        });

        // DX-2 and R5: a cancel an older build queued is only in the queue; the controller still applies it when it reads it.
        it(`DX-2, R5 (${version}): ${WAKES} wakes and a queued cancel behind a held plan do not fail the controller; the cancel ends the run`,
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
                    const { runId, controller } = await started(h, HOLD());
                    const diagnose = diagnosis(h, controller);
                    await plan.reached;
                    await queueWakes(h, controller, runId, WAKES);
                    await h.client.enqueueEvent(controller, "messages",
                        JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "queued by an older build" } }));
                    plan.open();
                    const run = await ended(h, runId, diagnose);
                    expect(run.status, JSON.stringify(await diagnose())).toBe("cancelled");
                    // No turn read more than a batch: the controller ended normally, not with duroxide's quiescence failure.
                    expect(WORKFLOW_V2_COMMAND_READ_BATCH).toBeLessThan(100);
                    await controllerFinished(h, controller, "cancelled");
                } finally {
                    plan.open();
                    await h.stop();
                }
            });
    }

    // V-2: the queue is never empty, so every wait of the controller ends with a wake at once.
    it("V-2 (1.9.0): wakes queued all the time hold back neither a graceful stop nor the run deadline", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), { requests: true });
        try {
            // A graceful stop with no grace: the wait is pending, so it ends the run stopped at once.
            const stopped = await started(h, HOLD());
            await until(async () => (await h.store.listNodeExecutions(stopped.runId)).some(node => node.nodeId === "hold" && node.state === "pending") || null,
                "the wait to start");
            let pump = pumpWakes(h, stopped.controller, stopped.runId);
            await until(async () => pump.sent() >= 50 || null, "the wakes to flow");
            let asked = Date.now();
            await controlWorkflowV2Run(h.host, stopped.workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 0 },
                { actor: ACTOR, operationId: "stop-1" });
            expect(await ended(h, stopped.runId, diagnosis(h, stopped.controller), 20_000)).toMatchObject({ status: "stopped" });
            expect(Date.now() - asked).toBeLessThan(20_000);
            await pump.stop();

            // The run deadline (3 s), with the wakes flowing from the start.
            const timed = await started(h, HOLD({ limits: { timeoutSeconds: 3 } }));
            pump = pumpWakes(h, timed.controller, timed.runId);
            asked = Date.now();
            const run = await ended(h, timed.runId, diagnosis(h, timed.controller), 25_000);
            expect(run).toMatchObject({ status: "failed", terminalNodeId: null });
            expect(Date.now() - asked).toBeLessThan(25_000);
            expect(pump.sent()).toBeGreaterThan(100);
            await pump.stop();
        } finally {
            await h.stop();
        }
    });

    // DX-1: the paused loop counts a wait for each wake it takes, and continues as new at its 50th, with about 100 of the
    // wakes still unread: more than duroxide carries. The cancel is not among them: it ended the run as it was accepted.
    it("DX-1 (1.9.0): at the paused continue-as-new, a cancel accepted behind more than 100 wakes has ended the run", { timeout: TIMEOUT }, async () => {
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
            const { workflowSessionId, runId, controller } = await started(h, HOLD());
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
            await queueWakes(h, controller, runId, WAKES);
            const accepted = await cancel(h, workflowSessionId);
            expect(accepted.receipt).toMatchObject({ status: "cancelled" });
            const nodes = (await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.state, node.outcome, node.winner]);
            expect(nodes).toEqual([["hold", "completed", "cancelled", "cancel"]]);
            held.open();
            await controllerFinished(h, controller, "cancelled");
            expect((await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.state, node.outcome, node.winner])).toEqual(nodes);
        } finally {
            await h.stop();
        }
    });

    it("done and delete from the parent's session end a begun run in the store before its controller reads anything", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), { requests: true });
        try {
            const send = async (parent, target, cmd, id) => {
                const command = { type: "cmd", cmd, id, args: {}, requestedBy: parent };
                const applied = await applySessionCommandToWorkflowV2({ store: h.store, deleteSessionFacts: null },
                    { callerInstanceId: `session-${parent}`, targetSessionId: target, command });
                // As the parent's sendCommandToSession activity does: "enqueue" queues the command for the controller.
                if (applied.action === "enqueue") await h.client.enqueueEvent(`session-${target}`, "messages", JSON.stringify(command));
                return applied;
            };
            const parentDone = randomUUID();
            const done = await started(h, HOLD(), { parent: parentDone });
            await until(async () => (await h.store.listNodeExecutions(done.runId)).some(node => node.nodeId === "hold") || null, "the first wait");
            expect(await send(parentDone, done.workflowSessionId, "done", "done-1")).toEqual({ action: "enqueue" });
            expect(await h.store.readRun(done.runId)).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled", message: "Stopped",
                details: { command: "done", requestedBy: parentDone, accepted: true, operationId: `${SESSION_COMMAND_OPERATION_PREFIX}done-1` } } });
            await controllerFinished(h, done.controller, "cancelled");

            const parentDelete = randomUUID();
            const deleted = await started(h, HOLD(), { parent: parentDelete });
            await until(async () => (await h.store.listNodeExecutions(deleted.runId)).some(node => node.nodeId === "hold") || null, "the second wait");
            expect(await send(parentDelete, deleted.workflowSessionId, "delete", "delete-1"))
                .toMatchObject({ action: "applied", receipt: { command: "delete", applied: "store", status: "deleted" } });
            expect(await h.catalog.getSession(deleted.workflowSessionId)).toBeNull();
            expect((await h.store.readRun(deleted.runId)).status).toBe("cancelled");
            // Nothing is queued for a delete: the controller finds the deletion at its next store call.
            expect((await h.client.waitForOrchestration(deleted.controller, 30_000)).status).toBe("Completed");
        } finally {
            await h.stop();
        }
    });
});
