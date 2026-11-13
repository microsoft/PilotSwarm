import test from "node:test";
import assert from "node:assert/strict";
import { workflowController, registerWorkflow, WORKFLOW_COMMAND_POLL_MS, WORKFLOW_IDLE_WAITS_PER_EXECUTION } from "../../dist/workflow/runtime.js";

const NOW = Date.parse("2026-11-12T00:00:00Z");
const INPUT = { v: 1, workflowSessionId: "wf", runId: "run" };
const WAKE = JSON.stringify({ type: "workflow-wake", runId: "run", reason: "approval" });
const PLAN = { name: "approval", version: "1.0.0", initial: "consent", maxNodeExecutions: 100, wakeBackstopMs: 30000, catchAll: null,
    nodes: { consent: { type: "approval", next: { approved: "done", rejected: "done", timed_out: "done" } }, done: { type: "terminal", next: {} } } };

test("the registered deadline activity never treats a virtual approval as live consent", async () => {
    const handlers = new Map();
    const run = { workflowSessionId: "wf", runId: "run", mode: "test", controllerVersion: "1.1.0", virtualNow: new Date(NOW) };
    const node = { runId: "run", nodeType: "approval", state: "pending", deadlineAt: new Date(NOW + 172800000) };
    registerWorkflow({ registerOrchestrationVersioned() {}, registerActivity(name, handler) { handlers.set(name, handler); } }, {
        catalog: {}, store: { readRun: async () => run, readNodeExecution: async () => node,
            approvals: { expire: async () => { throw new Error("Live consent was touched."); } } } });
    const handler = handlers.get("workflow.elapseApproval");
    assert.deepEqual(await handler({}, { runId: "run", nodeExecutionIds: ["visit"] }),
        { notDue: [{ nodeExecutionId: "visit", remainingMs: 172800000 }] });
    node.state = "completed";
    assert.deepEqual(await handler({}, { runId: "run", nodeExecutionIds: ["visit"] }), { notDue: [] });
});

function execute({ input = INPUT, version = "1.1.0", testMode = false, next = () => undefined,
    saved = () => null, paused = () => false, now = () => NOW, deadline = NOW + 172800000, elapse = () => {} } = {}) {
    const activities = [];
    const starts = [];
    let waits = 0;
    const activity = (name, value) => ({ kind: "activity", name, value, withTag() { return this; } });
    const ctx = { instanceId: "controller", setCustomStatus() {}, traceInfo() {}, traceWarn() {}, traceDebug() {}, traceError() {},
        utcNow: () => ({ kind: "clock" }), scheduleTimer: ms => ({ kind: "timer", ms }), dequeueEvent: () => ({ kind: "queue" }),
        race: (left, right) => ({ kind: "race", left, right }),
        continueAsNewVersioned: (value, selected) => ({ kind: "can", value, version: selected }),
        startOrchestrationVersioned: (...args) => ({ kind: "start", args }),
        scheduleActivityWithRetryTyped: activity, scheduleActivityTyped: activity };
    const generator = workflowController(ctx, input, version);
    let result;
    for (let steps = 0; steps < 10000; steps++) {
        const yielded = generator.next(result);
        if (yielded.done) return { result: yielded.value, activities, starts, waits };
        const task = yielded.value;
        if (task.kind === "can") return { can: { input: task.value, version: task.version }, activities, starts, waits };
        if (task.kind === "clock") result = now();
        else if (task.kind === "start") { starts.push(task.args); result = undefined; }
        else if (task.kind === "race") {
            if (task.right.ms === WORKFLOW_COMMAND_POLL_MS) result = { index: 1 };
            else {
                if (++waits > 100) throw new Error("Approval did not settle or continue as new.");
                const message = next(waits);
                result = message === undefined ? { index: 1 } : { index: 0, value: message };
            }
        } else if (task.kind === "activity") {
            const name = task.name.split(".").at(-1);
            activities.push({ name, input: task.value, paused: paused() });
            switch (name) {
                case "begin": result = { status: "running", irSha256: "sha", initial: "consent", outcome: null }; break;
                case "plan": result = { ...PLAN, ...(testMode ? { test: true } : {}) }; break;
                case "enterApproval": result = { admitted: true, nodeExecutionId: "visit", state: "pending", deadlineMs: deadline }; break;
                case "enter": result = { admitted: true, nodeExecutionId: "end", state: "completed" }; break;
                case "collect": result = { collected: task.value.nodeExecutionIds.includes("visit") && saved()
                    ? [{ nodeExecutionId: "visit", outcome: saved(), resultKind: saved() === "timed_out" ? "runtime_error" : "business" }] : [],
                    ...(paused() ? { paused: true } : {}) }; break;
                case "elapseApproval": elapse(); result = { notDue: [] }; break;
                case "finish":
                    if (task.value.failure && version !== "1.0.0") throw new Error(JSON.stringify(task.value.failure));
                    result = { runId: "run", status: task.value.failure ? "failed" : "completed", outcome: task.value.failure ? null : "succeeded" };
                    break;
                default: result = null;
            }
        } else throw new Error(`Unexpected task ${task.kind}`);
    }
    throw new Error("Approval controller did not finish.");
}

