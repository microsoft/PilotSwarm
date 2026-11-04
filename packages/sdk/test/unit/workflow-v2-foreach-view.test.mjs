import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { describeWorkflowV2States, workflowV2ForEachView } from "../../dist/workflow/v2/runtime.js";

// Adversarial review SF-3: a parallel state's literal forEach list is never shown to a reader of the graph or of the
// workflow.started event; a binding is shown as its text.

const SENTINEL = "customer-4711-private";
const doc = forEach => JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "fan", version: "1.0.0" },
    initialInput: { items: [1] }, initial: "fan",
    states: {
        fan: {
            type: "parallel", forEach,
            body: { initial: "done", states: { done: { type: "terminal", outcome: "succeeded", output: "${branch.item}" } } },
            transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
        },
        finished: { type: "terminal", outcome: "succeeded" },
        stuck: { type: "terminal", outcome: "blocked" },
        failed: { type: "terminal", outcome: "failed" },
    },
});

test("a literal list is shown as its count and digest only", () => {
    const list = [{ name: SENTINEL }, { name: "b" }, 3];
    const compiled = compileWorkflowV2(doc(list), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const states = describeWorkflowV2States(compiled.ir);
    assert.ok(!JSON.stringify(states).includes(SENTINEL));
    const fan = states.find(state => state.id === "fan");
    assert.equal(fan.forEach.count, 3);
    assert.match(fan.forEach.sha256, /^[0-9a-f]{64}$/);
});

test("a binding is shown as its text", () => {
    const compiled = compileWorkflowV2(doc("${input.items}"), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(describeWorkflowV2States(compiled.ir).find(state => state.id === "fan").forEach, "${input.items}");
});

test("workflowV2ForEachView", () => {
    assert.equal(workflowV2ForEachView("${input.items}"), "${input.items}");
    const view = workflowV2ForEachView([1, 2]);
    assert.deepEqual(Object.keys(view).sort(), ["count", "sha256"]);
    assert.equal(view.count, 2);
    assert.equal(view.sha256, createHash("sha256").update("[1,2]").digest("hex"));
    assert.equal(workflowV2ForEachView({ a: 1 }).count, null);
});
