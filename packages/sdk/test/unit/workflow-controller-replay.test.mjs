import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKFLOW_CONTROLLER_REGISTRY } from "../../dist/workflow/controller-registry.js";
import { replayControllerHistory } from "../helpers/workflow-controller-history.mjs";

const recordings = JSON.parse(readFileSync(new URL("../fixtures/workflow-controller-history.json", import.meta.url)));

test("history provenance names main 1.0.0 and the bound 1.1.0", () => {
    assert.deepEqual(recordings.sources.map(({ commit, version }) => [commit, version]), [
        ["8aa84d2c2c5fc5c2d55c6dd077141b75c58d3ea8", "1.0.0"], ["a684aab367ba47605a41b63d0c828d1be63ff0bb", "1.1.0"],
    ]);
    assert.ok(recordings.histories.length >= 25);
    assert.notEqual(WORKFLOW_CONTROLLER_REGISTRY[0].handler, WORKFLOW_CONTROLLER_REGISTRY[1].handler);
});

for (const history of recordings.histories) {
    test(`${history.version} replays recorded ${history.scenario.name} with an identical schedule`, () => {
        const { handler } = WORKFLOW_CONTROLLER_REGISTRY.find(entry => entry.version === history.version);
        replayControllerHistory(handler, history);
    });
}
