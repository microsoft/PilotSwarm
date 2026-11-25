import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeMetrics, turnMetricResult } from "../../dist/runtime-metrics.js";

function fixture(env = {}, tracer) {
    const records = [];
    const instruments = [];
    let time = 10;
    const meter = {
        createCounter(name) { instruments.push(name); return { add: (value, attributes) => records.push({ name, value, attributes }) }; },
        createHistogram(name, options) { instruments.push(name); assert.equal(options.unit, "s"); return { record: (value, attributes) => records.push({ name, value, attributes }) }; },
    };
    return { records, instruments, metric: createRuntimeMetrics(meter, env, () => time, tracer), advance: ms => { time += ms; } };
}

function traceFixture() {
    const spans = [];
    const tracer = {
        startSpan(name, options = {}) {
            const span = {
                name, attributes: { ...(options.attributes ?? {}) }, status: undefined, ended: 0,
                setAttribute(key, value) { this.attributes[key] = value; },
                setStatus(status) { this.status = status; },
                end() { this.ended += 1; },
            };
            spans.push(span);
            return span;
        },
    };
    return { tracer, spans };
}
const usage = { tokensInput: 2, tokensOutput: 3, tokensCacheRead: 4, tokensCacheWrite: 5 };
const inference = {
    provider: "azure-foundry", model: "azure-foundry:decision-1", operationId: "nx-1",
    attempt: 1, purpose: "workflow-decision", workflowRunId: "run-1", nodeExecutionId: "nx-1",
};

test("closed turn outcomes distinguish completion, errors, cancellation, stopped and yields", () => {
    for (const [type, expected] of [
        ["completed", "completed"], ["error", "error"], ["cancelled", "cancelled"],
        ["stopped", "stopped"], ["wait", "yielded"], ["input_required", "yielded"],
        ["spawn_agent", "yielded"], ["set_workspace", "yielded"],
    ]) assert.equal(turnMetricResult({ type }), expected);
    assert.equal(turnMetricResult(null), "error");
    assert.equal(turnMetricResult(null, true), "cancelled");
});

test("each operation finishes once, tokens accumulate only at turn completion, histograms default off", () => {
    const { metric, records, instruments } = fixture();
    const finish = metric.startTurn();
    finish({ type: "error", message: "private error" }, usage);
    finish({ type: "completed" }, usage);
    metric.toolCall("success");
    metric.toolCall("error");
    const lifecycle = metric.startLifecycle("dehydration");
    lifecycle("lossy_handoff");
    lifecycle("completed");
    assert.equal(records.filter(r => r.name === "pilotswarm.turns").length, 1);
    assert.equal(records.filter(r => r.name === "pilotswarm.tokens").length, 4);
    assert.equal(records.filter(r => r.name === "pilotswarm.lifecycle.operations").length, 1);
    assert.ok(instruments.every(name => !name.endsWith(".duration")));
    assert.doesNotMatch(JSON.stringify(records), /private error|session|model|owner|toolName/);
});

test("histograms are explicit and measure monotonic elapsed seconds", () => {
    const { metric, records, advance } = fixture({ PILOTSWARM_OTEL_HISTOGRAMS: "true" });
    const finishTurn = metric.startTurn();
    const finishLife = metric.startLifecycle("hydration");
    advance(2_500);
    finishTurn({ type: "wait" }, usage);
    finishLife("error");
    assert.deepEqual(records.filter(r => r.name.endsWith(".duration")).map(r => r.value), [2.5, 2.5]);
});

test("the inference duration histogram is opt-in and records the provider call's seconds with closed labels", () => {
    const off = fixture();
    off.metric.startInferenceCall(inference)({ result: "success" });
    assert.equal(off.records.some(r => r.name === "pilotswarm.inference.duration"), false);

    const { metric, records, advance } = fixture({ PILOTSWARM_OTEL_HISTOGRAMS: "true" });
    const finish = metric.startInferenceCall(inference);
    advance(412);
    finish({ result: "error", errorCode: "timed_out" });
    finish({ result: "success" });
    assert.deepEqual(records.filter(r => r.name === "pilotswarm.inference.duration"), [
        { name: "pilotswarm.inference.duration", value: 0.412, attributes: { capability: "decision", result: "error" } },
    ]);
});

