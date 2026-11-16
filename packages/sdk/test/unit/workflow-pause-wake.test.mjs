import test from "node:test";
import assert from "node:assert/strict";
import { controlWorkflowRun } from "../../dist/workflow/service.js";
import { WorkflowStoreError } from "../../dist/workflow/store.js";
import { workflowController, WORKFLOW_COMMAND_POLL_MS, WORKFLOW_CONTROLLER_VERSION } from "../../dist/workflow/runtime.js";

const NOW = 1_794_000_000_000;
const BACKSTOP = 30_000;
const PLAN = {
    name: "pause-wake", version: "1.0.0", initial: "hold", maxNodeExecutions: 100, wakeBackstopMs: BACKSTOP, catchAll: null,
    nodes: { hold: { type: "wait", next: { elapsed: "done" } }, done: { type: "terminal", next: {} } },
};
const ACTOR = { kind: "system", name: "pause-wake-test" };

function commandHost() {
    const run = { runId: "run", workflowSessionId: "wf", mode: "live", status: "running", controllerInstanceId: "controller" };
    const queue = [], order = [], receipts = new Map();
    const host = {
        store: {
            listRuns: async () => [run],
            readRun: async () => run,
            setRunPaused: async input => {
                order.push("store");
                if (receipts.has(input.operationId)) return { ...receipts.get(input.operationId), replayed: true };
                if (input.pause === (run.status === "paused")) throw new WorkflowStoreError("RUN_NOT_PAUSED", "No transition.");
                run.status = input.pause ? "paused" : "running";
                const stored = { replayed: false, receipt: { runId: run.runId, status: run.status, operation: input.pause ? "pause" : "resume" } };
                receipts.set(input.operationId, stored);
                return stored;
            },
        },
        duroxideClient: {
            enqueueEvent: async (instanceId, name, value) => {
                order.push("wake");
                queue.push({ instanceId, name, value });
            },
        },
    };
    const command = (operation, operationId = operation) => controlWorkflowRun(host, "wf", { operation, runId: "run", reason: null },
        { actor: ACTOR, operationId });
    return { host, run, queue, order, command };
}

/** Drive the real generator only when a queue event is available; no timer is ever allowed to fire. */
function controllerAtQueue(fixture) {
    const observed = [], admissions = [], timers = [];
    const ctx = {
        instanceId: "controller",
        setCustomStatus() {}, traceInfo() {}, traceWarn() {}, traceError() {}, traceDebug() {},
        utcNow: () => ({ kind: "now" }),
        scheduleTimer: ms => ({ kind: "timer", ms }),
        dequeueEvent: queue => ({ kind: "dequeue", queue }),
        race: (left, right) => ({ kind: "race", left, right }),
        scheduleActivityWithRetryTyped: (name, input) => ({ kind: "activity", name, input }),
        scheduleActivityTyped: (name, input) => ({ kind: "activity", name, input,
            withTag: tag => ({ kind: "activity", name, input, tag }) }),
        continueAsNewVersioned: () => { throw new Error("No execution rollover is needed."); },
        startOrchestrationVersioned: () => { throw new Error("A wait starts no helper."); },
    };
    const generator = workflowController(ctx, { v: 1, workflowSessionId: "wf", runId: "run" });
    let task = generator.next();
    return {
        observed, admissions, timers,
        pump() {
            for (let steps = 0; steps < 100; steps += 1) {
                assert.equal(task.done, false);
                const work = task.value;
                let result;
                if (work.kind === "now") result = NOW;
                else if (work.kind === "race") {
                    if (work.right.ms === WORKFLOW_COMMAND_POLL_MS) result = { index: 1 };
                    else {
                        timers.push(work.right.ms);
                        assert.equal(work.right.ms, BACKSTOP);
                        const message = fixture.queue.shift();
                        if (!message) return;
                        assert.equal(message.instanceId, "controller");
                        assert.equal(message.name, work.left.queue);
                        result = { index: 0, value: message.value };
                    }
                } else if (work.kind === "activity") {
                    switch (work.name.split(".").at(-1)) {
                        case "begin": result = { status: "running", irSha256: "sha", initial: "hold", outcome: null }; break;
                        case "plan": result = PLAN; break;
                        case "enter":
                            admissions.push(work.input.nodeId);
                            result = { admitted: true, nodeExecutionId: "nx-hold", state: "pending", deadlineMs: NOW + 36_000_000 };
                            break;
                        case "collect":
                            observed.push(fixture.run.status);
                            result = { collected: [], ...(fixture.run.status === "paused" ? { paused: true } : {}) };
                            break;
                        default: result = null;
                    }
                } else assert.fail(`Unexpected task ${JSON.stringify(work)}`);
                task = generator.next(result);
            }
            assert.fail("Controller did not reach its queue.");
        },
    };
}

test(`${WORKFLOW_CONTROLLER_VERSION}: pause and resume reach the waiting controller before any backstop timer fires`, async () => {
    const fixture = commandHost();
    const controller = controllerAtQueue(fixture);
    controller.pump();
    assert.deepEqual(controller.observed, ["running"]);
    await fixture.command("pause");
    assert.deepEqual(fixture.order, ["store", "wake"]);
    assert.deepEqual(JSON.parse(fixture.queue[0].value), { type: "workflow-wake", runId: "run", reason: "pause" });
    controller.pump();
    assert.equal(controller.observed.at(-1), "paused");
    assert.deepEqual(controller.admissions, ["hold"], "pause admits no new work");
    await fixture.command("resume");
    assert.deepEqual(JSON.parse(fixture.queue[0].value), { type: "workflow-wake", runId: "run", reason: "resume" });
    controller.pump();
    assert.equal(controller.observed.at(-1), "running");
    assert.deepEqual(controller.admissions, ["hold"], "resume preserves the same pending wait");
    assert.ok(controller.timers.length >= 3, "the controller kept waiting, without advancing the frozen clock");
});

test("accepted retries resend the hint; refused transitions and ended receipt replays send none", async () => {
    const fixture = commandHost();
    await fixture.command("pause");
    assert.equal((await fixture.command("pause")).replayed, true);
    assert.equal(fixture.queue.length, 2);
    await assert.rejects(fixture.command("pause", "another-pause"), /No transition/);
    assert.equal(fixture.queue.length, 2);
    fixture.run.status = "completed";
    assert.equal((await fixture.command("pause")).replayed, true);
    assert.equal(fixture.queue.length, 2);
});

test("a failed wake surfaces its error after durable acceptance; an exact retry can resend it", async () => {
    const fixture = commandHost();
    const send = fixture.host.duroxideClient.enqueueEvent;
    fixture.host.duroxideClient.enqueueEvent = async () => { throw new Error("wake unavailable"); };
    await assert.rejects(fixture.command("pause"), /wake unavailable/);
    assert.equal(fixture.run.status, "paused");
    fixture.host.duroxideClient.enqueueEvent = send;
    assert.equal((await fixture.command("pause")).replayed, true);
    assert.equal(fixture.queue.length, 1);
});
