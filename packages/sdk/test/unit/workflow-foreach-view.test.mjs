import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { describeWorkflowStates, workflowBindingView, workflowForEachView } from "../../dist/workflow/runtime.js";

// Adversarial review SF-3: a parallel state's literal forEach list is never shown to a reader of the graph or of the
// workflow.started event; a binding is shown as its text.

const SENTINEL = "customer-4711-private";
const doc = forEach => JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "fan", version: "1.0.0" },
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
    const compiled = compileWorkflow(doc(list), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const states = describeWorkflowStates(compiled.ir);
    assert.ok(!JSON.stringify(states).includes(SENTINEL));
    const fan = states.find(state => state.id === "fan");
    assert.equal(fan.forEach.count, 3);
    assert.match(fan.forEach.sha256, /^[0-9a-f]{64}$/);
});

test("a binding is shown as its text", () => {
    const compiled = compileWorkflow(doc("${input.items}"), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(describeWorkflowStates(compiled.ir).find(state => state.id === "fan").forEach, "${input.items}");
});

test("workflowForEachView", () => {
    assert.equal(workflowForEachView("${input.items}"), "${input.items}");
    const view = workflowForEachView([1, 2]);
    assert.deepEqual(Object.keys(view).sort(), ["count", "sha256"]);
    assert.equal(view.count, 2);
    assert.equal(view.sha256, createHash("sha256").update("[1,2]").digest("hex"));
    assert.equal(workflowForEachView({ a: 1 }).count, null);
});

// Adversarial review R3-SF-1: a binding's default that is a list or an object is shown as its count and digest, with the
// binding's path as written; a scalar default and a binding without one are shown as written. The same projection for
// every field the graph and workflow.started show that may be a binding.
test("R3-SF-1: a forEach binding's list default is shown as its count and digest, never its values", () => {
    const forEach = `\${input.items ?? [{"note":"${SENTINEL}"},{"note":"b"}]}`;
    const compiled = compileWorkflow(doc(forEach), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const fan = describeWorkflowStates(compiled.ir).find(state => state.id === "fan");
    assert.ok(!JSON.stringify(fan).includes(SENTINEL));
    const digest = createHash("sha256").update(JSON.stringify([{ note: SENTINEL }, { note: "b" }])).digest("hex");
    assert.equal(fan.forEach, `\${input.items ?? {"count":2,"sha256":"${digest}"}}`);
    // The compiled IR (the definition, for whoever may change it) keeps the default as written.
    assert.equal(compiled.ir.nodes.fan.forEach, forEach);
});

test("R3-SF-1: workflowBindingView projects list and object defaults only, keeping each path as written", () => {
    const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    assert.equal(workflowBindingView('${kv["the list"] ?? {"a":1,"b":2}}'), `\${kv["the list"] ?? {"count":2,"sha256":"${digest({ a: 1, b: 2 })}"}}`);
    assert.equal(workflowBindingView("${ input.items ?? [] }"), `\${input.items ?? {"count":0,"sha256":"${digest([])}"}}`);
    // A default string holding ?? or ${ is data, not a second operator.
    assert.equal(workflowBindingView('${input.x ?? ["a ?? b"]}'), `\${input.x ?? {"count":1,"sha256":"${digest(["a ?? b"])}"}}`);
    for (const same of ["${input.seconds ?? 30}", '${input.reviewer ?? "session-1"}', "${input.items}", "plain text", "${input.ok ?? null}"]) {
        assert.equal(workflowBindingView(same), same);
    }
    for (const same of [30, null, undefined]) assert.equal(workflowBindingView(same), same);
});

