import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSessionsCommand } from "../src/sessions-cli.js";

test("human CLI output retains the exact discovery target and next-page cursor", async () => {
    const server = http.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        const result = request.url.includes("/steering-state")
            ? { steerable: true, expectedTarget: "captured-target-token" }
            : { items: [{ requestId: "r", disposition: "withdrawn" }], nextCursor: "opaque-next-cursor" };
        response.end(JSON.stringify(request.url.includes("auth/config") ? { enabled: false } : { ok: true, result }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        for (const [command, expected] of [["steering-state", "Expected target (--expected-target): captured-target-token"],
            ["steering-list", "Next cursor (--cursor): opaque-next-cursor"]]) {
            const lines = [], errors = [];
            assert.equal(await runSessionsCommand([command, "s", "--api-url", `http://127.0.0.1:${server.address().port}`],
                { output: text => lines.push(text), errorOutput: text => errors.push(text) }), 0);
            assert.match(lines.join("\n"), /Ready to steer|guidance receipts/);
            assert(lines.join("\n").includes(expected));
            assert.deepEqual(errors, []);
        }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
