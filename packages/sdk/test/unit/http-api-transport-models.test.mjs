import assert from "node:assert/strict";
import test from "node:test";
import { HttpApiTransport } from "../../api/src/http-api-transport.js";

test("model listing forwards placement options to the public API client", async () => {
    const calls = [];
    const transport = Object.create(HttpApiTransport.prototype);
    transport.api = {
        async call(name, params) {
            calls.push({ name, params });
            return [];
        },
    };

    await transport.listModels({
        compute: "devbox",
        repo: "sample-repo",
    });
    await transport.listModels();

    assert.deepEqual(calls, [
        {
            name: "listModels",
            params: { compute: "devbox", repo: "sample-repo" },
        },
        {
            name: "listModels",
            params: {},
        },
    ]);
});
