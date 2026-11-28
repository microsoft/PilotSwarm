import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKFLOW_CONTROLLER_REGISTRY } from "../../dist/workflow/controller-registry.js";
import { WORKFLOW_CONTROLLER_VERSION } from "../../dist/workflow/controller-version.js";
import { recordControllerHistory, replayControllerHistory } from "../helpers/workflow-controller-history.mjs";

const recordings = JSON.parse(readFileSync(new URL("../fixtures/workflow-controller-history.json", import.meta.url)));
const handlerOf = version => WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === version).handler;

test("history provenance names main 1.0.0, the bound 1.1.0 and the live 1.2.0 Decision recording", () => {
    assert.deepEqual(recordings.sources.map(({ commit, version, sha256 }) => [commit, version, sha256]), [
        ["8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8", "1.0.0", "adbe5d32756e7bf7529fd2ee3e1adc1c491afb066a40170345280620dc8fbe18"],
        ["a684aab367ba47605a41b63d0c828d1be63ff0bb", "1.1.0", "b5ced672d42196fa75d9bbce3616fb05b08a50006a9169c7416a9a2b3795a373"],
        // The live 1.2.0 generator's controller/index.ts at the commit; runtimeSha256 pins its controller/runtime.ts.
        ["911c55582f08b4165ed58d4a0884a6610137e46b", "1.2.0", "4f0541325c29b30df074c7991df617486be9c6eddffc04dda49071122e9a45f8"],
    ]);
    assert.equal(recordings.sources[2].runtimeSha256, "771916d560588cfaec0520f3d5fbce5dfce45e0040b1d7723d9484d06e264a4f");
    assert.equal(recordings.sources[2].recordedFrom, "live");
    assert.ok(recordings.histories.length >= 25);
    assert.notEqual(handlerOf("1.0.0"), handlerOf("1.1.0"));
    assert.notEqual(handlerOf("1.1.0"), handlerOf("1.2.0"));
    // Only the live 1.2.0 recording holds Decision states: the frozen parsers refuse them.
    for (const history of recordings.histories) {
        const plan = history.events.find(({ task }) => task.name === "workflow.plan")?.reply;
        const decision = Object.values(plan?.nodes ?? {}).some(node => node.type === "decision");
        assert.equal(decision, history.version === "1.2.0", `${history.version} ${history.scenario.name}`);
    }
});

for (const history of recordings.histories) {
    test(`${history.version} replays recorded ${history.scenario.name} with an identical schedule`, () => {
        const { handler } = WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === history.version);
        replayControllerHistory(handler, history, WORKFLOW_CONTROLLER_VERSION);
    });
}

for (const name of ["script-success", "carry-script-error", "store-retry"]) {
    test(`the latest controller preserves the 1.1.0 script schedule: ${name}`, () => {
        const history = recordings.histories.find(item => item.version === "1.1.0" && item.scenario.name === name);
        assert.ok(history, `missing recorded 1.1.0 history: ${name}`);
        replayControllerHistory(handlerOf(WORKFLOW_CONTROLLER_VERSION), history, WORKFLOW_CONTROLLER_VERSION);
    });
}

test("the frozen 1.1.0 parser accepts a script plan, not a Decision plan", async () => {
    const history = recordings.histories.find(item => item.version === "1.1.0" && item.scenario.name === "script-success");
    const scriptPlan = history.events.find(({ task }) => task.name === "workflow.plan").reply;
    const { parsePlan } = await import("../../dist/workflow/controller_1_1_0/runtime.js");
    assert.equal(parsePlan(scriptPlan).nodes.work.type, "script");
    const decisionPlan = { ...scriptPlan, nodes: { ...scriptPlan.nodes, work: { ...scriptPlan.nodes.work, type: "decision" } } };
    assert.throws(() => parsePlan(decisionPlan), /plan node work type is invalid/);
    assert.throws(() => parsePlan({ ...decisionPlan, test: true }), /plan node work type is invalid/);
});

function decisionSchedule(options) {
    const scenario = { name: "decision", type: "decision", outcome: "accepted", ...options };
    return recordControllerHistory(handlerOf(WORKFLOW_CONTROLLER_VERSION), scenario, WORKFLOW_CONTROLLER_VERSION)
        .events.map(({ task }) => task);
}

test("the latest controller starts the Decision effect version with an explicit nodeType", () => {
    const schedule = decisionSchedule();
    assert.deepEqual(schedule.filter(task => task.kind === "start").map(({ name, version, input }) => ({ name, version, input })), [{
        name: "workflow-effect",
        version: "1.1.0",
        input: { runId: "history-run", nodeExecutionId: "nx-aa", controllerInstanceId: "history-controller", nodeType: "decision" },
    }]);
    assert.ok(!schedule.some(task => task.name === "workflow.intercept"));
});

for (const realAgents of [false, true]) {
    test(`the latest controller intercepts a test Decision without starting an effect (realAgents: ${realAgents})`, () => {
        const schedule = decisionSchedule({ test: true, realAgents });
        assert.ok(!schedule.some(task => task.kind === "start"));
        assert.deepEqual(schedule.filter(task => task.name === "workflow.intercept").map(task => task.input), [
            { runId: "history-run", nodeExecutionId: "nx-aa" },
        ]);
    });
}

// ── The recorded 1.2.0 Decision histories (live handler at 911c5558) ──

const recorded120 = name => {
    const history = recordings.histories.find(item => item.version === "1.2.0" && item.scenario.name === name);
    assert.ok(history, `missing recorded 1.2.0 history: ${name}`);
    return history;
};

