import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { describeWorkflowV2States, workflowV2BindingView, workflowV2ForEachView } from "../../dist/workflow/v2/runtime.js";

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

// Adversarial review R3-SF-1: a binding's default that is a list or an object is shown as its count and digest, with the
// binding's path as written; a scalar default and a binding without one are shown as written. The same projection for
// every field the graph and workflow.started show that may be a binding.
test("R3-SF-1: a forEach binding's list default is shown as its count and digest, never its values", () => {
    const forEach = `\${input.items ?? [{"note":"${SENTINEL}"},{"note":"b"}]}`;
    const compiled = compileWorkflowV2(doc(forEach), { enableParallel: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const fan = describeWorkflowV2States(compiled.ir).find(state => state.id === "fan");
    assert.ok(!JSON.stringify(fan).includes(SENTINEL));
    const digest = createHash("sha256").update(JSON.stringify([{ note: SENTINEL }, { note: "b" }])).digest("hex");
    assert.equal(fan.forEach, `\${input.items ?? {"count":2,"sha256":"${digest}"}}`);
    // The compiled IR (the definition, for whoever may change it) keeps the default as written.
    assert.equal(compiled.ir.nodes.fan.forEach, forEach);
});

test("R3-SF-1: workflowV2BindingView projects list and object defaults only, keeping each path as written", () => {
    const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    assert.equal(workflowV2BindingView('${kv["the list"] ?? {"a":1,"b":2}}'), `\${kv["the list"] ?? {"count":2,"sha256":"${digest({ a: 1, b: 2 })}"}}`);
    assert.equal(workflowV2BindingView("${ input.items ?? [] }"), `\${input.items ?? {"count":0,"sha256":"${digest([])}"}}`);
    // A default string holding ?? or ${ is data, not a second operator.
    assert.equal(workflowV2BindingView('${input.x ?? ["a ?? b"]}'), `\${input.x ?? {"count":1,"sha256":"${digest(["a ?? b"])}"}}`);
    for (const same of ["${input.seconds ?? 30}", '${input.reviewer ?? "session-1"}', "${input.items}", "plain text", "${input.ok ?? null}"]) {
        assert.equal(workflowV2BindingView(same), same);
    }
    for (const same of [30, null, undefined]) assert.equal(workflowV2BindingView(same), same);
});