test("histogram booleans are case-insensitive and invalid values fall back to false", () => {
    for (const value of ["TRUE", "True", "false", "anything"]) {
        const { instruments } = fixture({ PILOTSWARM_OTEL_HISTOGRAMS: value });
        assert.equal(instruments.some(name => name.endsWith(".duration")), value.toLowerCase() === "true");
    }
});

test("inference calls use closed labels and reuse token directions", () => {
    const { metric, records } = fixture();
    const finish = metric.startInferenceCall({
        ...inference,
        endpoint: "https://private.example.invalid/provider",
        payload: "PRIVATE_PAYLOAD", requestId: "PRIVATE_REQUEST_ID", token: "PRIVATE_TOKEN",
    });
    finish({
        result: "success", usage: { inputTokens: 31, outputTokens: 4 }, httpStatusClass: "2xx",
        endpoint: "PRIVATE_ENDPOINT", requestBody: "PRIVATE_BODY", headers: { authorization: "PRIVATE_HEADER" },
    });
    finish({ result: "error", errorCode: "unavailable" });

    assert.deepEqual(records.filter(record => record.name === "pilotswarm.inference.calls"), [
        { name: "pilotswarm.inference.calls", value: 1, attributes: { capability: "decision", result: "success" } },
    ]);
    assert.deepEqual(records.filter(record => record.name === "pilotswarm.tokens").map(record => record.attributes), [
        { direction: "input" }, { direction: "output" },
    ]);
    assert.deepEqual(records.filter(record => record.name === "pilotswarm.tokens").map(record => record.value), [31, 4]);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|private\.example|azure-foundry|decision-1|run-1|nx-1/);
});

test("inference spans carry only the approved redacted context and closed outcomes", () => {
    const { tracer, spans } = traceFixture();
    const { metric, advance } = fixture({ OTEL_TRACES_EXPORTER: "otlp" }, tracer);
    const finish = metric.startInferenceCall({
        ...inference,
        endpoint: "PRIVATE_ENDPOINT", payload: "PRIVATE_PAYLOAD", requestId: "PRIVATE_REQUEST_ID", token: "PRIVATE_TOKEN",
    });
    advance(2_500);
    finish({
        result: "error", errorCode: "unavailable", usage: { inputTokens: 17, outputTokens: 2 }, httpStatusClass: "5xx",
        rawError: "PRIVATE_RAW_ERROR", requestBody: "PRIVATE_BODY", headers: { authorization: "PRIVATE_HEADER" },
    });

    assert.equal(spans.length, 1);
    const [span] = spans;
    assert.equal(span.name, "pilotswarm.inference.call");
    assert.deepEqual(span.attributes, {
        "pilotswarm.inference.capability": "decision",
        "pilotswarm.inference.provider": "azure-foundry",
        "pilotswarm.inference.model": "azure-foundry:decision-1",
        "pilotswarm.inference.operation_id": "nx-1",
        "pilotswarm.inference.attempt": 1,
        "pilotswarm.inference.purpose": "workflow-decision",
        "pilotswarm.workflow_run_id": "run-1",
        "pilotswarm.node_execution_id": "nx-1",
        "pilotswarm.inference.result": "error",
        "error.type": "unavailable",
        "http.response.status_class": "5xx",
        "pilotswarm.inference.latency_ms": 2_500,
        "pilotswarm.inference.tokens_input": 17,
        "pilotswarm.inference.tokens_output": 2,
    });
    assert.equal(span.status.code, 2);
    assert.equal(span.ended, 1);
    assert.doesNotMatch(JSON.stringify(span), /PRIVATE_|endpoint|payload|requestId|requestBody|headers|authorization/i);
});

