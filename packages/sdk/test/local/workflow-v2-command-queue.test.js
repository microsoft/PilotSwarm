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
 * - V-3: the shortest valid workflow (a first state that completes at once, then its terminal), with 33 wakes and then a
 *   cancel accepted while its plan is held: no state is admitted after the acceptance, and the run
 *   ends cancelled (1.8.0 and 1.9.0).
 * - V-2: wakes queued all the time (counted only when the queue accepted them, N-4) do not hold back a graceful stop or
 *   the run deadline, and a paused run continues as new under them, the condition the old pre-rollover drain met (1.9.0).
 * - DX-1: at controller 1.9.0's paused continue-as-new, a cancel behind more than 100 wakes: the run ended when the cancel
 *   was accepted, and the controller finishes.
 * - A cancel accepted while the controller is admitting the next state: no further state is admitted (1.8.0 and 1.9.0).
 * - done and delete from the parent's session (the sendCommandToSession path): done ends the run cancelled "Stopped",
 *   delete deletes the workflow; both before the controller reads anything.
 * - DX-2, R5: 150 wakes and a cancel an older build queued (only in the queue), behind a held plan: no turn reads more
 *   than 32 messages in a row, so the controller does not fail, and the queued cancel still ends the run (1.8.0, 1.9.0).
 * - N-1: an end another writer stored (an accepted cancel during a held 1.8.0 collection; an operator's delete of a
 *   running 1.9.0 workflow) gets its running script effect a stop request, with the script's own liveness check slowed.
 * - N-2: an older queued parent command that lost to a person's cancel does not silence the parent's notice (1.9.0).
 * - The operator paths: the management API's cancelSession, completeSession and deleteSession, and the agent manager's
 *   manage_agent_session (its call: applyOperatorCommandToWorkflowV2 with the durable client), end a begun run in the
 *   store at once while the controller is in the middle of an admission, and no state is admitted after them; an
 *   operator's cancel of a run that has not begun tells the parent (1.9.0).
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
import {
    applyOperatorCommandToWorkflowV2, applySessionCommandToWorkflowV2, controlWorkflowV2Run, createWorkflowV2, OPERATOR_COMMAND_OPERATION_PREFIX,
    SESSION_COMMAND_OPERATION_PREFIX,
} from "../../src/workflow/v2/service.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_COMMAND_READ_BATCH, WORKFLOW_V2_REQUEST_ACTIVITIES,
    workflowEffectInstanceId, workflowNotifyInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
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
/**
 * The shortest valid workflow (initial must not be a terminal, compiler WORKFLOW_INITIAL_INVALID): a first state that
 * completes at once, then the terminal. Before S7-DX2, 32 wakes ahead of a cancel let it be admitted and the run complete.
 */
const QUICK_FIRST = {
    ...head("quick-first"),
    initial: "step",
    states: {
        step: { type: "script", source: "await setResult(\"ok\", {});\n", transition: { next: { ok: "done" } } },
        done: { type: "terminal", outcome: "succeeded" },
    },
};
/**
 * A script that sleeps 90 s, with no route for a runtime error (no failure route, no catch-all): its effect is still
 * running when the run ends, and only an explicit stop ends it early when the script's own liveness check is slow.
 */
const SLOW_SCRIPT = {
    ...head("slow-script"),
    initial: "work",
    states: {
        work: { type: "script", timeoutSeconds: 120, source: "await new Promise(resolve => setTimeout(resolve, 90_000));\nawait setResult(\"ok\", {});\n",
            transition: { next: { ok: "done" } } },
        done: { type: "terminal", outcome: "succeeded" },
    },
};
/** The script's own liveness check, slowed past the test window: only an explicit stop ends its effect early. */
const SLOW_LIVENESS = { livenessIntervalMs: 120_000 };

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
 * named in `wrap` is wrapped (to hold it); `options` replace registration options (a slow liveness check, a parent notice).
 */
