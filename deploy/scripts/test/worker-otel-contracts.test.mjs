import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKER_ENV_DEFAULTS, workerTelemetryOmittedKeys } from "../lib/worker-env.mjs";
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("worker and starter images ship the SDK telemetry bootstrap and dependencies", () => {
    for (const name of ["worker", "starter"]) {
        const dockerfile = read(`deploy/Dockerfile.${name}`);
        assert.match(dockerfile, /COPY package\.json package-lock\.json/);
        assert.match(dockerfile, /npm ci --force/);
    }
    const worker = read("deploy/Dockerfile.worker");
    assert.match(worker, /npm prune --omit=dev/);
    assert.match(worker, /COPY --from=build \/app\/node_modules\/ \.\/node_modules\//);
    const pkg = JSON.parse(read("packages/sdk/package.json"));
    for (const dependency of [
        "@opentelemetry/api", "@opentelemetry/sdk-metrics", "@opentelemetry/sdk-trace-base", "@opentelemetry/resources",
        "@opentelemetry/exporter-metrics-otlp-http", "@opentelemetry/exporter-trace-otlp-http",
    ]) assert.ok(pkg.dependencies[dependency], `${dependency} must survive pruning`);
    assert.equal(pkg.dependencies["@opentelemetry/sdk-node"], undefined);
});

test("every production worker launch preloads bootstrap; portal launch does not", () => {
    assert.match(read("deploy/Dockerfile.worker"), /ENTRYPOINT \["node", "--import", "pilotswarm-sdk\/telemetry", "packages\/sdk\/examples\/worker\.js"\]/);
    assert.match(read("deploy/bin/start-worker.sh"), /exec node --import pilotswarm-sdk\/telemetry packages\/sdk\/examples\/worker\.js/);
    assert.match(JSON.parse(read("package.json")).scripts.worker, /--import pilotswarm-sdk\/telemetry/);
    assert.ok(read("packages/sdk/examples/worker.js").indexOf('import { shutdownTelemetry }') <
        read("packages/sdk/examples/worker.js").indexOf('from "pilotswarm-sdk"'));
    assert.doesNotMatch(read("deploy/bin/start-portal.sh"), /telemetry|NODE_OPTIONS.*--import/);
});

test("shutdown drains before the best-effort telemetry flush and exits successfully", () => {
    const source = read("packages/sdk/examples/worker.js");
    const shutdown = source.slice(source.indexOf("async function drainAndExit"));
    assert.ok(shutdown.indexOf("await worker.gracefulShutdown()") < shutdown.indexOf("await shutdownTelemetry()"));
    assert.ok(shutdown.indexOf("await shutdownTelemetry()") < shutdown.indexOf("process.exit(0)"));
    assert.doesNotMatch(shutdown, /process\.exit\(1\)/);
});

test("deployment defaults stay opt-in and credentials never enter the ConfigMap", () => {
    assert.equal(WORKER_ENV_DEFAULTS.OTEL_EXPORTER_OTLP_ENDPOINT, "");
    assert.equal(WORKER_ENV_DEFAULTS.OTEL_TRACES_EXPORTER, "none");
    assert.equal(WORKER_ENV_DEFAULTS.PILOTSWARM_OTEL_HISTOGRAMS, "false");
    assert.deepEqual(workerTelemetryOmittedKeys({}), [
        "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SDK_DISABLED", "OTEL_METRICS_EXPORTER",
        "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_SERVICE_NAME",
        "OTEL_RESOURCE_ATTRIBUTES", "OTEL_METRIC_EXPORT_INTERVAL", "OTEL_METRIC_EXPORT_TIMEOUT",
        "OTEL_EXPORTER_OTLP_TIMEOUT", "PILOTSWARM_OTEL_HISTOGRAMS",
    ]);
    assert.deepEqual(workerTelemetryOmittedKeys({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test" }), []);
    const env = read("deploy/providers/azure/gitops/worker/overlays/default/.env");
    assert.doesNotMatch(env, /^OTEL_EXPORTER_OTLP_HEADERS=/m);
    assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT=$/m);
    assert.match(read("deploy/providers/azure/gitops/worker/base/deployment.yaml"), /configMapRef:\s+name: worker-env/);
});
