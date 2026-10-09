import test from "node:test";
import assert from "node:assert/strict";

import {
    WorkflowGeneratorController,
    runWorkflowGeneratorOnce,
} from "../dist/index.js";

test("run-once evaluates generators without legacy run induction", async () => {
    const calls = [];
    await runWorkflowGeneratorOnce({
        controller: {
            async runOnce() {
                calls.push("generator");
                return 1;
            },
        },
    });

    assert.deepEqual(calls, ["generator"]);
});

test("generator evaluation records discovery without materializing legacy runs", async () => {
    const completed = [];
    const store = {
        async claimDueWorkflowGenerators() {
            return [{
                workflowGeneratorId: "generator-1",
                name: "acceptance",
                sourceType: "test",
            }];
        },
        async beginWorkflowGeneratorCycle() {
            return {
                cycle: {
                    cycleId: "cycle-1",
                    watermarkBefore: null,
                },
                definition: {
                    guardrails: {},
                },
            };
        },
        async completeWorkflowGeneratorCycle(input) {
            completed.push(input);
        },
    };
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([[
            "test",
            {
                async evaluate() {
                    return {
                        discoveries: [{ key: "item-1", payload: { id: 1 } }],
                        watermark: { cursor: 1 },
                    };
                },
            },
        ]]),
        workerId: "worker-1",
        controllerCompute: "cluster",
    });

    assert.equal(await controller.runOnce(), 1);
    assert.deepEqual(completed, [{
        cycleId: "cycle-1",
        workerId: "worker-1",
        status: "succeeded",
        watermark: { cursor: 1 },
        discoveredCount: 1,
        createdCount: 0,
    }]);
});
