import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeMetrics, turnMetricResult } from "../../dist/runtime-metrics.js";

function fixture(env = {}) {
    const records = [];
    const instruments = [];
    let time = 10;
    const meter = {
        createCounter(name) { instruments.push(name); return { add: (value, attributes) => records.push({ name, value, attributes }) }; },
        createHistogram(name, options) { instruments.push(name); assert.equal(options.unit, "s"); return { record: (value, attributes) => records.push({ name, value, attributes }) }; },
    };
    return { records, instruments, metric: createRuntimeMetrics(meter, env, () => time), advance: ms => { time += ms; } };
}
const usage = { tokensInput: 2, tokensOutput: 3, tokensCacheRead: 4, tokensCacheWrite: 5 };

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

test("histogram booleans are case-insensitive and invalid values fall back to false", () => {
    for (const value of ["TRUE", "True", "false", "anything"]) {
        const { instruments } = fixture({ PILOTSWARM_OTEL_HISTOGRAMS: value });
        assert.equal(instruments.some(name => name.endsWith(".duration")), value.toLowerCase() === "true");
    }
});

test("disabled SDK or metrics exporter records nothing even with a real injected meter", () => {
    for (const env of [{ OTEL_SDK_DISABLED: "true" }, { OTEL_METRICS_EXPORTER: "none" }]) {
        const { metric, records } = fixture(env);
        metric.startTurn()({ type: "completed" }, usage);
        metric.toolCall("success");
        metric.startLifecycle("hydration")("completed");
        assert.deepEqual(records, []);
    }
});

test("a failing meter never throws into runtime code", () => {
    const meter = {
        createCounter() { return { add() { throw new Error("test counter failure"); } }; },
        createHistogram() { return { record() { throw new Error("test histogram failure"); } }; },
    };
    const metric = createRuntimeMetrics(meter, { PILOTSWARM_OTEL_HISTOGRAMS: "true" }, () => { throw new Error("test clock failure"); });
    assert.doesNotThrow(() => metric.startTurn()({ type: "completed" }, usage));
    assert.doesNotThrow(() => metric.toolCall("success"));
    assert.doesNotThrow(() => metric.startLifecycle("hydration")("completed"));
});
