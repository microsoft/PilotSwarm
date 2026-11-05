import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKER_ENV_DEFAULTS, workerTelemetryOmittedKeys } from "../lib/worker-env.mjs";
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("worker and starter images ship bootstrap and runtime dependencies", () => {
    for (const name of ["worker", "starter"]) {
        const dockerfile = read(`deploy/Dockerfile.${name}`);
        assert.match(dockerfile, /COPY scripts\/otel\/ \.\/scripts\/otel\//);
        assert.match(dockerfile, /COPY package\.json package-lock\.json/);
        assert.match(dockerfile, /npm ci --force/);
    }
    const worker = read("deploy/Dockerfile.worker");
    assert.match(worker, /npm prune --omit=dev/);
    assert.match(worker, /COPY --from=build \/app\/node_modules\/ \.\/node_modules\//);
    const pkg = JSON.parse(read("package.json"));
    for (const dependency of [
        "@opentelemetry/api", "@opentelemetry/sdk-node", "@opentelemetry/resources",
        "@opentelemetry/exporter-metrics-otlp-http", "@opentelemetry/exporter-trace-otlp-http",
    ]) assert.ok(pkg.dependencies[dependency], `${dependency} must survive pruning`);
});

test("every production worker launch preloads bootstrap; portal launch does not", () => {
    assert.match(read("deploy/Dockerfile.worker"), /ENTRYPOINT \["node", "--import", "\.\/scripts\/otel\/register\.mjs", "packages\/sdk\/examples\/worker\.js"\]/);
    assert.match(read("deploy/bin/start-worker.sh"), /exec node --import \.\/scripts\/otel\/register\.mjs packages\/sdk\/examples\/worker\.js/);
    assert.match(JSON.parse(read("package.json")).scripts.worker, /--import \.\/scripts\/otel\/register\.mjs/);
    assert.ok(read("packages/sdk/examples/worker.js").indexOf('import { shutdownTelemetry }') <
        read("packages/sdk/examples/worker.js").indexOf('from "pilotswarm-sdk"'));
    assert.doesNotMatch(read("deploy/bin/start-portal.sh"), /otel\/register|NODE_OPTIONS.*--import/);
});

test("shutdown drains before flush and flushes before exit", () => {
    const source = read("packages/sdk/examples/worker.js");
    const shutdown = source.slice(source.indexOf("async function drainAndExit"));
    assert.ok(shutdown.indexOf("await worker.gracefulShutdown()") < shutdown.indexOf("await shutdownTelemetry()"));
    assert.ok(shutdown.indexOf("await shutdownTelemetry()") < shutdown.indexOf("process.exit(0)"));
});

test("deployment defaults stay opt-in and credentials never enter the ConfigMap", () => {
    assert.equal(WORKER_ENV_DEFAULTS.OTEL_EXPORTER_OTLP_ENDPOINT, "");
    assert.equal(WORKER_ENV_DEFAULTS.OTEL_TRACES_EXPORTER, "none");
    assert.equal(WORKER_ENV_DEFAULTS.PILOTSWARM_OTEL_HISTOGRAMS, "false");
    assert.deepEqual(workerTelemetryOmittedKeys({}), ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_RESOURCE_ATTRIBUTES"]);
    assert.deepEqual(workerTelemetryOmittedKeys({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test" }), []);
    const env = read("deploy/providers/azure/gitops/worker/overlays/default/.env");
    assert.doesNotMatch(env, /^OTEL_EXPORTER_OTLP_HEADERS=/m);
    assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT=$/m);
    assert.match(read("deploy/providers/azure/gitops/worker/base/deployment.yaml"), /configMapRef:\s+name: worker-env/);
});
