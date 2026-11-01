/**
 * Workflow v2 readWorkflow (GET /api/v1/sessions/:sessionId/workflow,
 * decision read-workflow-transport, option A): one protocol row, access
 * session:read. The portal runtime's session gate decides first, with the
 * standard not-found privacy, and only then does the transport read the
 * workflow (and look up its run); the transport's readWorkflow is the human
 * read adapter, never the agent tool's parent-only path. A content-bearing
 * read by an admin outside the owner's visibility is audited as break-glass.
 *
 * Run: node --test web/test/workflow-read-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

test("readWorkflow is one GET session:read operation: the session in the path, an optional run in the query", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const op = OPERATIONS.find((entry) => entry.name === "readWorkflow");
    assert.ok(op, "readWorkflow is a protocol operation");
    assert.deepEqual({ access: op.access, method: op.method, path: op.path, params: op.params }, {
        access: "session:read", method: "GET", path: "/sessions/:sessionId/workflow",
        params: { sessionId: { in: "path", name: "sessionId" }, runId: { in: "query", type: "string" } },
    });
    // The legacy creation route is unchanged.
    const create = OPERATIONS.find((entry) => entry.name === "createWorkflowSession");
    assert.deepEqual([create.method, create.path, create.access], ["POST", "/sessions/workflow", "session:create"]);
});

/** A runtime whose transport knows three sessions of alice's: s1 (private), shared (shared_read), and missing (none). */
function runtimeWith({ enforce }) {
    const calls = [];
    const audits = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce };
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (sessionId === "missing" ? null : {
            rootSessionId: sessionId,
            isSystem: false,
            visibility: sessionId === "shared" ? "shared_read" : "private",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject,
            viewerShareAccess: null,
        }),
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        readWorkflow: async (sessionId, options) => {
            calls.push([sessionId, options]);
            if (options.runId === "not-a-run") {
                throw Object.assign(new Error("Run not-a-run is not a run of this workflow."), { code: "RUN_NOT_FOUND", status: 404 });
            }
            return { workflowId: sessionId, run: null };
        },
    };
    return { runtime, calls, audits };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });

test("the session:read gate decides before the workflow is read, with not-found privacy (ownership enforced)", async () => {
    const { runtime, calls, audits } = runtimeWith({ enforce: true });
    assert.equal(runtime.authz.enforce, true);

    // The owner reads it, with and without a run; the run is passed to the transport's lookup only after the gate.
    assert.deepEqual(await runtime.call("readWorkflow", { sessionId: "s1" }, as("alice")), { workflowId: "s1", run: null });
    await runtime.call("readWorkflow", { sessionId: "s1", runId: "run-1" }, as("alice"));
    await assert.rejects(runtime.call("readWorkflow", { sessionId: "s1", runId: "not-a-run" }, as("alice")),
        (error) => error.code === "RUN_NOT_FOUND" && error.status === 404);
    // Someone the session is shared with for reading reads it.
    await runtime.call("readWorkflow", { sessionId: "shared" }, as("bob"));
    // Someone who cannot see it, and a session that does not exist, learn nothing: the same not-found, no read.
    for (const [sessionId, subject] of [["s1", "bob"], ["missing", "alice"]]) {
        await assert.rejects(runtime.call("readWorkflow", { sessionId }, as(subject)),
            (error) => error.status === 404 && error.code === "NOT_FOUND" && error.message === "Session not found.");
    }
    assert.deepEqual(calls, [["s1", {}], ["s1", { runId: "run-1" }], ["s1", { runId: "not-a-run" }], ["shared", {}]]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "deny"));

    // An admin outside the owner's visibility reads it, and the read is audited as break-glass.
    await runtime.call("readWorkflow", { sessionId: "s1" }, as("ada", "admin"));
    assert.deepEqual(calls.at(-1), ["s1", {}]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "break_glass"));
});

test("with the ownership switch off, readWorkflow behaves as every other session:read operation: audited, not blocked", async () => {
    const { runtime, calls, audits } = runtimeWith({ enforce: false });
    await runtime.call("readWorkflow", { sessionId: "s1" }, as("bob"));
    assert.deepEqual(calls, [["s1", {}]]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.decision === "would_deny"));
});
