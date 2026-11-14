import assert from "node:assert/strict";

const NOW = 1794528000000;
const INPUT = { v: 1, workflowSessionId: "history-workflow", runId: "history-run" };
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export const controllerHistoryScenarios = [
    { name: "script-success", type: "script", outcome: "succeeded" },
    { name: "carry-script-error", type: "script", outcome: "failure", error: true, carry: true },
    { name: "carry-send-receipt", type: "messaging", mode: "send", outcome: "sent", carry: true },
    { name: "wait-deadline", type: "wait", outcome: "elapsed", timeout: true },
    { name: "carry-agent-completion", type: "agent", outcome: "succeeded", carry: true },
    { name: "request-response", type: "messaging", mode: "request", outcome: "responded" },
    { name: "cancel-before-admission", type: "script", outcome: "succeeded", cancel: true },
    { name: "store-retry", type: "script", outcome: "succeeded", retry: true },
    { name: "idle-continue-as-new", type: "wait", outcome: "elapsed", forever: true },
    { name: "paused-continue-as-new", type: "wait", outcome: "elapsed", forever: true, pause: true },
    { name: "approval-decision", type: "approval", outcome: "approved" },
    { name: "approval-timeout", type: "approval", outcome: "timed_out", timeout: true, error: true },
    { name: "approval-test-intercept", type: "approval", outcome: "rejected", test: true },
    { name: "approval-paused-resume", type: "approval", outcome: "approved", pause: true },
    { name: "approval-continue-as-new", type: "approval", outcome: "approved", forever: true },
];

function context() {
    const statuses = [];
    const activity = (name, input) => ({
        kind: "activity", name, input,
        withTag(tag) { this.tag = tag; return this; },
    });
    return {
        statuses,
        ctx: {
            instanceId: "history-controller",
            setCustomStatus: value => statuses.push(JSON.parse(value)),
            traceInfo() {}, traceWarn() {}, traceError() {}, traceDebug() {},
            utcNow: () => ({ kind: "clock" }),
            scheduleTimer: ms => ({ kind: "timer", ms }),
            dequeueEvent: queue => ({ kind: "queue", queue }),
            race: (...tasks) => ({ kind: "race", tasks }),
            scheduleActivityTyped: activity,
            continueAsNewVersioned: (input, version) => ({ kind: "can", input, version }),
            startOrchestrationVersioned: (name, version, id, input) => ({ kind: "start", name, version, id, input }),
        },
    };
}

