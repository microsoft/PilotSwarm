import test from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeWorkflowErrorText,
    workflowAdapterFailure,
    workflowStoreFailure,
    workflowStoreUnavailable,
} from "../../dist/workflow/v2/failure.js";
import { WorkflowStoreError } from "../../dist/workflow/v2/store.js";

// Batch 7 (n-3): a workflow read or command that fails is one coded error with a message that is safe to show.

const coded = (message, code) => Object.assign(new Error(message), { code });

test("a refusal keeps its own code and message", () => {
    const refusal = new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "Not now.");
    assert.equal(workflowStoreFailure(refusal), refusal);
    assert.equal(workflowStoreUnavailable(refusal), false);
    assert.equal(workflowAdapterFailure(refusal), refusal);
});

test("a store that cannot be reached or has no room is WORKFLOW_STORE_UNAVAILABLE", () => {
    const cases = [
        coded("sorry, too many clients already", "53300"),
        coded("terminating connection due to administrator command", "57P01"),
        coded("connection failure", "08006"),
        coded("connect failed", "ECONNREFUSED"),
        coded("read failed", "ECONNRESET"),
        coded("lookup failed", "ENOTFOUND"),
        new Error("FATAL: sorry, too many connections for role \"app\""),
        new Error("remaining connection slots are reserved for non-replication superuser connections"),
        new Error("timeout exceeded when trying to connect"),
        new Error("Connection terminated unexpectedly"),
        new Error("the database system is starting up"),
        new Error("Cannot use a pool after calling end on the pool; pool is ended"),
        "could not connect to server",
        new WorkflowStoreError("WORKFLOW_STORE_UNAVAILABLE", "The workflow store is not available right now: x"),
    ];
    for (const error of cases) {
        assert.equal(workflowStoreUnavailable(error), true, String(error?.message ?? error));
        const failure = workflowStoreFailure(error);
        assert.ok(failure instanceof WorkflowStoreError);
        assert.equal(failure.code, "WORKFLOW_STORE_UNAVAILABLE", String(error?.message ?? error));
        assert.match(failure.message, /^The workflow store is not available right now: /);
    }
    assert.equal(workflowStoreFailure(coded("sorry, too many clients already", "53300")).message,
        "The workflow store is not available right now: sorry, too many clients already");
});

test("any other error is WORKFLOW_ERROR with its own message", () => {
    for (const [error, message] of [
        [coded("syntax error at or near \"x\"", "42601"), "syntax error at or near \"x\""],
        [coded("duplicate key value violates unique constraint", "23505"), "duplicate key value violates unique constraint"],
        [new TypeError("Cannot read properties of undefined (reading 'x')"), "Cannot read properties of undefined (reading 'x')"],
        ["plain text", "plain text"],
        [42, "42"],
    ]) {
        assert.equal(workflowStoreUnavailable(error), false, message);
        const failure = workflowStoreFailure(error);
        assert.ok(failure instanceof WorkflowStoreError);
        assert.equal(failure.code, "WORKFLOW_ERROR");
        assert.equal(failure.message, message);
    }
});

test("an error with no text says no reason was given", () => {
    for (const error of [new Error(""), "", "   \n "]) {
        const failure = workflowStoreFailure(error);
        assert.equal(failure.code, "WORKFLOW_ERROR");
        assert.equal(failure.message, "No reason was given.");
    }
});

test("messages hide URLs and secret values, are one line, and are at most 500 characters", () => {
    const text = sanitizeWorkflowErrorText(new Error(
        "connect to postgres://app:pa55word@db.example:5432/workflows?sslmode=require failed\n\n  password=hunter2, token: abc123; api_key=k-9 secret=s3cr3t sig=xyz",
    ));
    assert.doesNotMatch(text, /pa55word|hunter2|abc123|k-9|s3cr3t|xyz|db\.example/);
    assert.match(text, /^connect to <url> failed password=<hidden>, token=<hidden>; api_key=<hidden> secret=<hidden> sig=<hidden>$/);
    assert.doesNotMatch(text, /\n/);

    const long = sanitizeWorkflowErrorText("x".repeat(600));
    assert.equal(long.length, 500);
    assert.ok(long.endsWith("…"));
    assert.equal(sanitizeWorkflowErrorText("y".repeat(500)), "y".repeat(500));

    const failure = workflowStoreFailure(coded(`could not reach postgresql://u:p@h/db ${"z".repeat(800)}`, "ECONNREFUSED"));
    assert.equal(failure.code, "WORKFLOW_STORE_UNAVAILABLE");
    assert.doesNotMatch(failure.message, /u:p@h/);
    assert.ok(failure.message.length <= "The workflow store is not available right now: ".length + 500);
});

test("a management adapter answers an unavailable store as a coded 503 it may show; anything else is passed on", () => {
    const original = coded("connect ECONNREFUSED 10.0.0.4:5432 (postgres://admin:topsecret@10.0.0.4/db)", "ECONNREFUSED");
    const adapted = workflowAdapterFailure(original);
    assert.notEqual(adapted, original);
    assert.ok(adapted instanceof Error);
    assert.equal(adapted.code, "WORKFLOW_STORE_UNAVAILABLE");
    assert.equal(adapted.status, 503);
    assert.equal(adapted.expose, true);
    assert.match(adapted.message, /^The workflow store is not available right now: /);
    assert.doesNotMatch(adapted.message, /topsecret/);

    const other = new Error("something else");
    assert.equal(workflowAdapterFailure(other), other);
});

test("a workflow tool whose host cannot be made answers like its own refusals: ok false, the code and the reason", async () => {
    const { workflowToolErrorPayload } = await import("../../dist/workflow/v2/tools.js");
    const unreachable = JSON.parse(workflowToolErrorPayload(coded("connect ECONNREFUSED 10.0.0.4:5432 postgres://u:secret@10.0.0.4/db", "ECONNREFUSED")));
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.error.code, "WORKFLOW_STORE_UNAVAILABLE");
    assert.match(unreachable.error.message, /^The workflow store is not available right now: connect ECONNREFUSED/);
    assert.doesNotMatch(unreachable.error.message, /secret/);
    const other = JSON.parse(workflowToolErrorPayload(new Error("unexpected")));
    assert.deepEqual(other, { ok: false, error: { code: "WORKFLOW_ERROR", message: "unexpected" } });
    const refusal = JSON.parse(workflowToolErrorPayload(new WorkflowStoreError("WORKFLOW_NOT_FOUND", "No Workflow x.")));
    assert.equal(refusal.error.code, "WORKFLOW_NOT_FOUND");
    assert.equal(refusal.error.message, "No Workflow x.");
});
