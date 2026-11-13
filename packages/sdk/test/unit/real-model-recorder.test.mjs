import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRealModelRecorder } from "../helpers/real-model-recorder.mjs";

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
                assert.deepEqual(recorder.requests, [{ model: "real-model", tools: ["complete_workflow_node", "pkg_tool_a"] }]);
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

test("recording cannot silently replace an unsupported native model transport", async () => {
    await assert.rejects(withRealModelRecorder({}, { allProviders: [{ id: "native", type: "github" }] },
        { model: { provider: "native" } }, () => assert.fail("must not run")), /^Error: BLOCKED: no usable model:/);
});
