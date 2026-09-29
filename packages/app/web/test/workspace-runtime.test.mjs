/**
 * Session workspaces: the portal runtime bounds how long a workspace command
 * waits for its answer (review S-W5). The wait holds the HTTP request, so a
 * caller's timeout is clamped to 1 s .. 5 min, like the other long waits.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

test("set and retry workspace clamp the caller's wait", async () => {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = {
        setSessionWorkspace: async (sessionId, input, options) => { calls.push(["set", sessionId, input, options]); return { status: "unchanged" }; },
        retrySessionWorkspace: async (sessionId, options) => { calls.push(["retry", sessionId, options]); return { retried: false }; },
    };
    const admin = { principal: { provider: "entra", subject: "admin-1" }, authorization: { role: "admin" } };
    const set = (options) => runtime.call("setSessionWorkspace", { sessionId: "s1", expectedRevision: 1, workspace: null, ...(options ? { options } : {}) }, admin);
    await set({ timeoutMs: 1e12 });
    await set({ timeoutMs: 5 });
    await set();
    await runtime.call("retrySessionWorkspace", { sessionId: "s1", options: { timeoutMs: 1e12 } }, admin);
    await runtime.call("retrySessionWorkspace", { sessionId: "s1" }, admin);
    assert.deepEqual(calls.map((call) => call.at(-1).timeoutMs), [300_000, 1_000, 120_000, 300_000, 60_000]);
    assert.deepEqual(calls[0].slice(0, 3), ["set", "s1", { expectedRevision: 1, workspace: null }]);
});
