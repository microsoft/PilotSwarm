/**
 * Session workspaces: the portal runtime bounds how long a workspace command
 * waits for its answer (review S-W5). The wait holds the HTTP request, so a
 * caller's timeout is clamped to 1 s .. 5 min, like the other long waits.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

test("the transport configures webhook origins, workspace files and canvas commands together", (t) => {
    const env = {
        PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN: "https://hooks.example.invalid/",
        PORTAL_WORKSPACE_ROOTS: "fixture=/fixture/workspace",
        PORTAL_WORKSPACE_MAX_FILE_MB: "5",
        PORTAL_WORKSPACE_REQUIRE_MARKER: "",
        PORTAL_CANVAS_COMMANDS_RUNNER: "local",
        PORTAL_CANVAS_COMMANDS_ALLOW: "git",
    };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    Object.assign(process.env, env);
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    const config = runtime.transport.mgmt.config;
    assert.equal(config.webhookPublicOrigin, "https://hooks.example.invalid");
    assert.deepEqual(config.workspaceFiles, {
        roots: [{ name: "fixture", path: "/fixture/workspace" }],
        maxBytes: 5 * 1024 * 1024,
    });
    assert.deepEqual(config.canvasCommands, { runner: "local", allow: ["git"] });
});

test("the three workspace file operations are declared session:files", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const access = Object.fromEntries(OPERATIONS.filter((op) => ["listSessionWorkspaceFolders", "sessionWorkspaceFiles", "canvasWorkspace"].includes(op.name)).map((op) => [op.name, op.access]));
    assert.deepEqual(access, { listSessionWorkspaceFolders: "session:files", sessionWorkspaceFiles: "session:files", canvasWorkspace: "session:files" });
});

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

test("workspace files and canvas-ws: the session's owner only, admins included, with the ownership switch off", async () => {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId,
            isSystem: false,
            visibility: sessionId === "shared" ? "shared_write" : "private",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject,
            viewerShareAccess: null,
        }),
        listSessionWorkspaceFolders: async (sessionId) => { calls.push(["folders", sessionId]); return { enabled: true, maxBytes: 1, folders: [] }; },
        sessionWorkspaceFiles: async (sessionId, call) => { calls.push(["files", sessionId, call.op]); return { entries: [] }; },
        canvasWorkspace: async (sessionId, slot, call) => { calls.push(["canvas", sessionId, slot, call.op]); return { folders: [] }; },
    };
    const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });
    assert.equal(runtime.authz.enforce, false, "the test runs with the ownership switch off");

    await runtime.call("listSessionWorkspaceFolders", { sessionId: "s1" }, as("alice"));
    await runtime.call("sessionWorkspaceFiles", { sessionId: "s1", call: { op: "list", folder: "working" } }, as("alice"));
    await runtime.call("canvasWorkspace", { sessionId: "s1", slot: 1, call: { op: "info" } }, as("alice"));
    // canvas-ws is the same class: a canvas app runs as the person looking at it.
    await assert.rejects(runtime.call("canvasWorkspace", { sessionId: "s1", slot: 1, call: { op: "read", path: "work/a" } }, as("ada", "admin")),
        (error) => error.status === 403 && /owner/.test(error.message));
    await assert.rejects(runtime.call("canvasWorkspace", { sessionId: "shared", slot: 1, call: { op: "run", command: "history" } }, as("bob")),
        (error) => error.status === 403);
    await assert.rejects(runtime.call("canvasWorkspace", { sessionId: "s1", slot: 1, call: { op: "info" } }, as("bob")),
        (error) => error.status === 404);
    // An admin who is not the owner: no special access.
    await assert.rejects(runtime.call("listSessionWorkspaceFolders", { sessionId: "s1" }, as("ada", "admin")),
        (error) => error.status === 403 && /owner/.test(error.message));
    await assert.rejects(runtime.call("sessionWorkspaceFiles", { sessionId: "s1", call: { op: "read", folder: "working", path: "a" } }, as("ada", "admin")),
        (error) => error.status === 403);
    // Someone the session is shared with, even for writing.
    await assert.rejects(runtime.call("sessionWorkspaceFiles", { sessionId: "shared", call: { op: "list", folder: "working" } }, as("bob")),
        (error) => error.status === 403);
    // Someone who cannot see the session learns nothing about it.
    await assert.rejects(runtime.call("listSessionWorkspaceFolders", { sessionId: "s1" }, as("bob")),
        (error) => error.status === 404);
    assert.deepEqual(calls, [["folders", "s1"], ["files", "s1", "list"], ["canvas", "s1", 1, "info"]]);
});
