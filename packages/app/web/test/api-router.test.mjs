import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { OPERATIONS } from "pilotswarm-sdk/api";
import { createApiRouter } from "../api/router.js";
import { createJsonRpcError, installJsonBodyLimits } from "../server.js";

function createHarness({ callImpl, role = "user" } = {}) {
    const calls = [];
    const runtime = {
        started: true,
        mode: "local",
        async start() {},
        async getBootstrap() {
            return { mode: "local", workerCount: 1 };
        },
        async downloadArtifactBinary(sessionId, filename) {
            return { contentType: "application/octet-stream", body: Buffer.from(`${sessionId}:${filename}`) };
        },
        async call(name, params, authContext) {
            calls.push({ name, params, authContext });
            if (callImpl) return callImpl(name, params);
            return { echoed: name };
        },
    };
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "none", subject: "unknown" }, authorization: { allowed: true, role, reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, () => {
            const baseUrl = `http://localhost:${server.address().port}`;
            resolve({ baseUrl, calls, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

test("every operation in the table is routable and dispatches by name", async () => {
    // Admin role so Tier-2 admin ops also dispatch (their gating is covered separately).
    const { baseUrl, calls, close } = await createHarness({ role: "admin" });
    try {
        for (const op of OPERATIONS) {
            const path = op.path.replace(/:([\w]+)/g, "test-$1");
            const response = await fetch(`${baseUrl}/api/v1${path}`, {
                method: op.method,
                headers: { "content-type": "application/json" },
                ...(op.method === "GET" || op.method === "DELETE" ? {} : { body: "{}" }),
            });
            assert.equal(response.status, 200, `${op.method} ${path} should bind (${op.name})`);
            const payload = await response.json();
            assert.equal(payload.ok, true, `${op.name} envelope`);
        }
        const dispatched = calls.map((call) => call.name);
        assert.deepEqual([...new Set(dispatched)].sort(), OPERATIONS.map((op) => op.name).sort());
    } finally {
        await close();
    }
});

test("path, query, and body params are collected with declared types", async () => {
    const { baseUrl, calls, close } = await createHarness({ role: "admin" });
    try {
        const cursor = { updatedAt: 123, sessionId: "abc" };
        await fetch(`${baseUrl}/api/v1/management/sessions?limit=5&includeDeleted=true&systemFilter=exclude&viewerOnly=true&cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
        const page = calls.find((call) => call.name === "listSessionsPage");
        assert.deepEqual(page.params, { limit: 5, includeDeleted: true, systemFilter: "exclude", viewerOnly: true, cursor });

        await fetch(`${baseUrl}/api/v1/sessions/s1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hi", options: { clientMessageIds: ["m1"] }, ignored: "x" }),
        });
        const send = calls.find((call) => call.name === "sendMessage");
        assert.deepEqual(send.params, { sessionId: "s1", prompt: "hi", options: { clientMessageIds: ["m1"] } });
        assert.equal(send.authContext.principal.subject, "unknown", "auth context reaches the dispatcher");

        const eventTypes = ["user.message", "assistant.message", "system.message"];
        await fetch(`${baseUrl}/api/v1/management/sessions/s2/events-before?beforeSeq=100&limit=50&eventTypes=${encodeURIComponent(JSON.stringify(eventTypes))}`);
        const before = calls.find((call) => call.name === "getSessionEventsBefore");
        assert.deepEqual(before.params, { sessionId: "s2", beforeSeq: 100, limit: 50, eventTypes });

        await fetch(`${baseUrl}/api/v1/management/sessions/s2/events?afterSeq=5`);
        const after = calls.find((call) => call.name === "getSessionEvents");
        assert.deepEqual(after.params, { sessionId: "s2", afterSeq: 5 }, "omitted eventTypes stays absent");

        await fetch(`${baseUrl}/api/v1/management/workflows/workflow-1`);
        await fetch(`${baseUrl}/api/v1/management/workflows/workflow-1/executions`);
        assert.deepEqual(calls.find((call) => call.name === "getWorkflow")?.params, { sessionId: "workflow-1" });
        assert.deepEqual(calls.find((call) => call.name === "listWorkflowExecutions")?.params, { sessionId: "workflow-1" });

        const source = {
            kind: "git",
            repositoryUrl: "https://github.com/microsoft/PilotSwarm",
            gitRef: "refs/heads/main",
            workflowPath: "workflows/example.yaml",
        };
        await fetch(`${baseUrl}/api/v1/management/workflow-definitions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source, ignored: "x" }),
        });
        await fetch(`${baseUrl}/api/v1/management/workflow-definitions/definition-1`);
        assert.deepEqual(calls.find((call) => call.name === "registerWorkflowDefinition")?.params, { source });
        assert.deepEqual(calls.find((call) => call.name === "getWorkflowDefinition")?.params, {
            definitionId: "definition-1",
        });
    } finally {
        await close();
    }
});

test("runtime errors map to the structured envelope with sensible statuses", async () => {
    const { baseUrl, close } = await createHarness({
        callImpl: (name, params) => {
            if (name === "getSession") {
                throw Object.assign(new Error("nope"), { code: "PORTAL_AUTH_REQUIRED" });
            }
            if (name === "listSessionsPage") {
                throw new Error("listSessionsPage cursor.updatedAt must be a finite number");
            }
            if (name === "setSessionModel") {
                throw new Error("Unknown model: gpt-9-nonexistent");
            }
            if (name === "createSession") {
                if (params?.model === "missing") {
                    throw Object.assign(new Error('No usable provider serves model "missing".'), {
                        code: "MODEL_UNRESOLVED",
                    });

                    test("workflow Git registration errors preserve safe client status codes", async () => {
                        const { baseUrl, close } = await createHarness({
                            role: "admin",
                            callImpl: (name) => {
                                if (name === "registerWorkflowDefinition") {
                                    throw Object.assign(new Error("Workflow Git repository is not allowed."), {
                                        code: "WORKFLOW_GIT_REPOSITORY_REFUSED",
                                    });
                                }
                                return null;
                            },
                        });
                        try {
                            const response = await fetch(`${baseUrl}/api/v1/management/workflow-definitions`, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                    source: {
                                        kind: "git",
                                        repositoryUrl: "https://example.test/repository",
                                        gitRef: "main",
                                        workflowPath: "workflow.yaml",
                                    },
                                }),
                            });
                            assert.equal(response.status, 403);
                            const payload = await response.json();
                            assert.equal(payload.error.code, "WORKFLOW_GIT_REPOSITORY_REFUSED");
                        } finally {
                            await close();
                        }
                    });
                }
                throw Object.assign(new Error(
                    'Model "sonnet5" is ambiguous. Use one of: team:sonnet5, mine:sonnet5.',
                ), {
                    code: "MODEL_AMBIGUOUS",
                    candidates: ["team:sonnet5", "mine:sonnet5"],
                });
            }
            if (name === "regenerateSession") {
                throw Object.assign(new Error("System sessions are excluded from regeneration"), {
                    code: "REGENERATE_UNSUPPORTED",
                });
            }
            throw new Error("kaboom");
        },
    });
    try {
        const authRequired = await fetch(`${baseUrl}/api/v1/sessions/x`);
        assert.equal(authRequired.status, 401);
        assert.equal((await authRequired.json()).error.code, "PORTAL_AUTH_REQUIRED");

        const validation = await fetch(`${baseUrl}/api/v1/management/sessions`);
        assert.equal(validation.status, 400, "runtime validation errors map to 400");

        // Model validation is a client error: the message is the value, so it
        // must map to 400 and survive to the caller (not genericize to 500).
        const unknownModel = await fetch(`${baseUrl}/api/v1/management/sessions/s1/model`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ options: { model: "gpt-9-nonexistent" } }),
        });
        assert.equal(unknownModel.status, 400, "unknown model maps to 400");
        assert.match((await unknownModel.json()).error.message, /Unknown model/, "message preserved");

        const ambiguous = await fetch(`${baseUrl}/api/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "sonnet5" }),
        });
        assert.equal(ambiguous.status, 400, "ambiguous model maps to 400");
        assert.deepEqual((await ambiguous.json()).error, {
            code: "MODEL_AMBIGUOUS",
            message: 'Model "sonnet5" is ambiguous. Use one of: team:sonnet5, mine:sonnet5.',
            candidates: ["team:sonnet5", "mine:sonnet5"],
        });

        const unresolved = await fetch(`${baseUrl}/api/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "missing" }),
        });
        assert.equal(unresolved.status, 400, "unresolved model maps to 400");
        assert.match((await unresolved.json()).error.message, /No usable provider/);

        const regen = await fetch(`${baseUrl}/api/v1/management/sessions/s1/regenerate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ options: {} }),
        });
        assert.equal(regen.status, 409, "unsupported regeneration maps to 409");
        assert.match((await regen.json()).error.message, /excluded from regeneration/);

        const boom = await fetch(`${baseUrl}/api/v1/models`);
        assert.equal(boom.status, 500);
        assert.equal((await boom.json()).error.code, "INTERNAL_ERROR");

        const malformedCursor = await fetch(`${baseUrl}/api/v1/management/sessions?cursor=%7Bnope`);
        assert.equal(malformedCursor.status, 400, "malformed json query rejected before dispatch");
    } finally {
        await close();
    }
});

