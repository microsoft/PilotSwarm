/**
 * FB-064: a running Workflow moves to the latest controller at continue-as-new, as a durable session moves to the latest
 * orchestration. Duroxide records only the continue-as-new input in history, not its target, so the frozen 1.0.0
 * controller targets the shared latest version. The one requirement is that the input stays backwards compatible:
 * - the latest parser reads every ControllerInput shape that an older version writes, as that version reads it;
 * - each recorded 1.0.0 continue-as-new input resumes on the latest controller with the recorded 1.0.0 schedule;
 * - at every point where 1.0.0 continues as new (an idle wait limit with a pending request, a pending agent, a parallel
 *   state with running branches, owed cuts, an accepted stop, a test run's intercepted agent or an entered catch-all
 *   state; the admission limit), the latest controller resumes the carried state exactly as 1.0.0 would, also when the
 *   run's deadline passes, a cancel is dequeued or the run ended in the store after the move: both run in lockstep
 *   against one scripted store and must schedule the same work;
 * - every continue-as-new targets the highest registered version, so a run never moves down.
 *
 * Run: node --test test/unit/workflow-controller-handoff.test.mjs (after npm run build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    WORKFLOW_CONTROLLER_REGISTRY, assertWorkflowControllerContinueAsNewTarget, compareWorkflowControllerVersions,
} from "../../dist/workflow/controller-registry.js";
import { WORKFLOW_CONTROLLER_VERSION, WORKFLOW_CONTROLLER_VERSIONS } from "../../dist/workflow/controller-version.js";
import { parseControllerInput as parseLatest } from "../../dist/workflow/controller/runtime.js";
import {
    WORKFLOW_ADMISSIONS_PER_EXECUTION, WORKFLOW_COMMAND_POLL_MS, branchScopeId, parseControllerInput as parse_1_0_0,
} from "../../dist/workflow/controller_1_0_0/runtime.js";
import { replayControllerHistory } from "../helpers/workflow-controller-history.mjs";

const recordings = JSON.parse(readFileSync(new URL("../fixtures/workflow-controller-history.json", import.meta.url)));
const handlerOf = version => WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === version).handler;
const FROZEN = handlerOf("1.0.0");
const LATEST = handlerOf(WORKFLOW_CONTROLLER_VERSION);
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const NOW = 1_794_528_000_000;
const FAR = NOW + 36_000_000;
const RUN = "handoff-run";
const START = { v: 1, workflowSessionId: "handoff-workflow", runId: RUN };

test("the latest controller is a different handler from 1.0.0", () => {
    assert.notEqual(WORKFLOW_CONTROLLER_VERSION, "1.0.0");
    assert.notEqual(LATEST, FROZEN);
});

test("every continue-as-new targets the highest registered version: a run never moves down", () => {
    assert.equal(WORKFLOW_CONTROLLER_REGISTRY.at(-1).version, WORKFLOW_CONTROLLER_VERSION);
    for (const { version } of WORKFLOW_CONTROLLER_REGISTRY) {
        assert.ok(compareWorkflowControllerVersions(WORKFLOW_CONTROLLER_VERSION, version) >= 0, version);
    }
    assert.doesNotThrow(() => assertWorkflowControllerContinueAsNewTarget(WORKFLOW_CONTROLLER_VERSIONS, WORKFLOW_CONTROLLER_VERSION));
    // A mutant that targets an older version is refused when the registry loads.
    assert.throws(() => assertWorkflowControllerContinueAsNewTarget(["1.0.0", "1.1.0"], "1.0.0"), /would move down/);
    assert.ok(compareWorkflowControllerVersions("1.10.0", "1.9.0") > 0, "versions compare numerically");
    assert.throws(() => compareWorkflowControllerVersions("1.0", "1.0.0"), /major\.minor\.patch/);
});

// ── ControllerInput shapes ──────────────────────────────────────────

const cursor = (fields = {}) => ({ scopeId: "root", nodeId: "work", predecessorId: null, arrivalRoute: null, pending: null, deadlineMs: null, ...fields });
const SHAPES = {
    "the first execution's input (no state)": START,
    "a minimal carried state": { ...START, state: { irSha256: "ir", steps: 0, ordinals: {}, cursors: [cursor()], catchAllEntered: false } },
    "a state whose optional fields are absent": {
        ...START,
        state: { irSha256: "ir", steps: 3, ordinals: { "root/work": 3 }, cursors: [{ scopeId: "root", nodeId: "work", predecessorId: "nx-0a", arrivalRoute: "next", pending: "nx-0b" }] },
    },
    "a state with every optional field": {
        ...START,
        state: {
            irSha256: "ir", steps: 9, ordinals: { "root/fan": 1, [`${branchScopeId("nx-01", 0)}/branch`]: 2 }, catchAllEntered: true,
            cursors: [
                cursor({ nodeId: "fan", pending: "nx-01", deadlineMs: FAR }),
                cursor({ scopeId: branchScopeId("nx-01", 0), nodeId: "branch", predecessorId: "nx-01", arrivalRoute: "@branch", pending: "nx-02", deadlineMs: FAR }),
            ],
            parallels: [{
                nodeExecutionId: "nx-01", nodeId: "fan", total: 4, nextIndex: 4, cancelled: true,
                results: [
                    { index: 1, nodeExecutionId: "nx-03", via: "terminal" }, { index: 2, nodeExecutionId: "nx-04", via: "error" },
                    { index: 3, nodeExecutionId: null, via: "not_started" },
                ],
            }],
            owedCuts: [
                { scopeId: branchScopeId("nx-05", 0), reason: "failFast" }, { scopeId: branchScopeId("nx-05", 1), reason: "join" },
                { scopeId: branchScopeId("nx-05", 2), reason: "timeout" },
            ],
        },
    },
};

test("the latest parser reads every ControllerInput shape an older version writes, as 1.0.0 reads it", () => {
    const recorded = recordings.histories.flatMap(history => [history.input, ...(history.can ? [history.can.input] : [])]);
    assert.ok(recorded.length >= 30);
    for (const [name, shape] of [...Object.entries(SHAPES), ...recorded.map((shape, index) => [`recorded input ${index}`, shape])]) {
        assert.deepEqual(parseLatest(copy(shape)), parse_1_0_0(copy(shape)), name);
    }
    // An absent optional field takes the older behaviour's default.
    const defaults = parseLatest(copy(SHAPES["a state whose optional fields are absent"])).state;
    assert.equal(defaults.catchAllEntered, false);
    assert.equal(defaults.cursors[0].deadlineMs, null);
    assert.ok(!("parallels" in defaults) && !("owedCuts" in defaults));
    // What 1.0.0 wrote at a continue-as-new is read back unchanged.
    for (const history of recordings.histories.filter(item => item.version === "1.0.0" && item.can)) {
        assert.deepEqual(parseLatest(copy(history.can.input)), history.can.input, history.scenario.name);
    }
});

// ── Recorded continue-as-new points ─────────────────────────────────

test("each recorded 1.0.0 continue-as-new input resumes on the latest controller with the recorded 1.0.0 schedule", () => {
    const moved = recordings.histories.filter(history => history.version === "1.0.0" && history.can);
    assert.deepEqual(moved.map(history => history.scenario.name).sort(), ["idle-continue-as-new", "paused-continue-as-new"]);
    for (const history of moved) {
        const resumed = recordings.histories.find(item => item.version === "1.0.0" && item.scenario.name === `${history.scenario.name}-resumed`);
        assert.ok(resumed, `${history.scenario.name}: no recorded resumed execution`);
        assert.deepEqual(resumed.input, history.can.input);
        assert.ok(resumed.events.length > 0 && !resumed.can && resumed.result, history.scenario.name);
        replayControllerHistory(LATEST, resumed, WORKFLOW_CONTROLLER_VERSION);
    }
});

// ── Lockstep at every continue-as-new point ─────────────────────────

function context(statuses) {
    const activity = (name, input) => ({ kind: "activity", name, input, withTag(tag) { return { kind: "activity", name, input, tag }; } });
    return {
        instanceId: "handoff-controller",
        setCustomStatus: value => statuses.push(JSON.parse(value)),
        traceInfo() {}, traceWarn() {}, traceError() {}, traceDebug() {},
        utcNow: () => ({ kind: "clock" }),
        scheduleTimer: ms => ({ kind: "timer", ms }),
        dequeueEvent: queue => ({ kind: "queue", queue }),
        race: (...tasks) => ({ kind: "race", tasks }),
        scheduleActivityTyped: activity,
        continueAsNewVersioned: (input, version) => ({ kind: "can", input, version }),
        startOrchestrationVersioned: (name, version, id, input) => ({ kind: "start", name, version, id, input }),
    };
}

/**
 * A store that answers both controllers alike. `phase` 1 is the 1.0.0 execution that continues as new (nothing that the
 * scenario keeps waiting is decided); phase 2 is the continued execution, in which the scenario's work is decided and
 * the run ends. Node execution ids follow the store's form (nx-<hex>), one per admission.
 */
