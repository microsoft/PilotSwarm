import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { ApiClient } from "pilotswarm-sdk/api";
import { callSteeringOperation } from "../../../sdk/api/src/steering.js";
import { installJsonBodyLimits } from "../server.js";
import { createApiRouter } from "../api/router.js";

test("actual parent-app 2MiB parser refusal remains typed too_large for steering", async () => {
    const app = express();
    installJsonBodyLimits(app);
    let calls = 0;
    app.use("/api/v1", createApiRouter({ runtime: { started: true, call: async () => { calls++; } },
        requireAuth: (req, _res, next) => { req.auth = { principal: { provider: "test", subject: "a" }, authorization: { role: "user" } }; next(); } }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const api = new ApiClient({ apiUrl: `http://127.0.0.1:${server.address().port}` });
        assert.deepEqual(await callSteeringOperation(api, "steerSessionTurn", { sessionId: "s",
            options: { text: "x".repeat(2 * 1024 * 1024 + 1), clientRequestId: "c", expectedTarget: "t" } }),
        { ok: false, code: "too_large" });
        assert.equal(calls, 0);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
