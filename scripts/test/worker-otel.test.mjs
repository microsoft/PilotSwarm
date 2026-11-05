import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { telemetryConfig } from "../otel/config.mjs";

const execute = promisify(execFile);
const register = new URL("../otel/register.mjs", import.meta.url).href;
const helper = new URL("../../packages/sdk/dist/runtime-metrics.js", import.meta.url).href;
const endpoint = "http://127.0.0.1:4318";
const offScript = `
import { telemetryEnabled, shutdownTelemetry } from ${JSON.stringify(register)};
import { metrics, trace } from "@opentelemetry/api";
console.log(JSON.stringify({ enabled: telemetryEnabled, spanRecording: trace.getTracer("test").startSpan("test").isRecording() }));
metrics.getMeter("test").createCounter("test.counter").add(1);
await shutdownTelemetry();
`;
const run = (env, code = offScript) => execute(process.execPath, [
    "--import", register, "--input-type=module", "-e", code,
], { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 });

test("no endpoint and SDK disabled leave providers unregistered, including invalid ignored settings", async () => {
    for (const env of [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_SDK_DISABLED: "true", OTEL_METRICS_EXPORTER: "invalid" }]) {
        const { stdout, stderr } = await run(env);
        assert.match(stdout, /"enabled":false/);
        assert.match(stdout, /"spanRecording":false/);
        assert.equal(stderr, "");
    }
});

test("headers are optional; default signals are metrics only", () => {
    const config = telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    assert.deepEqual(config.headers, {});
    assert.equal(config.metrics, "otlp");
    assert.equal(config.traces, "none");
    assert.equal(config.interval, 30_000);
    assert.deepEqual(telemetryConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20example",
    }).headers, { authorization: "Bearer example" });
});

test("signal opt-outs leave telemetry off; trace-only is explicit", async () => {
    const { stdout } = await run({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none" });
    assert.match(stdout, /"enabled":false/);
    const config = telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "otlp" });
    assert.equal(config.traces, "otlp");
});

test("invalid configured values fail without echoing endpoint credentials or headers", async () => {
    for (const invalid of [
        { OTEL_METRICS_EXPORTER: "prometheus" }, { OTEL_TRACES_EXPORTER: "console" },
        { OTEL_LOGS_EXPORTER: "otlp" }, { OTEL_METRIC_EXPORT_INTERVAL: "30junk" },
        { OTEL_METRIC_EXPORT_INTERVAL: "0" }, { OTEL_EXPORTER_OTLP_TIMEOUT: "-1" },
        { OTEL_METRIC_EXPORT_TIMEOUT: "30001" }, { PILOTSWARM_OTEL_HISTOGRAMS: "maybe" },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:PRIVATE_VALUE@127.0.0.1/" },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1/?credential=PRIVATE_VALUE" },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "file:///PRIVATE_VALUE" },
        { OTEL_EXPORTER_OTLP_HEADERS: "PRIVATE_VALUE" },
    ]) {
        await assert.rejects(run({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, ...invalid }), error => {
            assert.match(error.stderr, /\[otel\] Invalid/);
            assert.doesNotMatch(error.stderr, /PRIVATE_VALUE|user:|credential=/);
            return true;
        });
    }
});

async function collector(t) {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => {
            requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
        });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test("shutdown flushes real OTLP metrics without traces, logs, broad instrumentation or private labels", async t => {
    const { requests, url } = await collector(t);
    await run({
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
        OTEL_METRIC_EXPORT_INTERVAL: "1000000",
        OTEL_SERVICE_NAME: "test-worker",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test,service.instance.id=configured-instance",
        POD_NAME: "test-pod",
    }, `
        import { shutdownTelemetry } from ${JSON.stringify(register)};
        import { createRuntimeMetrics } from ${JSON.stringify(helper)};
        import { trace } from "@opentelemetry/api";
        const metric = createRuntimeMetrics();
        metric.startTurn()({ type: "completed", content: "PRIVATE_PAYLOAD", sessionId: "PRIVATE_ID" },
            { tokensInput: 11, tokensOutput: 7, tokensCacheRead: 3, tokensCacheWrite: 2 });
        metric.toolCall("success");
        metric.startLifecycle("hydration")("completed");
        const span = trace.getTracer("test").startSpan("private-span", { attributes: { secret: "PRIVATE_PAYLOAD" } });
        if (span.isRecording()) throw new Error("Trace provider must be disabled");
        span.end();
        await Promise.all([shutdownTelemetry(), shutdownTelemetry()]);
    `);
    assert.ok(requests.length > 0, "shutdown must export before the long interval fires");
    assert.ok(requests.every(request => request.path === "/v1/metrics"));
    const text = JSON.stringify(requests);
    assert.doesNotMatch(text, /PRIVATE_PAYLOAD|PRIVATE_ID|session_id|owner|tool_name|pilotswarm\.turn\.duration|process\.pid|host\.name/);
    const resourceMetrics = requests.flatMap(request => request.body.resourceMetrics);
    const resource = Object.fromEntries(resourceMetrics[0].resource.attributes.map(({ key, value }) => [key, value.stringValue]));
    assert.equal(resource["service.name"], "test-worker");
    assert.equal(resource["service.instance.id"], "configured-instance");
    const exported = resourceMetrics.flatMap(r => r.scopeMetrics.flatMap(s => s.metrics));
    assert.deepEqual([...new Set(exported.map(m => m.name))].sort(), [
        "pilotswarm.lifecycle.operations", "pilotswarm.tokens", "pilotswarm.tool.calls", "pilotswarm.turns",
    ]);
    const tokenMetric = exported.find(m => m.name === "pilotswarm.tokens");
    const counts = Object.fromEntries(tokenMetric.sum.dataPoints.map(p => [
        p.attributes.find(a => a.key === "direction").value.stringValue, Number(p.asDouble ?? p.asInt),
    ]));
    assert.deepEqual(counts, { input: 11, output: 7, cache_read: 3, cache_write: 2 });
});

test("explicit trace opt-in exports existing manual spans without library instrumentation", async t => {
    const { requests, url } = await collector(t);
    await run({
        OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "otlp",
    }, `
        import { shutdownTelemetry } from ${JSON.stringify(register)};
        import { trace } from "@opentelemetry/api";
        trace.getTracer("test").startSpan("explicit-test").end();
        await shutdownTelemetry();
    `);
    assert.ok(requests.some(request => request.path === "/v1/traces"));
    assert.ok(requests.every(request => request.path === "/v1/traces"));
});
