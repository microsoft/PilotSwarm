/**
 * Workflow controller: a wake that brings no command is an idle wait in the running loop too (V-2 diagnosis,
 * 2026-11-08; decision v2-diagnosis-and-idle-wake-gap-20261108T0436).
 *
 * Before, the running loop counted only a backstop timer that fired: a run whose every cursor waits (here a ten-hour wait
 * state), under a steady stream of wakes that bring nothing, never continued as new, and one execution's history grew
 * without a bound. Now:
 * - such a run continues as new at its 50th wait (WORKFLOW_IDLE_WAITS_PER_EXECUTION), with its cursor still waiting;
 * - a command that arrives as the 50th dequeue is applied, not dropped by that continue-as-new (the command is parsed and
 *   applied first, as the paused loop does; the formal model's fault.iw-count-then-can);
 * - a wake for a completion counts too, and the completion is never skipped: the next execution's first collection finds
 *   it in the store, routes it, and the run ends normally.
 *
 * Drives the real controller generator against a fake orchestration context: store activities answer from a script,
 * the clock stays still, and the command queue's race is won by the next queued message, else by the timer. No database.
 *
 * Run: node --test test/unit/workflow-idle-wake-can.test.mjs (after npm run build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    workflowController, WORKFLOW_COMMAND_POLL_MS, WORKFLOW_CONTROLLER_VERSION, WORKFLOW_CONTROLLER_VERSIONS, WORKFLOW_IDLE_WAITS_PER_EXECUTION,
} from "../../dist/workflow/runtime.js";

const NOW = 1_794_000_000_000;
const BACKSTOP_MS = 30_000;
const RUN = "run-1";
const PLAN = {
    name: "hold", version: "1.0.0", initial: "hold", maxNodeExecutions: 100, wakeBackstopMs: BACKSTOP_MS, catchAll: null,
    nodes: {
        hold: { type: "wait", next: { elapsed: "done" } },
        done: { type: "terminal", next: {} },
    },
};
const wake = n => JSON.stringify({ type: "workflow-wake", runId: RUN, reason: `test-${n}` });
const CANCEL = JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "stop it" } });

// Every registered controller version. Each continues as new at the latest version (FB-064), so a run admitted at 1.0.0
// moves to the latest at its first continue-as-new.
const CONTROLLERS = [
    ...WORKFLOW_CONTROLLER_VERSIONS.map(version => ({ version, controller: (ctx, input) => workflowController(ctx, input, version), collected: list => ({ collected: list }) })),
];

/**
 * One controller execution from `input`. `next()` gives the message the next command-queue wait dequeues (undefined: its
 * timer wins). `holdDone()` says whether the hold's result is stored. Stops at a continue-as-new or when the generator
 * returns; every activity's short name and every counted wait (a race of the queue against a timer that is not the
 * top-of-pass command poll) are recorded.
 */
function execute({ controller, collected }, input, { next = () => undefined, holdDone = () => false, maxWaits = 400 } = {}) {
    const activities = [];
    let waits = 0;
    const ctx = {
        instanceId: "session-wf-1",
        setCustomStatus() {},
        traceInfo() {}, traceWarn() {}, traceError() {}, traceDebug() {},
        utcNow: () => ({ kind: "now" }),
        scheduleTimer: ms => ({ kind: "timer", ms }),
        dequeueEvent: queue => ({ kind: "dequeue", queue }),
        race: (left, right) => ({ kind: "race", left, right }),
        continueAsNewVersioned: (canInput, version) => ({ kind: "can", input: canInput, version }),
        startOrchestrationVersioned: () => ({ kind: "start" }),
        scheduleActivityWithRetryTyped: (name, activityInput) => ({ kind: "activity", name, input: activityInput }),
        scheduleActivityTyped: (name, activityInput) => ({ kind: "activity", name, input: activityInput,
            withTag(tag) { return { kind: "activity", name, input: activityInput, tag }; } }),
    };
    const answer = task => {
        switch (task.kind) {
            case "now": return NOW;
            case "timer": case "start": return undefined;
            case "race": {
                if (task.right.ms === WORKFLOW_COMMAND_POLL_MS) return { index: 1 };
                waits += 1;
                if (waits > maxWaits) throw new Error(`no continue-as-new after ${maxWaits} waits`);
                const message = next(waits);
                return message === undefined ? { index: 1 } : { index: 0, value: message };
            }
            case "activity": {
                const name = task.name.split(".").at(-1);
                activities.push({ name, input: task.input });
                switch (name) {
                    case "begin": return { status: "running", irSha256: "sha-1", initial: "hold", outcome: null };
                    case "plan": return PLAN;
                    case "enter": return task.input.nodeId === "hold"
                        ? { admitted: true, nodeExecutionId: "nx-hold", state: "pending", deadlineMs: NOW + 36_000_000 }
                        : { admitted: true, nodeExecutionId: "nx-done", state: "completed" };
                    case "collect": return collected(holdDone() && task.input.nodeExecutionIds.includes("nx-hold")
                        ? [{ nodeExecutionId: "nx-hold", outcome: "elapsed", resultKind: "business" }] : []);
                    case "finish": return { runId: RUN, status: "completed", outcome: "succeeded" };
                    case "cancel": return { runId: RUN, status: "cancelled", outcome: null };
                    default: return null;
                }
            }
            default: throw new Error(`unexpected task ${JSON.stringify(task)}`);
        }
    };
    const gen = controller(ctx, input);
    let value;
    for (let step = 0; step < 100_000; step += 1) {
        const yielded = gen.next(value);
        if (yielded.done) return { result: yielded.value, can: null, activities, waits };
        if (yielded.value?.kind === "can") return { result: null, can: yielded.value, activities, waits };
        value = answer(yielded.value);
    }
    throw new Error("the controller did not stop");
}