for (const [name, outcome, route] of [["decision-live-route", "yes", "yes"], ["decision-live-uncertain", "uncertain", "uncertain"],
    ["decision-live-unavailable", "unavailable", "unavailable"]]) {
    test(`recorded 1.2.0 ${name}: one Decision effect start at 1.1.0 with nodeType decision, then the stored ${outcome} routes`, () => {
        const history = recorded120(name);
        const tasks = history.events.map(({ task }) => task);
        assert.deepEqual(tasks.filter(task => task.kind === "start"), [{
            kind: "start", name: "workflow-effect", version: "1.1.0", id: tasks.find(task => task.kind === "start").id,
            input: { runId: "history-run", nodeExecutionId: "nx-aa", controllerInstanceId: "history-controller", nodeType: "decision" },
        }]);
        assert.ok(!tasks.some(task => task.name === "workflow.intercept"));
        const collected = history.events.find(({ task, reply }) => task.name === "workflow.collect" && reply.collected.length > 0);
        assert.equal(collected.reply.collected[0].outcome, outcome);
        const next = history.events.find(({ task }) => task.name === "workflow.enter" && task.input.nodeId === "done");
        assert.deepEqual([next.task.input.predecessorId, next.task.input.arrivalRoute], ["nx-aa", route]);
        assert.equal(history.result.status, "completed");
    });
}

for (const name of ["decision-test-intercept", "decision-test-intercept-real-agents"]) {
    test(`recorded 1.2.0 ${name}: the test Decision is intercepted and starts no effect`, () => {
        const tasks = recorded120(name).events.map(({ task }) => task);
        assert.ok(!tasks.some(task => task.kind === "start"));
        assert.deepEqual(tasks.filter(task => task.name === "workflow.intercept").map(task => task.input),
            [{ runId: "history-run", nodeExecutionId: "nx-aa" }]);
    });
}

test("recorded 1.2.0 decision-continue-as-new: the resumed execution keeps the pending Decision and starts no second effect", () => {
    const moved = recorded120("decision-continue-as-new");
    const resumed = recorded120("decision-continue-as-new-resumed");
    assert.ok(moved.can && !resumed.can);
    assert.deepEqual(resumed.input, moved.can.input);
    assert.equal(moved.events.filter(({ task }) => task.kind === "start").length, 1);
    assert.ok(!resumed.events.some(({ task }) => task.kind === "start"));
    assert.equal(resumed.result.status, "completed");
});

// ── Phase 3 I7: pass-over replay histories on the unchanged 1.3.0 controller ──

const passoverRecordings = JSON.parse(readFileSync(new URL("../fixtures/workflow-rerun-passover-history.json", import.meta.url)));

test("pass-over histories pin the unchanged controller version and never start effects on reused/supplied steps", () => {
    assert.equal(passoverRecordings.controllerVersion, WORKFLOW_CONTROLLER_VERSION);
    assert.equal(passoverRecordings.histories.length, 6);
    const byName = Object.fromEntries(passoverRecordings.histories.map(h => [h.scenario.name, h]));
    // script-and-agent: step1 + agent1 passed over (0 starts), only post-cut step2 starts 1 workflow-effect; agent1 gets endAgent no-op.
    const saTasks = byName["rerun-passover-script-and-agent"].events.map(({ task }) => task);
    assert.deepEqual(saTasks.filter(t => t.kind === "start").map(t => t.input.nodeExecutionId), ["nx-step2"]);
    assert.ok(!saTasks.some(t => t.name === "workflow.spawnAgent"));
    // supply-to-terminal: 0 effects started!
    const stTasks = byName["rerun-passover-supply-to-terminal"].events.map(({ task }) => task);
    assert.equal(stTasks.filter(t => t.kind === "start").length, 0);
    // parallel: step1 + fan passed over (0 lane enters), only finish starts 1 workflow-effect!
    const parTasks = byName["rerun-passover-parallel"].events.map(({ task }) => task);
    assert.deepEqual(parTasks.filter(t => t.kind === "start").map(t => t.input.nodeExecutionId), ["nx-finish"]);
    assert.ok(!parTasks.some(t => t.name === "workflow.enter" && t.input.nodeId === "lane"));
    // supplied agent V': step1 reused + agent1 supplied ("override") passed over with 0 starts and no spawnAgent; only step2 starts!
    const supAgentTasks = byName["rerun-passover-supplied-agent"].events.map(({ task }) => task);
    assert.deepEqual(supAgentTasks.filter(t => t.kind === "start").map(t => t.input.nodeExecutionId), ["nx-step2"]);
    assert.ok(!supAgentTasks.some(t => t.name === "workflow.spawnAgent"));
    assert.ok(supAgentTasks.some(t => t.name === "workflow.endAgents"));
    // 25-admission continue-as-new pass-over: s1..s25 passed over (0 starts) -> continue-as-new -> s26 passed over -> only s27 starts!
    const canMoved = byName["rerun-passover-continue-as-new"];
    const canResumed = byName["rerun-passover-continue-as-new-resumed"];
    assert.ok(canMoved.can && !canResumed.can);
    assert.deepEqual(canResumed.input, canMoved.can.input);
    assert.equal(canMoved.events.filter(({ task }) => task.kind === "start").length, 0);
    assert.deepEqual(
        canResumed.events.filter(({ task }) => task.kind === "start").map(({ task }) => task.input.nodeExecutionId),
        ["nx-s27"],
    );
    assert.equal(canResumed.result.status, "completed");
});

for (const history of passoverRecordings.histories) {
    test(`${history.version} replays pass-over ${history.scenario.name} with an identical schedule`, () => {
        replayControllerHistory(handlerOf(history.version), history, WORKFLOW_CONTROLLER_VERSION);
    });
}