function scriptedStore(scenario) {
    const ids = new Map();
    const entered = new Map();
    const joined = new Set();
    const store = { phase: 1, entered, joined };
    const idOf = input => {
        const key = `${input.scopeId}/${input.nodeId}/${input.ordinal}`;
        if (!ids.has(key)) ids.set(key, `nx-${(ids.size + 1).toString(16).padStart(6, "0")}`);
        return ids.get(key);
    };
    const activity = (name, input) => {
        const { plan } = scenario;
        switch (name) {
            case "begin": return { status: "running", irSha256: "handoff-ir", initial: plan.initial, outcome: null };
            case "plan": return plan;
            case "enter": {
                const node = plan.nodes[input.nodeId];
                const nodeExecutionId = idOf(input);
                entered.set(nodeExecutionId, { nodeId: input.nodeId, scopeId: input.scopeId, type: node.type });
                if (node.type === "terminal") return { admitted: true, nodeExecutionId, state: "completed" };
                if (node.type === "parallel") return { admitted: true, nodeExecutionId, state: "pending", branches: scenario.items };
                if (node.type === "script") return { admitted: true, nodeExecutionId, state: "pending" };
                return { admitted: true, nodeExecutionId, state: "pending", deadlineMs: FAR };
            }
            case "collect": {
                const collected = input.nodeExecutionIds.flatMap(nodeExecutionId => {
                    const decided = scenario.decide({ nodeExecutionId, ...entered.get(nodeExecutionId) }, store);
                    return decided ? [{ nodeExecutionId, resultKind: "business", ...decided }] : [];
                });
                return { collected, ...(scenario.stopping ? { stopping: { deadlineMs: FAR } } : {}),
                    ...(store.phase === 2 && scenario.endedInStore ? { ended: true } : {}) };
            }
            case "elapse": return { notDue: [] };
            case "join": joined.add(input.parallelNodeExecutionId); return { decided: true, cut: "join" };
            case "cancelBranches": return { owedScopeIds: store.phase === 1 && scenario.owe ? input.scopeIds : [] };
            case "endBranch": return { succeeded: true };
            case "finish": return input.failure ? { runId: input.runId, status: "failed", outcome: null } : { runId: input.runId, status: "completed", outcome: "succeeded" };
            case "stop": return { ended: true, result: { runId: input.runId, status: "stopped", outcome: null } };
            case "expire": return { ended: true, expired: true, result: { runId: input.runId, status: "failed", outcome: null } };
            case "cancel": return { runId: input.runId, status: "cancelled", outcome: null };
            case "observeEnd": return { runId: input.runId, status: "cancelled", outcome: null, deleted: false };
            case "observe": case "endAgent": case "endAgents": case "notifyParent": case "intercept": return null;
            default: throw new Error(`${scenario.name}: unscripted activity ${name}`);
        }
    };
    store.answer = task => {
        switch (task.kind) {
            case "clock": return store.phase === 2 && scenario.clockAfterMove ? scenario.clockAfterMove : NOW;
            case "timer": case "start": return null;
            case "race":
                // The continued execution's first idle wait dequeues a cancel when the scenario sends one.
                if (store.phase === 2 && scenario.cancelAfterMove && !store.cancelSent && task.tasks[1].ms !== WORKFLOW_COMMAND_POLL_MS) {
                    store.cancelSent = true;
                    return { index: 0, value: JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "stop it" } }) };
                }
                // Otherwise no command and no wake: the timer wins every race (a command poll's, or an idle wait's).
                return { index: 1 };
            case "activity": return activity(task.name.slice("workflow.".length), task.input);
            default: throw new Error(`${scenario.name}: unexpected task ${JSON.stringify(task)}`);
        }
    };
    return store;
}