export function recordControllerHistory(controller, scenario, version, input = INPUT) {
    const { ctx, statuses } = context();
    const initial = copy(input);
    const generator = controller(ctx, copy(input), version);
    const events = [];
    let waits = 0;
    let clock = NOW;
    let decided = false;
    let retried = false;
    let reply;
    let failure;
    const work = {
        type: scenario.type, ...(scenario.mode ? { mode: scenario.mode } : {}),
        next: { [scenario.outcome]: "done" },
        ...(scenario.carry ? { carry: { attempts: "{{ inputs.attempts }}" } } : {}),
    };
    const plan = {
        name: "history", version: "1.0.0", initial: "work", maxNodeExecutions: 100, wakeBackstopMs: 30000,
        catchAll: null, nodes: { work, done: { type: "terminal", next: {} } },
        ...(scenario.test ? { test: true } : {}),
    };
    const result = (status = "completed") => ({ runId: INPUT.runId, status, outcome: status === "completed" ? "succeeded" : null });
    for (let step = 0; step < 2000; step++) {
        const yielded = failure ? generator.throw(new Error(failure)) : generator.next(copy(reply));
        failure = undefined;
        reply = undefined;
        if (yielded.done) {
            assert.equal(yielded.value.status, scenario.cancel ? "cancelled" : "completed", scenario.name);
            return { scenario, version, input: initial, events, result: copy(yielded.value), statuses };
        }
        const task = yielded.value;
        const event = { task: copy(task) };
        events.push(event);
        if (task.kind === "can") {
            assert.ok(scenario.forever, `unexpected continue-as-new: ${scenario.name}`);
            // Provenance of a pinned historical source, which targeted its own version. Not replay evidence: Duroxide does
            // not record the target in history (FB-064), and replayControllerHistory compares only the input.
            assert.equal(task.version, version);
            return { scenario, version, input: initial, events, can: copy(task), statuses };
        }
        if (task.kind === "clock") reply = clock;
        else if (task.kind === "timer" || task.kind === "start") reply = null;
        else if (task.kind === "race") {
            if (task.tasks[1].ms === 10) {
                reply = scenario.cancel ? { index: 0, value: { type: "cmd", cmd: "cancel", args: { reason: "recorded cancellation" } } } : { index: 1 };
            } else {
                waits++;
                if (!scenario.forever) {
                    if (scenario.timeout) clock += 1000;
                    else decided = true;
                }
                reply = { index: 1 };
            }
        } else if (task.kind === "activity") {
            const name = task.name.slice("workflow.".length);
            switch (name) {
                case "begin":
                    if (scenario.retry && !retried) { retried = true; failure = "recorded store failure"; break; }
                    reply = { status: "running", irSha256: "history-ir", initial: "work", outcome: null };
                    break;
                case "plan": reply = plan; break;
                case "enter":
                case "enterApproval":
                    reply = task.input.nodeId === "done"
                        ? { admitted: true, nodeExecutionId: "nx-bb", state: "completed" }
                        : { admitted: true, nodeExecutionId: "nx-aa", state: "pending",
                            ...(scenario.type !== "script" ? { deadlineMs: NOW + 1000 } : {}) };
                    break;
                case "collect":
                    reply = {
                        collected: decided && task.input.nodeExecutionIds.includes("nx-aa")
                            ? [{ nodeExecutionId: "nx-aa", outcome: scenario.outcome, resultKind: scenario.error ? "runtime_error" : "business" }] : [],
                        ...(scenario.pause && (scenario.forever || waits === 1) ? { paused: true } : {}),
                    };
                    break;
                case "elapse":
                case "elapseApproval": decided = true; reply = { notDue: [] }; break;
                case "finish":
                    assert.ok(!task.input.failure, JSON.stringify(task.input.failure));
                    reply = result();
                    break;
                case "cancel": reply = result("cancelled"); break;
                case "endAgents":
                case "endAgent":
                case "notifyParent":
                case "intercept":
                case "interceptApproval":
                case "observe": reply = null; break;
                default: throw new Error(`Unrecorded activity: ${name}`);
            }
        } else throw new Error(`Unrecorded task: ${task.kind}`);
        if (failure) event.throw = failure;
        else if (reply !== undefined) event.reply = copy(reply);
    }
    throw new Error(`Controller did not settle: ${scenario.name}`);
}

/**
 * Feed the old history verbatim; no scenario logic decides the new controller's responses. A continue-as-new is compared
 * by its input: Duroxide records only the input in history, not the target (FB-064), and every registered controller
 * now targets the latest version, which the caller passes as `latestVersion`.
 */
export function replayControllerHistory(controller, history, latestVersion) {
    const { ctx, statuses } = context();
    const generator = controller(ctx, copy(history.input), history.version);
    let next = generator.next();
    for (const [index, event] of history.events.entries()) {
        assert.equal(next.done, false, `ended before history event ${index}`);
        if (event.task.kind === "can") {
            const can = copy(next.value);
            assert.equal(can.kind, "can", `schedule diverged at event ${index}`);
            assert.deepEqual(can.input, event.task.input);
            assert.deepEqual(can.input, history.can.input);
            assert.equal(typeof latestVersion, "string", "a continue-as-new needs the latest version to compare its target");
            assert.equal(can.version, latestVersion, "every continue-as-new targets the latest version");
            assert.deepEqual(statuses, history.statuses);
            return;
        }
        assert.deepEqual(copy(next.value), event.task, `schedule diverged at event ${index}`);
        next = event.throw ? generator.throw(new Error(event.throw)) : generator.next(copy(event.reply));
    }
    assert.equal(next.done, true, "new controller scheduled extra work");
    assert.deepEqual(copy(next.value), history.result);
    assert.deepEqual(statuses, history.statuses);
}