test("invalid inference observation values collapse to closed metric and span labels", () => {
    const { tracer, spans } = traceFixture();
    const { metric, records } = fixture({ OTEL_TRACES_EXPORTER: "otlp" }, tracer);
    metric.startInferenceCall(inference)({
        result: "caller-provided-result", errorCode: "caller-provided-error",
        httpStatusClass: "429", usage: { inputTokens: NaN, outputTokens: -1 },
    });
    assert.deepEqual(records.filter(record => record.name === "pilotswarm.inference.calls")[0].attributes,
        { capability: "decision", result: "error" });
    assert.deepEqual(records.filter(record => record.name === "pilotswarm.tokens"), []);
    assert.equal(spans[0].attributes["pilotswarm.inference.result"], "error");
    assert.equal(Object.hasOwn(spans[0].attributes, "error.type"), false);
    assert.equal(Object.hasOwn(spans[0].attributes, "http.response.status_class"), false);
});

test("review S8 (#376): Copilot runtime losses count on one counter with a closed outcome label", () => {
    const { metric, records } = fixture();
    metric.copilotRuntime("after_startup");
    metric.copilotRuntime("during_startup");
    metric.copilotRuntime("unclaimed");
    metric.copilotRuntime("pid 4242");
    assert.deepEqual(records, [
        { name: "pilotswarm.copilot_runtime.exits", value: 1, attributes: { outcome: "after_startup" } },
        { name: "pilotswarm.copilot_runtime.exits", value: 1, attributes: { outcome: "during_startup" } },
        { name: "pilotswarm.copilot_runtime.exits", value: 1, attributes: { outcome: "unclaimed" } },
    ]);
    const disabled = fixture({ OTEL_METRICS_EXPORTER: "none" });
    disabled.metric.copilotRuntime("after_startup");
    assert.deepEqual(disabled.records, []);
});

test("disabled SDK or metrics exporter records nothing even with a real injected meter", () => {
    for (const env of [{ OTEL_SDK_DISABLED: "true", OTEL_TRACES_EXPORTER: "otlp" }, { OTEL_METRICS_EXPORTER: "none" }]) {
        const { tracer, spans } = traceFixture();
        const { metric, records } = fixture(env, tracer);
        metric.startTurn()({ type: "completed" }, usage);
        metric.toolCall("success");
        metric.startLifecycle("hydration")("completed");
        metric.startInferenceCall(inference)({ result: "success", usage: { inputTokens: 2, outputTokens: 1 } });
        assert.deepEqual(records, []);
        assert.deepEqual(spans, []);
    }
});

test("a failing meter or tracer never throws into runtime code", () => {
    const meter = {
        createCounter() { return { add() { throw new Error("test counter failure"); } }; },
        createHistogram() { return { record() { throw new Error("test histogram failure"); } }; },
    };
    const tracer = {
        startSpan() { return {
            setAttribute() { throw new Error("test attribute failure"); },
            setStatus() { throw new Error("test status failure"); },
            end() { throw new Error("test end failure"); },
        }; },
    };
    const metric = createRuntimeMetrics(meter, {
        PILOTSWARM_OTEL_HISTOGRAMS: "true", OTEL_TRACES_EXPORTER: "otlp",
    }, () => { throw new Error("test clock failure"); }, tracer);
    assert.doesNotThrow(() => metric.startTurn()({ type: "completed" }, usage));
    assert.doesNotThrow(() => metric.toolCall("success"));
    assert.doesNotThrow(() => metric.startLifecycle("hydration")("completed"));
    assert.doesNotThrow(() => metric.startInferenceCall(inference)({
        result: "error", errorCode: "execution_failed", usage: { inputTokens: 1, outputTokens: 1 },
    }));
    assert.doesNotThrow(() => createRuntimeMetrics({
        createCounter() { throw new Error("test instrument creation failure"); },
        createHistogram() { throw new Error("test histogram creation failure"); },
    }));
});