/** Run 1.0.0 and the latest controller from one input against one store; each step must schedule the same task. */
function lockstep(input, store) {
    const runs = [{ version: "1.0.0", handler: FROZEN }, { version: WORKFLOW_CONTROLLER_VERSION, handler: LATEST }]
        .map(({ version, handler }) => { const statuses = []; return { version, statuses, generator: handler(context(statuses), copy(input)) }; });
    const schedule = [];
    let reply;
    for (let step = 0; step < 20_000; step += 1) {
        const [first, ...others] = runs.map(run => { const next = run.generator.next(copy(reply)); return copy({ done: next.done, value: next.value }); });
        for (const [index, other] of others.entries()) {
            assert.deepEqual(other, first, `1.0.0 and ${runs[index + 1].version} diverged at step ${step}`);
        }
        if (first.done || first.value.kind === "can") {
            assert.deepEqual(runs[1].statuses, runs[0].statuses, "published statuses differ");
            return { schedule, statuses: runs[0].statuses, ...(first.done ? { result: first.value } : { can: first.value }) };
        }
        schedule.push(first.value);
        reply = store.answer(first.value);
    }
    throw new Error("the controllers did not settle");
}

const names = schedule => schedule.filter(task => task.kind === "activity").map(task => task.name.slice("workflow.".length));
const plan = (initial, nodes, extra = {}) => ({ name: "handoff", version: "1.0.0", initial, maxNodeExecutions: 100, wakeBackstopMs: 30_000, catchAll: null, nodes, ...extra });
const terminal = { type: "terminal", next: {} };
const isBranch = (entry, index) => entry.scopeId?.endsWith(`#${index}`);