const START = { v: 1, workflowSessionId: "wf-1", runId: RUN };

for (const c of CONTROLLERS) {
    test(`${c.version}: a running controller whose cursor waits continues as new at its 50th wait under a steady stream of no-op wakes`, () => {
        const run = execute(c, START, { next: n => wake(n) });
        assert.ok(run.can, "the controller continued as new");
        assert.equal(run.waits, WORKFLOW_IDLE_WAITS_PER_EXECUTION);
        assert.equal(run.can.version, WORKFLOW_CONTROLLER_VERSION);
        // The cursor still waits on the hold, which the next execution collects.
        assert.deepEqual(run.can.input.state.cursors.map(cursor => [cursor.nodeId, cursor.pending]), [["hold", "nx-hold"]]);
        assert.equal(run.activities.filter(activity => activity.name === "enter").length, 1);
    });

    test(`${c.version}: a command that arrives as the 50th dequeue is applied, not dropped by the continue-as-new`, () => {
        const run = execute(c, START, { next: n => (n < WORKFLOW_IDLE_WAITS_PER_EXECUTION ? wake(n) : CANCEL) });
        assert.equal(run.can, null, "no continue-as-new");
        assert.equal(run.waits, WORKFLOW_IDLE_WAITS_PER_EXECUTION);
        assert.deepEqual(run.result, { runId: RUN, status: "cancelled", outcome: null });
        assert.deepEqual(run.activities.filter(activity => activity.name === "cancel").map(activity => activity.input.command), ["cancel"]);
    });

    test(`${c.version}: a wake for a completion counts too, and the next execution collects the completion and the run ends normally`, () => {
        // 49 wakes bring nothing; the 50th is the hold's completion's wake (its result is stored from then on).
        let done = false;
        const first = execute(c, START, { next: n => { if (n === WORKFLOW_IDLE_WAITS_PER_EXECUTION) done = true; return wake(n); },
            holdDone: () => done });
        assert.ok(first.can, "the controller continued as new at the completion's wake");
        assert.equal(first.waits, WORKFLOW_IDLE_WAITS_PER_EXECUTION);
        const second = execute(c, first.can.input, { holdDone: () => done });
        assert.deepEqual(second.result, { runId: RUN, status: "completed", outcome: "succeeded" });
        // Its first collection found the hold's result, routed it to the terminal, and the run finished there.
        const names = second.activities.map(activity => activity.name);
        assert.equal(names.filter(name => name === "begin").length, 0, "a continued execution does not begin again");
        assert.ok(names.indexOf("collect") < names.indexOf("enter"), JSON.stringify(names));
        assert.deepEqual(second.activities.filter(activity => activity.name === "enter").map(activity => activity.input.nodeId), ["done"]);
        assert.deepEqual(second.activities.filter(activity => activity.name === "finish").map(activity => activity.input.terminalNodeExecutionId), ["nx-done"]);
    });
}

test("without wakes the backstop timer still counts: the controller continues as new at its 50th timer", () => {
    for (const c of CONTROLLERS) {
        const run = execute(c, START);
        assert.ok(run.can, c.version);
        assert.equal(run.waits, WORKFLOW_IDLE_WAITS_PER_EXECUTION, c.version);
    }
});
