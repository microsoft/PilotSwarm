import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSessionsCommand } from "../src/sessions-cli.js";
import { callSteeringOperation } from "../../../sdk/api/src/steering.js";

test("CLI JSON keeps the typed too_large refusal", async () => {
    const server = http.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url.includes("auth/config") ? { enabled: false } : { ok: true, result: {} }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const errors = [];
    try {
        const exit = await runSessionsCommand(["steer", "s", "--api-url", `http://127.0.0.1:${server.address().port}`,
            "--text", "x".repeat(8193), "--client-request-id", "c", "--expected-target", "t", "--json"],
        { output() {}, errorOutput: text => errors.push(text) });
        assert.equal(exit, 1);
        const error = JSON.parse(errors.at(-1)).error;
        assert.equal(error.code, "too_large");
        assert.equal(error.limit, 8192);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
test("Web body-parser payload errors normalize to steering too_large", async () => {
    const result = await callSteeringOperation({ call: async () => {
        throw Object.assign(new Error("Request body too large"), { code: "PAYLOAD_TOO_LARGE", status: 413 });
    } }, "steerSessionTurn", {});
    assert.deepEqual(result, { ok: false, code: "too_large" });
});