const SCENARIOS = [
    {
        name: "a pending request at the idle wait limit",
        plan: plan("ask", { ask: { type: "messaging", mode: "request", next: { responded: "done" } }, done: terminal }),
        decide: (entry, store) => store.phase === 2 && entry.nodeId === "ask" ? { outcome: "responded" } : null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null, item.deadlineMs]), [["ask", true, FAR]]),
        resumed: schedule => assert.ok(names(schedule).includes("observe"), "the continued execution observes the responder"),
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "a pending agent at the idle wait limit",
        plan: plan("work", { work: { type: "agent", next: { succeeded: "done" } }, done: terminal }),
        decide: (entry, store) => store.phase === 2 && entry.nodeId === "work" ? { outcome: "succeeded" } : null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null, item.deadlineMs]), [["work", true, FAR]]),
        resumed: schedule => assert.deepEqual(names(schedule).filter(name => name === "endAgent"), ["endAgent"]),
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "a parallel state with running branches at the idle wait limit",
        items: 3,
        plan: plan("fan", {
            fan: { type: "parallel", next: { joined: "done" }, parallel: { initial: "branch", concurrency: 2, failFast: false } },
            branch: { type: "agent", next: { succeeded: "branchEnd" } }, branchEnd: terminal, done: terminal,
        }),
        decide: (entry, store) => {
            if (store.phase !== 2) return null;
            if (entry.nodeId === "branch") return { outcome: "succeeded" };
            return entry.type === "parallel" && store.joined.has(entry.nodeExecutionId) ? { outcome: "joined" } : null;
        },
        carried: state => {
            assert.equal(state.parallels.length, 1);
            assert.deepEqual({ ...state.parallels[0], nodeExecutionId: undefined }, { nodeExecutionId: undefined, nodeId: "fan", total: 3, nextIndex: 2, results: [], cancelled: false });
            assert.equal(state.cursors.filter(item => item.scopeId !== "root" && item.pending !== null).length, 2);
        },
        resumed: schedule => {
            assert.equal(names(schedule).filter(name => name === "endBranch").length, 3);
            assert.equal(names(schedule).filter(name => name === "join").length, 1);
        },
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "owed cuts at the idle wait limit",
        items: 3,
        owe: true,
        plan: plan("fan", {
            fan: { type: "parallel", next: { joined: "done", blocked: "done" }, parallel: { initial: "branch", concurrency: 3, failFast: true } },
            branch: { type: "script", next: { succeeded: "branchEnd" } }, branchEnd: terminal, done: terminal,
        }),
        decide: (entry, store) => {
            if (store.phase === 1) return entry.nodeId === "branch" && isBranch(entry, 0) ? { outcome: "boom", resultKind: "runtime_error" } : null;
            return entry.type === "parallel" && store.joined.has(entry.nodeExecutionId) ? { outcome: "blocked" } : null;
        },
        carried: state => {
            const fan = state.cursors[0].pending;
            assert.deepEqual(state.owedCuts, [{ scopeId: branchScopeId(fan, 1), reason: "failFast" }, { scopeId: branchScopeId(fan, 2), reason: "failFast" }]);
        },
        resumed: schedule => {
            // The continued execution's first pass tries the owed cuts again, before it collects.
            const activities = names(schedule);
            assert.ok(activities.indexOf("cancelBranches") >= 0 && activities.indexOf("cancelBranches") < activities.indexOf("collect"), JSON.stringify(activities));
        },
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "an accepted stop at the idle wait limit",
        stopping: true,
        plan: plan("work", { work: { type: "agent", next: { succeeded: "after" } }, after: { type: "wait", next: { elapsed: "done" } }, done: terminal }),
        decide: (entry, store) => store.phase === 2 && entry.nodeId === "work" ? { outcome: "succeeded" } : null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null]), [["work", true]]),
        // The stop is store state, read again by the continued execution: it settles the agent and admits nothing more.
        resumed: schedule => {
            assert.ok(names(schedule).includes("stop"));
            assert.ok(!schedule.some(task => task.name === "workflow.enter"), "a stopping run admits nothing");
        },
        end: { status: "stopped", outcome: null },
    },
    {
        name: "the admission limit",
        plan: plan("work", { work: { type: "script", next: { again: "work", finished: "done" } }, done: terminal }),
        decide: (entry, store) => entry.nodeId === "work" ? { outcome: store.phase === 1 ? "again" : "finished" } : null,
        carried: state => {
            assert.equal(state.steps, WORKFLOW_ADMISSIONS_PER_EXECUTION);
            assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending]), [["work", null]]);
        },
        resumed: schedule => assert.equal(schedule.find(task => task.name === "workflow.enter").input.ordinal, WORKFLOW_ADMISSIONS_PER_EXECUTION + 1),
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "a test run's intercepted agent at the idle wait limit",
        plan: plan("work", { work: { type: "agent", next: { succeeded: "done" } }, done: terminal }, { test: true }),
        decide: (entry, store) => store.phase === 2 && entry.nodeId === "work" ? { outcome: "succeeded" } : null,
        first: schedule => {
            assert.deepEqual(names(schedule).filter(name => name === "intercept"), ["intercept"]);
            assert.ok(!schedule.some(task => task.kind === "start"), "a test run's agent is intercepted, not started");
        },
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null]), [["work", true]]),
        resumed: schedule => assert.ok(!names(schedule).includes("endAgent"), "a test run's mocked agent has no child to end"),
        end: { status: "completed", outcome: "succeeded" },
    },
    {
        name: "an entered catch-all state at the idle wait limit",
        plan: plan("work", {
            work: { type: "script", next: { succeeded: "done" } }, handler: { type: "agent", next: { succeeded: "done" } }, done: terminal,
        }, { catchAll: "handler" }),
        decide: (entry, store) => {
            if (store.phase === 1) return entry.nodeId === "work" ? { outcome: "boom", resultKind: "runtime_error" } : null;
            return entry.nodeId === "handler" ? { outcome: "boom2", resultKind: "runtime_error" } : null;
        },
        carried: state => {
            assert.equal(state.catchAllEntered, true);
            assert.deepEqual(state.cursors.map(item => [item.nodeId, item.arrivalRoute, item.pending !== null]), [["handler", "@catchAll", true]]);
        },
        // The catch-all state already ran, so the moved run fails rather than entering it again.
        resumed: schedule => {
            const finish = schedule.find(task => task.name === "workflow.finish");
            assert.equal(finish.input.failure.code, "boom2");
            assert.match(finish.input.failure.message, /catch-all state already ran/);
            assert.ok(!schedule.some(task => task.name === "workflow.enter"), "the catch-all state is not entered again");
        },
        end: { status: "failed", outcome: null },
    },
    {
        name: "the run's deadline passing after the move",
        plan: plan("work", { work: { type: "agent", next: { succeeded: "done" } }, done: terminal }, { deadlineMs: NOW + 3_600_000 }),
        clockAfterMove: NOW + 7_200_000,
        decide: () => null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null]), [["work", true]]),
        resumed: schedule => assert.deepEqual(names(schedule).filter(name => name === "expire"), ["expire"]),
        end: { status: "failed", outcome: null },
    },
    {
        name: "a cancel dequeued after the move",
        plan: plan("work", { work: { type: "agent", next: { succeeded: "done" } }, done: terminal }),
        cancelAfterMove: true,
        decide: () => null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null]), [["work", true]]),
        resumed: schedule => assert.deepEqual(schedule.filter(task => task.name === "workflow.cancel").map(task => task.input.command), ["cancel"]),
        end: { status: "cancelled", outcome: null },
    },
    {
        name: "a run ended in the store while it continued as new",
        plan: plan("work", { work: { type: "agent", next: { succeeded: "done" } }, done: terminal }),
        endedInStore: true,
        decide: () => null,
        carried: state => assert.deepEqual(state.cursors.map(item => [item.nodeId, item.pending !== null]), [["work", true]]),
        // S7-DX2: a lifecycle command is store state; the continued execution finds the end at its first collection.
        resumed: schedule => {
            const activities = names(schedule);
            assert.ok(activities.includes("observeEnd") && !activities.includes("cancel"), JSON.stringify(activities));
        },
        end: { status: "cancelled", outcome: null },
    },
];

for (const scenario of SCENARIOS) {
    test(`${scenario.name}: 1.0.0 continues as new to the latest controller, which resumes the run exactly as 1.0.0 would`, () => {
        const store = scriptedStore(scenario);
        const first = lockstep(START, store);
        assert.ok(first.can, "the first execution continues as new");
        assert.equal(first.can.version, WORKFLOW_CONTROLLER_VERSION);
        scenario.first?.(first.schedule);
        scenario.carried(first.can.input.state);
        assert.deepEqual(parseLatest(copy(first.can.input)), first.can.input, "the latest parser reads the carried input unchanged");

        store.phase = 2;
        const second = lockstep(first.can.input, store);
        assert.equal(second.can, undefined, "the continued execution ends the run");
        assert.deepEqual(second.result, { runId: RUN, ...scenario.end });
        assert.ok(!names(second.schedule).includes("begin"), "a continued execution does not begin the run again");
        scenario.resumed(second.schedule);
    });
}
