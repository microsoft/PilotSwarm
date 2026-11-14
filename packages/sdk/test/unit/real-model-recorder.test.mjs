import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNativeModelRequests, withRealModelRecorder } from "../helpers/real-model-recorder.mjs";

test("the live recorder forwards bytes, headers, route and streaming response; records only model/tool metadata", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "model-recorder-unit-"));
    let observed;
    const upstream = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        observed = { route: request.url, auth: request.headers.authorization, payload: Buffer.concat(chunks).toString() };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        response.end("data: second\n\n");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const provider = { id: "test-real", type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "env:MODEL_RECORDER_TEST_KEY", wireApi: "responses", models: [{ name: "real-model" }] };
    const body = JSON.stringify({ model: "real-model", input: "synthetic-private-prompt",
        tools: [{ type: "function", name: "pkg_tool_a" }, { type: "function", function: { name: "complete_workflow_node" } }] });
    try {
        await withRealModelRecorder({ baseDir }, { allProviders: [provider] }, { model: { provider: provider.id, ref: "test-real:real-model" } },
            async recorder => {
                const config = JSON.parse(readFileSync(recorder.modelProvidersPath, "utf8"));
                assert.equal(config.providers[0].wireApi, provider.wireApi);
                assert.equal(config.providers[0].apiKey, provider.apiKey);
                const response = await fetch(`${config.providers[0].baseUrl}/responses?api-version=test`, {
                    method: "POST", headers: { authorization: "Bearer synthetic-private-key" }, body,
                });
                assert.equal(response.status, 200);
                assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
                assert.deepEqual(observed, { route: "/v1/responses?api-version=test", auth: "Bearer synthetic-private-key", payload: body });
                assert.deepEqual(recorder.requests, [{ source: "http-request", model: "real-model",
                    tools: ["complete_workflow_node", "pkg_tool_a"], status: 200 }]);
                assert.deepEqual(recorder.errors, []);
                assert.ok(!JSON.stringify(recorder.requests).includes("private"));
            });
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeAllConnections();
        await closed;
        rmSync(baseDir, { recursive: true });
    }
});

test("native creation and resume read session-fixed tools at each usage event, await reads, then restore and unsubscribe", async () => {
    let reads = 0;
    const fixture = tools => {
        const handlers = new Set();
        return {
            sessionId: "synthetic-native-session", handlers,
            on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
            rpc: { tools: { async getCurrentMetadata() {
                reads++;
                return { tools: tools.map(name => ({ name })) };
            } } },
        };
    };
    const session = fixture(["complete_workflow_node", "pkg_tool_a"]);
    const resumed = fixture(["complete_workflow_node"]);
    const manager = {
        async _createCopilotSession() { return session; },
        async _resumeCopilotSession() { return resumed; },
    };
    const create = manager._createCopilotSession;
    const resume = manager._resumeCopilotSession;
    await withRealModelRecorder({}, { allProviders: [{ id: "native", type: "github" }] },
        { model: { provider: "native" } }, async recorder => {
            assert.equal(recorder.source, "cli-metadata");
            recorder.observe(manager);
            assert.equal(await manager._createCopilotSession(), session);
            assert.equal(reads, 0, "no session-level catalog substituted for a request");
            for (const handler of session.handlers) handler({ type: "assistant.turn_start", data: {} });
            assert.equal(reads, 0, "a turn is not an inference-request receipt");
            for (const handler of session.handlers) handler({ id: "usage-1", type: "assistant.usage",
                data: { model: "native-model", apiCallId: "request-1" } });
            await recorder.flush();
            assert.equal(await manager._resumeCopilotSession(), resumed);
            assert.equal(await manager._resumeCopilotSession(), resumed);
            assert.equal(resumed.handlers.size, 1, "the same CopilotSession object does not duplicate observations");
            for (const handler of resumed.handlers) handler({ id: "usage-2", type: "assistant.usage",
                data: { model: "native-model", serviceRequestId: "request-2" } });
            await recorder.flush();
            assert.equal(reads, 2);
            assert.deepEqual(recorder.requests.map(request => ({ source: request.source, requestId: request.requestId,
                tools: request.tools })), [
                { source: "cli-metadata", requestId: "request-1", tools: ["complete_workflow_node", "pkg_tool_a"] },
                { source: "cli-metadata", requestId: "request-2", tools: ["complete_workflow_node"] },
            ]);
            assert.ok(recorder.requests.every(request =>
                request.metadataObservation === "session-fixed tools at assistant.usage"));
            assert.deepEqual(recorder.errors, []);
        });
    assert.equal(manager._createCopilotSession, create);
    assert.equal(manager._resumeCopilotSession, resume);
    assert.equal(session.handlers.size, 0);
    assert.equal(resumed.handlers.size, 0);
});

test("native metadata failures are explicit, not empty offered-tool witnesses", async () => {
    let handler;
    const session = { sessionId: "native-failure", on(fn) { handler = fn; return () => {}; },
        rpc: { tools: { async getCurrentMetadata() { throw new Error("synthetic failure"); } } } };
    const manager = { async _createCopilotSession() { return session; }, async _resumeCopilotSession() { return session; } };
    const requests = [], errors = [];
    const observer = observeNativeModelRequests(manager, requests, errors);
    try {
        await manager._createCopilotSession();
        handler({ id: "request-error", type: "assistant.usage", data: { model: "native-model" } });
        await observer.flush();
        assert.equal(requests[0].tools, null);
        assert.deepEqual(errors, ["CLI_TOOL_METADATA_UNAVAILABLE"]);
    } finally {
        observer.dispose();
    }
});