test("legacy RPC errors preserve client codes and redact unexpected faults", () => {
    const forbidden = createJsonRpcError(Object.assign(new Error("not yours"), { code: "FORBIDDEN" }));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.body.error, { code: "FORBIDDEN", message: "not yours" });

    const validation = createJsonRpcError(Object.assign(new Error("bad package"), {
        code: "VALIDATION_FAILED",
        validation: { errors: [{ code: "bad", message: "bad" }] },
    }));
    assert.equal(validation.status, 400);
    assert.deepEqual(validation.body.error.validation.errors, [{ code: "bad", message: "bad" }]);

    // Workspace files: the conflict's current etag (null: deleted) and a too-large file's size reach the browser.
    const gone = createJsonRpcError(Object.assign(new Error("the file was deleted since it was read"), { code: "WORKSPACE_FILES_CONFLICT", status: 409, etag: null }));
    assert.equal(gone.status, 409);
    assert.deepEqual(gone.body.error, { code: "WORKSPACE_FILES_CONFLICT", message: "the file was deleted since it was read", etag: null });
    const big = createJsonRpcError(Object.assign(new Error("larger than 20 MB"), { code: "WORKSPACE_FILES_TOO_LARGE", status: 413, size: 22020096 }));
    assert.deepEqual(big.body.error, { code: "WORKSPACE_FILES_TOO_LARGE", message: "larger than 20 MB", size: 22020096 });
    const plain = createJsonRpcError(Object.assign(new Error("nope"), { code: "FORBIDDEN", etag: { x: 1 }, size: "12" }));
    assert.deepEqual(plain.body.error, { code: "FORBIDDEN", message: "nope" }, "only a string or null etag and a number size");

    // A 5xx keeps its message only when the error says it may be shown.
    const off = createJsonRpcError(Object.assign(new Error("workspace files are not set up on this portal"), { code: "WORKSPACE_FILES_DISABLED", status: 503, expose: true }));
    assert.deepEqual(off, { status: 503, body: { ok: false, error: { code: "WORKSPACE_FILES_DISABLED", message: "workspace files are not set up on this portal" } } });
    const io = createJsonRpcError(Object.assign(new Error("EACCES: open '/ws/home/users/x/a.txt'"), { code: "WORKSPACE_FILES_IO", status: 500 }));
    assert.equal(io.body.error.message, "Internal server error", "an I/O error's message stays on the server");

    const fault = createJsonRpcError(new Error("connect ECONNREFUSED 10.0.0.7:5432 user=admin"));
    assert.equal(fault.status, 500);
    assert.deepEqual(fault.body.error, { code: "INTERNAL_ERROR", message: "Internal server error" });
});

