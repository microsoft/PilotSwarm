import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKFLOW_CONTROLLER_REGISTRY } from "../../dist/workflow/controller-registry.js";
import { WORKFLOW_CONTROLLER_VERSION } from "../../dist/workflow/controller-version.js";
import { recordControllerHistory, replayControllerHistory } from "../helpers/workflow-controller-history.mjs";

const recordings = JSON.parse(readFileSync(new URL("../fixtures/workflow-controller-history.json", import.meta.url)));
const handlerOf = version => WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === version).handler;

test("history provenance names main 1.0.0 and the bound 1.1.0", () => {
    assert.deepEqual(recordings.sources.map(({ commit, version, sha256 }) => [commit, version, sha256]), [
        ["8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8", "1.0.0", "adbe5d32756e7bf7529fd2ee3e1adc1c491afb066a40170345280620dc8fbe18"],
        ["a684aab367ba47605a41b63d0c828d1be63ff0bb", "1.1.0", "b5ced672d42196fa75d9bbce3616fb05b08a50006a9169c7416a9a2b3795a373"],
    ]);
    assert.ok(recordings.histories.length >= 25);
    assert.notEqual(handlerOf("1.0.0"), handlerOf("1.1.0"));
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