test("an existing Azure deployment path is preserved once and a 429 is recorded without a retry", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "model-recorder-azure-"));
    const routes = [];
    const upstream = createServer(async (request, response) => {
        for await (const chunk of request) { /* Drain the request before returning its real status. */ }
        routes.push(request.url);
        response.writeHead(429, { "content-type": "application/json" });
        response.end('{"error":{"code":"rate_limit"}}');
    });

    for (const stage of ["before headers", "during response"]) {
        test(`local cancellation ${stage} is recorded separately from upstream failures`, async () => {
            const baseDir = mkdtempSync(join(tmpdir(), "model-recorder-cancel-"));
            const received = Promise.withResolvers(), disconnected = Promise.withResolvers();
            let calls = 0;
            const upstream = createServer(async (request, response) => {
                for await (const chunk of request) { /* Drain the fixture request. */ }
                calls++;
                request.socket.once("close", () => disconnected.resolve());
                if (stage === "during response") {
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    response.write("data: fixture\n\n");
                }
                received.resolve();
            });
            upstream.listen(0, "127.0.0.1");
            await once(upstream, "listening");
            const provider = { id: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
                apiKey: "env:MODEL_RECORDER_TEST_KEY", models: [{ name: "real-model" }] };
            try {
                await withRealModelRecorder({ baseDir }, { allProviders: [provider] }, { model: { provider: provider.id, ref: "fixture:real-model" } },
                    async recorder => {
                        const config = JSON.parse(readFileSync(recorder.modelProvidersPath, "utf8"));
                        const request = httpRequest(`${config.providers[0].baseUrl}/responses`, { method: "POST" });
                        const clientErrors = [];
                        request.on("error", error => clientErrors.push(error.code));
                        const responseReady = stage === "during response" ? once(request, "response") : null;
                        request.end(JSON.stringify({ model: "real-model", tools: [] }));
                        await received.promise;
                        if (responseReady) {
                            const [response] = await responseReady;
                            response.on("error", error => clientErrors.push(error.code));
                            await once(response, "data");
                            response.destroy();
                        } else request.destroy();
                        await disconnected.promise;
                        await recorder.flush();
                        assert.equal(calls, 1, "cancellation never retries the request");
                        assert.deepEqual(recorder.errors, []);
                        assert.deepEqual(recorder.cancellations, [{ request: 1, reason: "downstream-closed" }]);
                        assert.ok(clientErrors.every(code => code === "ECONNRESET" || code === undefined));
                    });
            } finally {
                const closed = once(upstream, "close");
                upstream.close();
                upstream.closeAllConnections();
                await closed;
                rmSync(baseDir, { recursive: true });
            }
        });
    }

    test("a genuine upstream response reset remains an error, not a local cancellation", async () => {
        const baseDir = mkdtempSync(join(tmpdir(), "model-recorder-reset-"));
        let upstreamResponse, calls = 0;
        const upstream = createServer(async (request, response) => {
            for await (const chunk of request) { /* Drain the fixture request. */ }
            calls++;
            upstreamResponse = response;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: fixture\n\n");
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const provider = { id: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
            apiKey: "env:MODEL_RECORDER_TEST_KEY", models: [{ name: "real-model" }] };
        try {
            await withRealModelRecorder({ baseDir }, { allProviders: [provider] }, { model: { provider: provider.id, ref: "fixture:real-model" } },
                async recorder => {
                    const config = JSON.parse(readFileSync(recorder.modelProvidersPath, "utf8"));
                    const request = httpRequest(`${config.providers[0].baseUrl}/responses`, { method: "POST" });
                    const responseReady = once(request, "response");
                    request.end(JSON.stringify({ model: "real-model", tools: [] }));
                    const [response] = await responseReady;
                    const errorReady = once(response, "error");
                    await once(response, "data");
                    upstreamResponse.destroy();
                    const [error] = await errorReady;
                    assert.equal(error.code, "ECONNRESET");
                    await recorder.flush();
                    assert.equal(calls, 1, "upstream failure never retries the request");
                    assert.deepEqual(recorder.errors, ["ECONNRESET"]);
                    assert.deepEqual(recorder.cancellations, []);
                });
        } finally {
            const closed = once(upstream, "close");
            upstream.close();
            upstream.closeAllConnections();
            await closed;
            rmSync(baseDir, { recursive: true });
        }
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const provider = { id: "azure", type: "azure",
        baseUrl: `http://127.0.0.1:${upstream.address().port}/openai/deployments/real-model`,
        apiKey: "env:MODEL_RECORDER_TEST_KEY", models: [{ name: "real-model" }] };
    try {
        await withRealModelRecorder({ baseDir }, { allProviders: [provider] }, { model: { provider: provider.id, ref: "azure:real-model" } },
            async recorder => {
                const config = JSON.parse(readFileSync(recorder.modelProvidersPath, "utf8"));
                const response = await fetch(`${config.providers[0].baseUrl}/chat/completions?api-version=test`, {
                    method: "POST", body: JSON.stringify({ model: "real-model", tools: [] }),
                });
                assert.equal(response.status, 429);
                await response.text();
                assert.deepEqual(routes, ["/openai/deployments/real-model/chat/completions?api-version=test"]);
                assert.deepEqual(recorder.requests, [{ source: "http-request", model: "real-model", tools: [], status: 429 }]);
                assert.deepEqual(recorder.errors, ["MODEL_HTTP_429"]);
            });
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeAllConnections();
        await closed;
        rmSync(baseDir, { recursive: true });
    }
});