test("a lost approval wake is collected at the short backstop without starting a helper", () => {
    let decision = null;
    const result = execute({ saved: () => decision, next: () => { decision = "approved"; } });
    assert.equal(result.waits, 1);
    assert.equal(result.result.status, "completed");
    assert.deepEqual(result.starts, []);
    assert.equal(result.activities.filter(item => item.name === "enterApproval").length, 1);
});
test("a decision seen while paused is re-read and routed once on resume", () => {
    let decision = null;
    let isPaused = false;
    const result = execute({ saved: () => decision, paused: () => isPaused, next: count => {
        decision = "approved"; isPaused = count === 1; return WAKE;
    } });
    assert.equal(result.result.status, "completed");
    assert.equal(result.activities.filter(item => item.name === "enter" && item.input.nodeId === "done").length, 1);
    assert.ok(result.activities.filter(item => item.name === "enter").every(item => !item.paused));
});
test("continue-as-new preserves the visit and reads its saved decision before admitting another state", () => {
    const first = execute({ next: () => WAKE });
    assert.equal(first.waits, WORKFLOW_IDLE_WAITS_PER_EXECUTION);
    assert.equal(first.can.version, "1.1.0");
    assert.equal(first.can.input.state.cursors[0].pending, "visit");
    const second = execute({ input: first.can.input, saved: () => "approved" });
    assert.equal(second.result.status, "completed");
    assert.equal(second.activities.filter(item => item.name === "enterApproval").length, 0);
    assert.equal(second.activities.filter(item => item.name === "enter").length, 1);
});
test("the approval deadline uses its new activity, including a decided row whose wake was lost", () => {
    let clock = NOW;
    let decision = null;
    const result = execute({ now: () => clock, saved: () => decision, deadline: NOW + 1000,
        next: () => { clock = NOW + 1000; decision = "approved"; }, elapse: () => {} });
    assert.equal(result.result.status, "completed");
    // Collection can find the acceptance before the deadline activity: either path preserves its saved result.
    assert.ok(result.activities.some(item => item.name === "collect"));
    decision = null;
    clock = NOW;
    const timeout = execute({ now: () => clock, saved: () => decision, deadline: NOW + 1000,
        next: () => { clock += 1000; }, elapse: () => { decision = "timed_out"; } });
    assert.equal(timeout.result.status, "completed");
    assert.equal(timeout.activities.filter(item => item.name === "elapseApproval").length, 1);
    assert.equal(timeout.activities.filter(item => item.name === "elapse").length, 0);
    assert.deepEqual(timeout.starts, []);
});
test("test mode creates an approval interception and still starts no live helper", () => {
    let decision = null;
    const result = execute({ testMode: true, saved: () => decision, next: () => { decision = "rejected"; return WAKE; } });
    assert.equal(result.result.status, "completed");
    assert.equal(result.activities.filter(item => item.name === "interceptApproval").length, 1);
    assert.deepEqual(result.starts, []);
});
test("the approval path is unavailable to a controller admitted at 1.0.0", () => {
    const result = execute({ version: "1.0.0" });
    assert.equal(result.result.status, "failed");
    assert.match(result.activities.find(item => item.name === "finish").input.failure.message, /plan node consent type is invalid/);
});