test("traversal-shaped id path params are rejected before dispatch", async () => {
    const { baseUrl, calls, close } = await createHarness();
    try {
        // %2F decodes to "/" in the path param; a separator or ".." must never
        // reach the filesystem artifact store. Express rejects some shapes with
        // a routing 404 and our guard rejects the rest with 400 — either way
        // the request never dispatches.
        for (const badId of ["..%2F..%2Fetc", "a%2Fb", "%2e%2e"]) {
            const res = await fetch(`${baseUrl}/api/v1/sessions/${badId}/artifacts/x/text`);
            assert.ok(res.status === 400 || res.status === 404, `rejected ${badId} (got ${res.status})`);
            const dl = await fetch(`${baseUrl}/api/v1/sessions/${badId}/artifacts/x/download`);
            assert.ok(dl.status === 400 || dl.status === 404, `download rejected ${badId} (got ${dl.status})`);
        }
        assert.equal(calls.length, 0, "no traversal id reached the dispatcher");
    } finally {
        await close();
    }
});

test("admin-flagged operations require the admin role", async () => {
    // Default harness principal is role "user" — admin ops must 403 before dispatch.
    const { baseUrl, calls, close } = await createHarness();
    try {
        const purge = await fetch(`${baseUrl}/api/v1/facts/purge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: {} }),
        });
        assert.equal(purge.status, 403, "forcePurgeFacts requires admin");
        assert.equal((await purge.json()).error.code, "FORBIDDEN");
        assert.ok(!calls.some((c) => c.name === "forcePurgeFacts"), "admin op never dispatched for a non-admin");
    } finally {
        await close();
    }
});

test("admin operations dispatch for an admin principal", async () => {
    const { baseUrl, calls, close } = await createHarness({ role: "admin" });
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/purge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: { cutoff: "2020-01-01" } }),
        });
        assert.equal(res.status, 200, "admin passes the gate");
        assert.ok(calls.some((c) => c.name === "forcePurgeFacts"), "admin op dispatched");
    } finally {
        await close();
    }
});

test("no-auth (anonymous) callers pass the admin gate", async () => {
    // No-auth deployments resolve role "anonymous" = full access; admin ops must dispatch.
    const { baseUrl, calls, close } = await createHarness({ role: "anonymous" });
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/embedder/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 200, "no-auth admin op dispatches");
        assert.ok(calls.some((c) => c.name === "startFactsEmbedder"), "admin op reached the dispatcher in no-auth mode");
    } finally {
        await close();
    }
});

test("non-admin facts data-plane ops are not gated", async () => {
    const { baseUrl, calls, close } = await createHarness();
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/capabilities`);
        assert.equal(res.status, 200, "capabilities is open to any admitted caller");
        assert.ok(calls.some((c) => c.name === "factsCapabilities"));
    } finally {
        await close();
    }
});