async function harness(env, { requests, wrap = {}, options = {} }) {
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
        ...options,
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

/**
 * Queue wakes from `producers` loops, each every few milliseconds, until stopped: the queue is never empty for long.
 * `sent()` counts only the wakes the queue accepted (review N-4). A failed enqueue ends the pump. It is expected only when
 * the run's status, read then, proves the run ended (its controller completed); otherwise, also when that status read
 * fails, the enqueue's error is kept, with the failed status read on it as `statusReadError`, and stop() throws it.
 * The failure is kept also when it settles after stop() was called (review N-4-stop-inflight): stop() first waits for every
 * enqueue in flight, then throws. halt() stops the pump without throwing, for a test's finally; it is the only quiet cleanup.
 */
function pumpWakes(h, controller, runId, producers = 1) {
    let on = true;
    let sent = 0;
    let failure = null;
    const loop = async () => {
        while (on) {
            try {
                await h.client.enqueueEvent(controller, "messages", wake(runId, sent));
                sent += 1;
            } catch (error) {
                let ended = false;
                try {
                    const run = await h.store.readRun(runId);
                    ended = run !== null && ["completed", "failed", "cancelled", "stopped"].includes(run.status);
                } catch (statusReadError) {
                    if (error !== null && typeof error === "object") error.statusReadError = statusReadError;
                }
                // Not gated on `on`: stop() sets it before it waits for this enqueue, which may still reject.
                if (!ended) failure ??= error;
                on = false;
            }
            await pause(2);
        }
    };
    const running = Promise.all(Array.from({ length: producers }, loop));
    const halt = async () => { on = false; await running; };
    return {
        sent: () => sent, halt,
        async stop() {
            await halt();
            if (failure) throw failure;
        },
    };
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
        it(`V-3 (${version}): a run whose first state completes at once, with 33 wakes and then an accepted cancel, admits no state and ends cancelled`, { timeout: TIMEOUT }, async () => {
            const plan = gate();
            let planned = false;
            const h = await harness(getEnv(), { requests, wrap: {
                [R.plan]: fn => async (ctx, input) => {
                    if (!planned) { planned = true; plan.arrive(); await plan.wait(); }
                    return fn(ctx, input);
                },
            } });
            try {
                const { workflowSessionId, runId, controller } = await started(h, QUICK_FIRST);
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
        let pump = null;
        try {
            // A graceful stop with no grace: the wait is pending, so it ends the run stopped at once.
            const stopped = await started(h, HOLD());
            await until(async () => (await h.store.listNodeExecutions(stopped.runId)).some(node => node.nodeId === "hold" && node.state === "pending") || null,
                "the wait to start");
            pump = pumpWakes(h, stopped.controller, stopped.runId);
            await until(async () => pump.sent() >= 50 || null, "50 wakes to be accepted");
            const asked = Date.now();
            await controlWorkflowV2Run(h.host, stopped.workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 0 },
                { actor: ACTOR, operationId: "stop-1" });
            const atStop = pump.sent();
            expect(await ended(h, stopped.runId, diagnosis(h, stopped.controller), 20_000)).toMatchObject({ runId: stopped.runId, status: "stopped" });
            expect(Date.now() - asked).toBeLessThan(20_000);
            expect(pump.sent(), "wakes kept flowing while the stop was handled").toBeGreaterThan(atStop);
            await pump.stop();
            pump = null;
        } finally {
            await pump?.halt();
            await h.stop();
        }
    });

    // V-2 at the rollover: the condition the old pre-continue-as-new drain met. A paused run counts every wait, so with wakes
    // flowing it reaches its 50th wait and continues as new while the queue is still being filled; the old drain read on
    // until the queue was empty. The run deadline must still end the run, and the controller must roll over.
    //
    // Deterministic (review of the DEV runs at d52e5ed2, aa5bb84a and 67fe212c): each counted wait of a paused 1.9.0 run is
    // one pass of its loop, a store collection and at least one orchestration turn, and under four producers every queued
    // wake adds a history event and a turn that replays the whole history. How many passes fit in the run's 15 s depends
    // on the machine; at 67fe212c the deadline came at the 49th counted wait (its 54 status writes: begin, admission, one
    // per pass and the end), one short of the rollover, and the run ended with no continue-as-new. So the store's expire
    // answers "not yet" (as when its clock is behind the controller's: the controller moves its deadline later and goes on)
    // until the controller has continued as new; from then on the store decides as it does. The rollover no longer races
    // the deadline, and the run still ends by its deadline, through the store, in the new execution.
    it("V-2 (1.9.0): under sustained wakes a paused run continues as new and still ends at its run deadline", { timeout: TIMEOUT }, async () => {
        let rolledOver = async () => false;
        let held = 0;
        const h = await harness(getEnv(), { requests: true, wrap: {
            [WORKFLOW_V2_REQUEST_ACTIVITIES.expire]: fn => async (ctx, input) => {
                if (await rolledOver()) return fn(ctx, input);
                held += 1;
                return { ended: false, remainingMs: 60_000 };
            },
        } });
        let pump = null;
        try {
            const DEADLINE_SECONDS = 15;
            const run = await started(h, HOLD({ limits: { timeoutSeconds: DEADLINE_SECONDS } }));
            const began = Date.now();
            const diagnose = async () => ({ ...(await diagnosis(h, run.controller)()), heldExpires: held });
            await until(async () => (await h.store.listNodeExecutions(run.runId)).some(node => node.nodeId === "hold" && node.state === "pending") || null,
                "the wait to start", 30_000, diagnose);
            await controlWorkflowV2Run(h.host, run.workflowSessionId, { operation: "pause", runId: null, reason: "hold still" },
                { actor: ACTOR, operationId: "pause-1" });
            await until(async () => (await h.store.readRun(run.runId))?.status === "paused" || null, "the pause", 30_000, diagnose);
            const executions = (await h.client.listExecutions(run.controller)).length;
            rolledOver = async () => (await h.client.listExecutions(run.controller)).length > executions;
            pump = pumpWakes(h, run.controller, run.runId, 4);
            // The rollover happens while the wakes flow: more executions, and at least 50 accepted wakes (one per paused wait).
            await until(rolledOver, "a continue-as-new under sustained wakes", 90_000, diagnose);
            const rolledAt = Date.now();
            expect(pump.sent()).toBeGreaterThanOrEqual(50);
            const atRollover = pump.sent();
            // It ends at its deadline, or at once after the rollover when that came later.
            const endedRun = await ended(h, run.runId, diagnose, 30_000);
            expect(endedRun).toMatchObject({ runId: run.runId, status: "failed", terminalNodeId: null });
            expect(Date.now() - Math.max(began + DEADLINE_SECONDS * 1_000, rolledAt)).toBeLessThan(25_000);
            expect(pump.sent(), "wakes kept flowing after the rollover").toBeGreaterThan(atRollover);
            await pump.stop();
            pump = null;
        } finally {
            await pump?.halt();
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

    // The operator paths (S7-DX2 follow-up): the same command-loss defect through other entry points.
    describe("operator paths", () => {
        /** A harness whose admission of "next" waits, per run, until the test opens it (the controller is in the middle of a turn). */
        const heldHarness = async () => {
            const R = WORKFLOW_V2_REQUEST_ACTIVITIES;
            const holds = new Map();
            const h = await harness(getEnv(), { requests: true, wrap: {
                [R.enter]: fn => async (ctx, input) => {
                    const held = input?.nodeId === "next" ? holds.get(input.runId) : undefined;
                    if (held) { holds.delete(input.runId); held.arrive(); await held.wait(); }
                    return fn(ctx, input);
                },
            } });
            return { h, hold: runId => { const held = gate(); holds.set(runId, held); return held; } };
        };
        /** Start TWO_WAITS and wait until its controller is held in its admission of "next". */
        const heldAtNext = async (h, hold, options) => {
            const run = await started(h, TWO_WAITS, options);
            const held = hold(run.runId);
            await held.reached;
            return { ...run, held };
        };
        const cancelledAtOnce = (h, runId) => until(async () => {
            const run = await h.store.readRun(runId);
            return run.status === "cancelled" ? run : null;
        }, `run ${runId} to end in the store`, 30_000);

        it("the management API's cancelSession, completeSession and deleteSession end a begun run in the store at once; no state follows", { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const { h, hold } = await heldHarness();
            const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
            await mgmt.start();
            try {
                for (const [name, call, command, reason] of [
                    ["cancelSession", id => mgmt.cancelSession(id, "operator cancel"), "cancel", "operator cancel"],
                    ["completeSession", id => mgmt.completeSession(id, "operator done"), "done", "operator done"],
                    ["deleteSession", id => mgmt.deleteSession(id, "operator delete"), "delete", null],
                ]) {
                    const run = await heldAtNext(h, hold);
                    // The controller is held in its admission of "next": the command is applied in the store meanwhile.
                    const calling = call(run.workflowSessionId);
                    const ended = await cancelledAtOnce(h, run.runId);
                    if (command === "delete") {
                        expect(await h.catalog.getSession(run.workflowSessionId), name).toBeNull();
                    } else {
                        expect(ended.terminalError, name).toMatchObject({ code: "cancelled", message: reason,
                            details: { command, requestedBy: null, accepted: true, operationId: expect.stringMatching(new RegExp(`^${OPERATOR_COMMAND_OPERATION_PREFIX}${command}-`)) } });
                    }
                    run.held.open();
                    await calling;
                    expect((await h.client.waitForOrchestration(run.controller, 30_000)).status, name).toBe("Completed");
                    expect((await h.store.listNodeExecutions(run.runId)).map(node => node.nodeId), name).toEqual(["first"]);
                }
            } finally {
                await mgmt.stop();
                await h.stop();
            }
        });

        it("the agent manager's manage_agent_session (applyOperatorCommandToWorkflowV2) ends a begun run at once; an operator's cancel before begin tells the parent", { timeout: TIMEOUT }, async () => {
            const { h, hold } = await heldHarness();
            try {
                const host = { store: h.store, deleteSessionFacts: null, duroxideClient: h.client };
                for (const cmd of ["cancel", "done"]) {
                    const run = await heldAtNext(h, hold);
                    const command = { type: "cmd", cmd, id: `${cmd}-mgr-1`, args: { reason: `${cmd} requested by agent-manager` } };
                    // As the tool does: "enqueue" queues the command for the controller, which finishes the ended run.
                    const applied = await applyOperatorCommandToWorkflowV2(host, { targetSessionId: run.workflowSessionId, command });
                    expect(applied, cmd).toEqual({ action: "enqueue" });
                    await h.client.enqueueEvent(run.controller, "messages", JSON.stringify(command));
                    expect(await h.store.readRun(run.runId), cmd).toMatchObject({ status: "cancelled", terminalError: { details: { command: cmd,
                        requestedBy: null, accepted: true, operationId: `${OPERATOR_COMMAND_OPERATION_PREFIX}${cmd}-mgr-1` } } });
                    run.held.open();
                    await controllerFinished(h, run.controller, "cancelled");
                    expect((await h.store.listNodeExecutions(run.runId)).map(node => node.nodeId), cmd).toEqual(["first"]);
                }
                const deleted = await heldAtNext(h, hold);
                expect(await applyOperatorCommandToWorkflowV2(host, { targetSessionId: deleted.workflowSessionId,
                    command: { type: "cmd", cmd: "delete", id: "delete-mgr-1", args: { reason: "delete requested by agent-manager" } } }))
                    .toMatchObject({ action: "applied", receipt: { command: "delete", applied: "store", status: "deleted" } });
                expect((await h.store.readRun(deleted.runId)).status).toBe("cancelled");
                deleted.held.open();
                expect((await h.client.waitForOrchestration(deleted.controller, 30_000)).status).toBe("Completed");
                expect((await h.store.listNodeExecutions(deleted.runId)).map(node => node.nodeId)).toEqual(["first"]);
                // An ordinary agent session is not a workflow: its command is queued as before.
                const agent = randomUUID();
                await h.catalog.createSession(agent, {});
                expect(await applyOperatorCommandToWorkflowV2(host, { targetSessionId: agent, command: { type: "cmd", cmd: "cancel", id: "cancel-mgr-2" } }))
                    .toEqual({ action: "enqueue" });
            } finally {
                await h.stop();
            }
            // Before begin: the run ends in the store, and as no controller will tell its parent, the notice is started.
            const R = WORKFLOW_V2_REQUEST_ACTIVITIES;
            const begin = gate();
            let begun = false;
            const early = await harness(getEnv(), { requests: true, wrap: {
                [R.begin]: fn => async (ctx, input) => {
                    if (!begun) { begun = true; begin.arrive(); await begin.wait(); }
                    return fn(ctx, input);
                },
            } });
            try {
                const parent = randomUUID();
                const run = await started(early, HOLD(), { parent });
                await begin.reached;
                expect(await applyOperatorCommandToWorkflowV2({ store: early.store, deleteSessionFacts: null, duroxideClient: early.client },
                    { targetSessionId: run.workflowSessionId, command: { type: "cmd", cmd: "cancel", id: "cancel-mgr-3", args: { reason: "not yet" } } }))
                    .toMatchObject({ action: "applied", receipt: { command: "cancel", applied: "store", status: "cancelled" } });
                expect(await early.store.readRun(run.runId)).toMatchObject({ status: "cancelled",
                    terminalError: { details: { beforeBegin: true, operationId: `${OPERATOR_COMMAND_OPERATION_PREFIX}cancel-mgr-3` } } });
                await until(async () => (await early.client.getStatus(workflowNotifyInstanceId(run.runId))).status !== "NotFound" || null,
                    "the parent notice to start");
                begin.open();
                expect((await early.client.waitForOrchestration(run.controller, 30_000)).status).toBe("Completed");
                expect(await early.store.listNodeExecutions(run.runId)).toEqual([]);
            } finally {
                begin.open();
                await early.stop();
            }
        });
    });

    // Review N-1 (S7-DX3): every end that another writer stores is reconciled the same way, and the running effects it
    // cancelled are asked to stop, whoever won. A real script effect with a slowed liveness check shows it: only the
    // explicit stop ends it before its 90 s sleep.
    describe("N-1: an end another writer stored stops the running effects", () => {
        /** The script state's node execution once its effect runs. */
        const scriptRunning = (h, runId) => until(async () => {
            const node = (await h.store.listNodeExecutions(runId)).find(item => item.nodeId === "work");
            return node?.effectAttempts >= 1 ? node : null;
        }, "the script to start");
        /** The script's effect orchestration stops (it would run 90 s if nothing asked it to stop). */
        const effectStopped = (h, nodeExecutionId) => until(async () => {
            const status = await h.client.getStatus(workflowEffectInstanceId(nodeExecutionId));
            return status.status !== "Running" ? status : null;
        }, "the script's effect to be stopped", 40_000);

        it("(a) 1.8.0: a cancel accepted while its collection is held; the collection reports the end and the effect is stopped", { timeout: TIMEOUT }, async () => {
            let hold = null;
            const h = await harness(getEnv(), { requests: false, options: SLOW_LIVENESS, wrap: {
                [WORKFLOW_V2_ACTIVITIES.collect]: fn => async (ctx, input) => {
                    const held = hold;
                    if (held) { hold = null; held.arrive(); await held.wait(); }
                    return fn(ctx, input);
                },
            } });
            try {
                const run = await started(h, SLOW_SCRIPT);
                const node = await scriptRunning(h, run.runId);
                const held = gate();
                hold = held;
                await held.reached;
                await cancel(h, run.workflowSessionId);
                expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "cancel" });
                held.open();
                const stopped = await effectStopped(h, node.nodeExecutionId);
                expect(stopped.status).not.toBe("Running");
                const asked = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 500, ["workflow.cancel_requested"]);
                expect(asked.flatMap(event => event.data.effects.map(effect => effect.nodeExecutionId))).toContain(node.nodeExecutionId);
                await controllerFinished(h, run.controller, "cancelled");
            } finally {
                await h.stop();
            }
        });

        it("(b) 1.9.0: an operator's delete of a running workflow; the controller's next store call finds it and the effect is stopped", { timeout: TIMEOUT }, async () => {
            const h = await harness(getEnv(), { requests: true, options: SLOW_LIVENESS });
            try {
                const run = await started(h, SLOW_SCRIPT);
                const node = await scriptRunning(h, run.runId);
                expect(await applyOperatorCommandToWorkflowV2({ store: h.store, deleteSessionFacts: null, duroxideClient: h.client }, {
                    targetSessionId: run.workflowSessionId, command: { type: "cmd", cmd: "delete", id: "delete-mgr-1", args: { reason: "not needed" } },
                })).toMatchObject({ action: "applied", receipt: { command: "delete", applied: "store" } });
                expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({ outcome: "cancelled", winner: "delete" });
                // Nothing is queued for a delete: the controller finds it at its next collection (its backstop is 500 ms).
                const stopped = await effectStopped(h, node.nodeExecutionId);
                expect(stopped.status).not.toBe("Running");
                expect((await h.client.waitForOrchestration(run.controller, 30_000)).status).toBe("Completed");
            } finally {
                await h.stop();
            }
        });
    });

    // Review N-2 (S7-DX3): the parent notice follows the stored end, the first run-ending commit, not a queued command that
    // lost. An older build's queued parent "done" (requestedBy: the parent) is read after a person's cancel ended the run.
    it("N-2 (1.9.0): an older queued parent command that lost to a person's cancel does not silence the parent's notice", { timeout: TIMEOUT }, async () => {
        const notices = [];
        const plan = gate();
        let planned = false;
        const h = await harness(getEnv(), { requests: true, options: {
            authorizeParentNotification: async () => true,
            notifyParent: async (parentSessionId, text) => { notices.push({ parentSessionId, text }); },
        }, wrap: {
            [WORKFLOW_V2_REQUEST_ACTIVITIES.plan]: fn => async (ctx, input) => {
                if (!planned) { planned = true; plan.arrive(); await plan.wait(); }
                return fn(ctx, input);
            },
        } });
        try {
            const parent = randomUUID();
            const run = await started(h, HOLD(), { parent });
            await plan.reached;
            // The older build's command, only queued (read first), then a person's cancel through the store (it wins the end).
            await h.client.enqueueEvent(run.controller, "messages",
                JSON.stringify({ type: "cmd", cmd: "done", id: "old-done", args: { reason: "done by the parent (older build)" }, requestedBy: parent }));
            await controlWorkflowV2Run(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "stopped by a person" },
                { actor: { kind: "user", provider: "test", subject: `person-${randomUUID()}` }, operationId: "person-cancel" });
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "cancelled",
                terminalError: { message: "stopped by a person", details: { command: "cancel", requestedBy: null, accepted: true } } });
            plan.open();
            await controllerFinished(h, run.controller, "cancelled");
            await until(async () => notices.length > 0 || null, "the parent's notice");
            expect(notices.map(notice => notice.parentSessionId)).toEqual([parent]);
            expect(notices[0].text).toContain("cancelled");
        } finally {
            plan.open();
            await h.stop();
        }
    });

    // Review R3-GR1 (formal r3, graph.r3-delete-after-cmd and r3-delete-after-retry): a deletion that follows another end does
    // not silence that end's notice: whatever ended the run first decides who is told. The controller is held (its plan, or
    // its finish's attempt) while another writer ends the run and the workflow is then deleted; the parent is told once.
    describe("R3-GR1 (1.9.0): a deletion after another end keeps that end's parent notice", () => {
        /** A 1.9.0 harness whose parent notices are recorded, with `wrap`. */
        const noticed = (wrap = {}) => {
            const notices = [];
            return { notices, options: { authorizeParentNotification: async () => true,
                notifyParent: async (parentSessionId, text) => { notices.push({ parentSessionId, text }); } }, wrap };
        };
        const heldPlan = () => {
            const plan = gate();
            let planned = false;
            return { plan, wrap: { [WORKFLOW_V2_REQUEST_ACTIVITIES.plan]: fn => async (ctx, input) => {
                if (!planned) { planned = true; plan.arrive(); await plan.wait(); }
                return fn(ctx, input);
            } } };
        };

        for (const [label, endFirst, status, words] of [
            ["a person's cancel", async (h, run) => controlWorkflowV2Run(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "stopped by a person" },
                { actor: { kind: "user", provider: "test", subject: `person-${randomUUID()}` }, operationId: "person-cancel" }), "cancelled", "cancelled"],
            ["the chat's own end", async (h, _run, parent) => h.catalog.updateSession(parent, { state: "cancelled" }), "cancelled", "cancelled"],
            // Review DRR-5: a person's reason that reads as the deletion's own words is still a cancel (its stored command).
            ["a person's cancel whose reason is the deletion's words", async (h, run) => controlWorkflowV2Run(h.host, run.workflowSessionId,
                { operation: "cancel", runId: null, reason: "The workflow session was deleted." },
                { actor: { kind: "user", provider: "test", subject: `person-${randomUUID()}` }, operationId: "person-cancel-words" }), "cancelled", "cancelled"],
            ["an operator's done whose reason is the deletion's words", async (h, run) => {
                const command = { type: "cmd", cmd: "done", id: "done-words-1", args: { reason: "The workflow session was deleted." } };
                expect(await applyOperatorCommandToWorkflowV2({ store: h.store, deleteSessionFacts: null, duroxideClient: h.client },
                    { targetSessionId: run.workflowSessionId, command })).toEqual({ action: "enqueue" });
                await h.client.enqueueEvent(run.controller, "messages", JSON.stringify(command));
            }, "cancelled", ""],
        ]) {
            it(`${label}, then the workflow's deletion, while the controller is held: the parent is told once, of that end`, { timeout: TIMEOUT }, async () => {
                const held = heldPlan();
                const n = noticed(held.wrap);
                const h = await harness(getEnv(), { requests: true, options: n.options, wrap: n.wrap });
                try {
                    const parent = randomUUID();
                    const run = await started(h, HOLD(), { parent });
                    await held.plan.reached;
                    await endFirst(h, run, parent);
                    expect(await h.store.readRun(run.runId)).toMatchObject({ status });
                    await h.catalog.softDeleteSession(run.workflowSessionId);
                    held.plan.open();
                    await controllerFinished(h, run.controller, status);
                    await until(async () => n.notices.length > 0 || null, "the parent's notice");
                    await pause(1_000);
                    expect(n.notices.map(notice => notice.parentSessionId)).toEqual([parent]);
                    expect(n.notices[0].text).toContain(words);
                } finally {
                    held.plan.open();
                    await h.stop();
                }
            });
        }

        it("the controller's own end, retried after its attempt crashed, then the workflow's deletion: the parent is told once, of that end", { timeout: TIMEOUT }, async () => {
            // Fault injection: the finish's first attempt commits the run's end, then the workflow is deleted and the attempt
            // fails (a crash after the commit); its retry finds the run ended and reconciles it.
            let crashed = false;
            let h = null;
            const n = noticed({ [WORKFLOW_V2_REQUEST_ACTIVITIES.finish]: fn => async (ctx, input) => {
                const result = await fn(ctx, input);
                if (!crashed) {
                    crashed = true;
                    await h.catalog.softDeleteSession((await h.store.readRun(input.runId)).workflowSessionId);
                    throw new Error("injected: the worker crashed after the finish committed");
                }
                return result;
            } });
            h = await harness(getEnv(), { requests: true, options: n.options, wrap: n.wrap });
            try {
                const parent = randomUUID();
                // HOLD with a one-second wait: the run ends by its own terminal.
                const run = await started(h, { ...HOLD(), states: { ...HOLD().states, hold: { ...HOLD().states.hold, seconds: 1 } } }, { parent });
                await controllerFinished(h, run.controller, "completed");
                expect(crashed).toBe(true);
                expect(await h.store.readRun(run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                await until(async () => n.notices.length > 0 || null, "the parent's notice");
                await pause(1_000);
                expect(n.notices.map(notice => notice.parentSessionId)).toEqual([parent]);
                expect(n.notices[0].text).toContain("succeeded");
            } finally {
                await h.stop();
            }
        });
    });

    // Review N-4 residual: the pump keeps a failed enqueue unless the run's status proves it ended; a failed status read is
    // kept on the error, never taken for an end. (No database: the client and the store fail as given.)
    it("N-4: the wake pump's stop rejects when an enqueue fails and the status read fails too; only a proven end is quiet", async () => {
        const failing = (status) => ({
            client: { enqueueEvent: async () => { throw new Error("queue unavailable"); } },
            store: { readRun: async () => {
                if (status instanceof Error) throw status;
                return status === null ? null : { runId: "run-x", status };
            } },
        });
        const unread = pumpWakes(failing(new Error("store unavailable")), "session-x", "run-x");
        const error = await unread.stop().then(() => null, thrown => thrown);
        expect(error?.message).toBe("queue unavailable");
        expect(error?.statusReadError?.message).toBe("store unavailable");
        expect(unread.sent()).toBe(0);
        // Active, or not found: the failure is kept. Ended: the pump ends quietly.
        await expect(pumpWakes(failing("running"), "session-x", "run-x").stop()).rejects.toThrow("queue unavailable");
        await expect(pumpWakes(failing(null), "session-x", "run-x").stop()).rejects.toThrow("queue unavailable");
        await expect(pumpWakes(failing("cancelled"), "session-x", "run-x").stop()).resolves.toBeUndefined();
        // N-4-stop-inflight: the enqueue rejects only after stop() was called; stop() still throws it.
        let rejectLate = null;
        const late = pumpWakes({
            client: { enqueueEvent: () => new Promise((_, reject) => { rejectLate = reject; }) },
            store: { readRun: async () => ({ runId: "run-x", status: "running" }) },
        }, "session-x", "run-x");
        const stopping = late.stop();
        rejectLate(new Error("queue closed late"));
        await expect(stopping).rejects.toThrow("queue closed late");
    });
});
