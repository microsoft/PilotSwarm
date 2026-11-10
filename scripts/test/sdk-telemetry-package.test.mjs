import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function withCollector(t) {
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
    return { requests, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test("packed SDK telemetry preload exports actual worker turn usage without repository scripts", { timeout: 120_000 }, async t => {
    const store = process.env.PILOTSWARM_SMOKE_DATABASE_URL;
    if (!store) {
        t.skip("set PILOTSWARM_SMOKE_DATABASE_URL to an isolated temporary PostgreSQL database");
        return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "pilotswarm-sdk-telemetry-package-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { requests, endpoint } = await withCollector(t);
    const packageDir = new URL("../../packages/sdk/", import.meta.url);
    const { stdout } = await execute("npm", ["pack", "--ignore-scripts", "--json"], {
        cwd: packageDir, maxBuffer: 1_000_000,
    });
    const [{ filename }] = JSON.parse(stdout);
    const archive = path.join(packageDir.pathname, filename);
    t.after(() => rm(archive, { force: true }));
    await execute("npm", ["init", "--yes"], { cwd: dir });
    await execute("npm", ["install", "--ignore-scripts", archive], { cwd: dir, maxBuffer: 1_000_000 });

    const program = `
        import assert from "node:assert/strict";
        import http from "node:http";
        import { mkdtemp, rm, writeFile } from "node:fs/promises";
        import os from "node:os";
        import path from "node:path";
        import {
            PilotSwarmClient,
            PilotSwarmManagementClient,
            PilotSwarmWorker,
        } from "pilotswarm-sdk";
        import { shutdownTelemetry } from "pilotswarm-sdk/telemetry";

        const temp = await mkdtemp(path.join(os.tmpdir(), "pilotswarm-sdk-consumer-"));
        const store = process.env.PILOTSWARM_SMOKE_DATABASE_URL;
        assert.ok(store, "the smoke database URL is required");
        const model = await new Promise(resolve => {
            const server = http.createServer((request, response) => {
                const chunks = [];
                request.on("data", chunk => chunks.push(chunk));
                request.on("end", () => {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    const usage = {
                        prompt_tokens: 11,
                        completion_tokens: 7,
                        prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 },
                    };
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    response.write("data: " + JSON.stringify({
                        id: "scripted-turn", object: "chat.completion.chunk", model: body.model,
                        choices: [{ index: 0, delta: { role: "assistant", content: "scripted response" }, finish_reason: null }],
                    }) + "\\n\\n");
                    response.write("data: " + JSON.stringify({
                        id: "scripted-turn", object: "chat.completion.chunk", model: body.model,
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage,
                    }) + "\\n\\n");
                    response.end("data: [DONE]\\n\\n");
                });
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
        });
        const modelUrl = "http://127.0.0.1:" + model.address().port + "/v1";
        const modelProvidersPath = path.join(temp, "model-providers.json");
        await writeFile(modelProvidersPath, JSON.stringify({
            providers: [{ id: "scripted", type: "openai", baseUrl: modelUrl, models: [{ name: "scripted" }] }],
        }));
        const admin = { principal: { provider: "test", subject: "consumer-admin" }, isAdmin: true };
        let management;
        let worker;
        let client;
        try {
            management = new PilotSwarmManagementClient({ store, modelProvidersPath, disableManagementAgents: true });
            await management.start();
            await management.createProvider(admin, {
                name: "scripted", type: "scripted", credentials: { apiKey: "not-a-secret" },
            });
            await management.setClusterDefault(admin, {
                provider: "scripted", model: "scripted:scripted", reasoning: null, context: null,
            });
            await management.stop();
            management = undefined;

            worker = new PilotSwarmWorker({
                store, modelProvidersPath, disableManagementAgents: true,
                sessionStateDir: path.join(temp, "sessions"), workerNodeId: "consumer-worker",
            });
            await worker.start();
            client = new PilotSwarmClient({ store, modelProvidersPath });
            await client.start();
            const session = await client.createSession();
            assert.equal(await session.sendAndWait("emit a deterministic turn", 60_000), "scripted response");
            await client.stop();
            client = undefined;
            await worker.gracefulShutdown();
            worker = undefined;
            await shutdownTelemetry();
            console.log(JSON.stringify({
                telemetryPath: import.meta.resolve("pilotswarm-sdk/telemetry"),
                sdkPath: import.meta.resolve("pilotswarm-sdk"),
            }));
        } finally {
            await client?.stop();
            await worker?.stop();
            await management?.stop();
            await new Promise(resolve => model.close(resolve));
            await rm(temp, { recursive: true, force: true });
        }
    `;
    await writeFile(path.join(dir, "consumer.mjs"), program);
    const child = await execute(process.execPath, ["--import", "pilotswarm-sdk/telemetry", "consumer.mjs"], {
        cwd: dir,
        env: {
            PATH: process.env.PATH,
            PILOTSWARM_SMOKE_DATABASE_URL: store,
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
            OTEL_METRIC_EXPORT_INTERVAL: "1000000",
            OTEL_EXPORTER_OTLP_TIMEOUT: "1000",
            OTEL_METRIC_EXPORT_TIMEOUT: "1000",
            OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=packed-consumer",
        },
        timeout: 90_000,
        maxBuffer: 1_000_000,
    });
    const location = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.match(location.telemetryPath, /consumer[/\\]node_modules[/\\]pilotswarm-sdk[/\\]dist[/\\]telemetry\.js$/);
    assert.match(location.sdkPath, /consumer[/\\]node_modules[/\\]pilotswarm-sdk[/\\]dist[/\\]index\.js$/);
    assert.ok(requests.length > 0, "the packed consumer must flush to the local receiver");
    assert.ok(requests.every(request => request.path === "/v1/metrics"));
    const metrics = requests.flatMap(request => request.body.resourceMetrics)
        .flatMap(resource => resource.scopeMetrics)
        .flatMap(scope => scope.metrics);
    assert.ok(!metrics.some(metric => metric.name.includes("duration")), "histograms are disabled by default");
    const tokens = metrics.find(metric => metric.name === "pilotswarm.tokens");
    assert.ok(tokens, "the real worker turn must export SDK token counters");
    const values = Object.fromEntries(tokens.sum.dataPoints.map(point => [
        point.attributes.find(attribute => attribute.key === "direction").value.stringValue,
        Number(point.asDouble ?? point.asInt),
    ]));
    assert.deepEqual(values, { input: 11, output: 7, cache_read: 3, cache_write: 2 });
    assert.equal(tokens.sum.aggregationTemporality, 2, "the default Sum temporality is cumulative");
    const resource = Object.fromEntries(requests[0].body.resourceMetrics[0].resource.attributes
        .map(({ key, value }) => [key, value.stringValue]));
    assert.equal(resource["service.instance.id"], "packed-consumer");
    const allNames = metrics.map(metric => metric.name);
    assert.ok(!allNames.some(name => name.includes("trace") || name.includes("log")), "default mode exports metrics only");
});