test("unknown api routes return the NOT_FOUND envelope", async () => {
    const { baseUrl, close } = await createHarness();
    try {
        const response = await fetch(`${baseUrl}/api/v1/nope/nothing`);
        assert.equal(response.status, 404);
        const payload = await response.json();
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, "NOT_FOUND");
    } finally {
        await close();
    }
});

test("binary artifact download streams with attachment headers", async () => {
    const { baseUrl, close } = await createHarness();
    try {
        const response = await fetch(`${baseUrl}/api/v1/sessions/s1/artifacts/file.bin/download`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-disposition"), 'attachment; filename="file.bin"');
        assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "s1:file.bin");
    } finally {
        await close();
    }
});

// ── Access classification (security model) ───────────────────────────────

const VALID_ACCESS_CLASSES = new Set([
    "authed",
    "session:list", "session:create", "session:read", "session:write",
    "session:manage", "session:destroy", "session:share",
    // Workspace files (the Workspace pane): the session's owner only, with
    // no admin pass, enforced whatever AUTHZ_ENFORCE_OWNERSHIP says.
    "session:files",
    // Cross-session copy: the runtime gates fromSessionId for read and
    // toSessionId for write (runtime.js "session:copy" branch). In the table
    // since copyArtifact stopped being /api/rpc-only.
    "session:copy",
    "group:list", "group:manage",
    "facts:read", "facts:write",
    "fleet:read", "fleet:admin",
    "authz:audit",
    // The canvas KV store: both gate on session READ in the runtime; whether
    // a reader may write is the canvas policy's call inside the chokepoint.
    "canvas:read", "canvas:write",
]);

test("every protocol operation declares a known access class", () => {
    // A new op without a classification would default to "authed" in the
    // runtime gate — i.e. any admitted caller could invoke it. This lint keeps
    // the ownership model closed: adding an op forces an explicit access class.
    const unclassified = OPERATIONS.filter((op) => !op.access);
    assert.deepEqual(unclassified.map((op) => op.name), [], "every op must set `access`");

    const unknown = OPERATIONS.filter((op) => !VALID_ACCESS_CLASSES.has(op.access));
    assert.deepEqual(unknown.map((op) => `${op.name}:${op.access}`), [], "access classes must be from the known set");
});

test("every fleet:admin op is also admin-gated at the router", async () => {
    // The router hard-gates op.admin || op.access==='fleet:admin'. Verify each
    // fleet:admin op 403s for a non-admin regardless of the ownership flag.
    const fleetAdminOps = OPERATIONS.filter((op) => op.access === "fleet:admin");
    assert.ok(fleetAdminOps.length > 0, "there should be fleet:admin ops");
    const { baseUrl, calls, close } = await createHarness({ role: "user" });
    try {
        for (const op of fleetAdminOps) {
            const path = op.path.replace(/:([\w]+)/g, "test-$1");
            const res = await fetch(`${baseUrl}/api/v1${path}`, {
                method: op.method,
                headers: { "content-type": "application/json" },
                ...(op.method === "GET" || op.method === "DELETE" ? {} : { body: "{}" }),
            });
            assert.equal(res.status, 403, `${op.name} must 403 for a non-admin`);
        }
        assert.ok(!calls.some((c) => fleetAdminOps.find((op) => op.name === c.name)), "no fleet:admin op dispatched for a user");
    } finally {
        await close();
    }
});

test("session sharing ops are classified session:share", () => {
    for (const name of ["setSessionVisibility", "grantSessionShare", "revokeSessionShare", "listSessionShares"]) {
        const op = OPERATIONS.find((o) => o.name === name);
        assert.ok(op, `${name} present in the protocol table`);
        assert.equal(op.access, "session:share", `${name} must be session:share`);
    }
});

test("body limits: the workspace file routes take a whole file; other routes keep 2 MB", async () => {
    const app = express();
    installJsonBodyLimits(app, { workspaceFileMb: 20 });
    app.use((req, res) => res.json({ ok: true, bytes: String(req.body?.call?.contentBase64 || "").length }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ ok: false, type: error.type }));
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const base = `http://localhost:${server.address().port}/api/v1`;
        const body = JSON.stringify({ slot: 1, call: { op: "write", path: "work/big.bin", contentBase64: "x".repeat(3 * 1024 * 1024) } });
        const post = (path) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        for (const path of ["/management/sessions/s1/canvas-workspace", "/management/sessions/s1/workspace/files"]) {
            const response = await post(path);
            assert.equal(response.status, 200, path);
            assert.equal((await response.json()).bytes, 3 * 1024 * 1024, path);
        }
        assert.equal((await post("/management/sessions/s1/rename")).status, 413, "any other route keeps the 2 MB cap");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("/api/v1 errors keep a workspace conflict's etag, a too-large size, and an exposed 5xx message", async () => {
    const errors = {
        changed: Object.assign(new Error("the file changed since it was read"), { code: "WORKSPACE_FILES_CONFLICT", status: 409, etag: "sha256:abc" }),
        deleted: Object.assign(new Error("the file was deleted since it was read"), { code: "WORKSPACE_FILES_CONFLICT", status: 409, etag: null }),
        big: Object.assign(new Error("larger than 20 MB"), { code: "WORKSPACE_FILES_TOO_LARGE", status: 413, size: 22020096 }),
        late: Object.assign(new Error("the folder did not answer within 30 s"), { code: "WORKSPACE_FILES_TIMEOUT", status: 504, expose: true }),
        io: Object.assign(new Error("EACCES: open '/ws/home/users/x/a.txt'"), { code: "WORKSPACE_FILES_IO", status: 500, etag: "sha256:hidden" }),
    };
    let next = null;
    const { baseUrl, close } = await createHarness({ callImpl: () => { throw errors[next]; } });
    try {
        const call = async (name) => {
            next = name;
            const response = await fetch(`${baseUrl}/api/v1/management/sessions/s1/workspace/files`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ call: { op: "write", folder: "working", path: "a.txt", contentBase64: "", ifMatch: "sha256:old" } }),
            });
            return { status: response.status, error: (await response.json()).error };
        };
        assert.deepEqual(await call("changed"), { status: 409, error: { code: "WORKSPACE_FILES_CONFLICT", message: "the file changed since it was read", etag: "sha256:abc" } });
        assert.deepEqual(await call("deleted"), { status: 409, error: { code: "WORKSPACE_FILES_CONFLICT", message: "the file was deleted since it was read", etag: null } });
        assert.deepEqual(await call("big"), { status: 413, error: { code: "WORKSPACE_FILES_TOO_LARGE", message: "larger than 20 MB", size: 22020096 } });
        assert.deepEqual(await call("late"), { status: 504, error: { code: "WORKSPACE_FILES_TIMEOUT", message: "the folder did not answer within 30 s" } });
        assert.deepEqual(await call("io"), { status: 500, error: { code: "WORKSPACE_FILES_IO", message: "Internal server error" } }, "a fault shows neither its message nor its fields");
    } finally {
        await close();
    }
});
