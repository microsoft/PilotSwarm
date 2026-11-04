import test from "node:test";
import assert from "node:assert/strict";
import { redactWorkflowErrorValue, redactWorkflowEventData, redactWorkflowSecrets } from "../../dist/workflow/v2/redact.js";
import { sanitizeWorkflowErrorText, workflowAdapterFailure, workflowStoreFailure } from "../../dist/workflow/v2/failure.js";
import { WorkflowStoreError } from "../../dist/workflow/v2/store.js";

// Adversarial review SF-6: one secret-safe projection of workflow error text, wherever it is persisted or shown.

const SENTINEL = "s3nt1nel-Secr3t";

test("a URL's user and password, a Bearer credential and key=value secrets are hidden; the rest is kept", () => {
    assert.equal(redactWorkflowSecrets(`connect to postgres://app:${SENTINEL}@db.example:5432/wf failed`),
        "connect to postgres://<hidden>@db.example:5432/wf failed");
    assert.equal(redactWorkflowSecrets(`Authorization: Bearer ${SENTINEL}`), "Authorization: <hidden> <hidden>");
    assert.equal(redactWorkflowSecrets(`header was Bearer ${SENTINEL}.x`), "header was Bearer <hidden>");
    assert.equal(redactWorkflowSecrets(`Server=db;User Id=app;Password=${SENTINEL};Database=wf`), "Server=db;User Id=app;Password=<hidden>;Database=wf");
    assert.equal(redactWorkflowSecrets(`GET https://acct.blob.example/c/b?sv=2024&sig=${SENTINEL}&se=x`), "GET https://acct.blob.example/c/b?sv=2024&sig=<hidden>&se=x");
    assert.equal(redactWorkflowSecrets(`api_key: '${SENTINEL}' client_secret="${SENTINEL}" x-access-token=${SENTINEL}`),
        "api_key: <hidden> client_secret=<hidden> x-access-token=<hidden>");
    for (const plain of ["Input does not match node.check.input.", "The run reached its deadline (limits.timeoutSeconds 60) before it ended.",
        "Session 1234 does not exist or was deleted; this workflow cannot send to it.", "https://example.com/path is fine", "monkey=see"]) {
        assert.equal(redactWorkflowSecrets(plain), plain);
    }
});

test("JSON-shaped secret fields are hidden, in plain and in escaped JSON text", () => {
    const text = JSON.stringify({ code: "x", message: "failed", details: { token: SENTINEL, Authorization: `Bearer ${SENTINEL}`, apiKey: SENTINEL, kvKey: "threshold" } });
    const redacted = redactWorkflowSecrets(text);
    assert.ok(!redacted.includes(SENTINEL), redacted);
    assert.deepEqual(JSON.parse(redacted).details, { token: "<hidden>", Authorization: "<hidden>", apiKey: "<hidden>", kvKey: "threshold" });
    const nested = JSON.stringify({ error: text });
    const twice = redactWorkflowSecrets(nested);
    assert.ok(!twice.includes(SENTINEL), twice);
    assert.ok(!JSON.parse(twice).error.includes(SENTINEL));
    JSON.parse(JSON.parse(twice).error);
});

test("an error value has its secrets hidden at any depth; a field named for a secret is hidden whole", () => {
    const value = { code: "execution_failed", message: `password=${SENTINEL}`, details: [{ token: SENTINEL, key: "threshold", tokenLimit: 5 }, `Bearer ${SENTINEL}`] };
    assert.deepEqual(redactWorkflowErrorValue(value), {
        code: "execution_failed", message: "password=<hidden>", details: [{ token: "<hidden>", key: "threshold", tokenLimit: 5 }, "Bearer <hidden>"],
    });
    assert.equal(redactWorkflowErrorValue(null), null);
    assert.equal(redactWorkflowErrorValue(7), 7);
});

test("an event's error fields are redacted; its other fields are not", () => {
    const data = { runId: "run-1", error: `token=${SENTINEL}`, outputPreview: `token=${SENTINEL}`, nested: { cause: `secret=${SENTINEL}`, output: `secret=${SENTINEL}` },
        failure: { stateId: "s", code: "c", message: `postgres://u:${SENTINEL}@h/db`, problems: [] } };
    const out = redactWorkflowEventData(data);
    assert.equal(out.error, "token=<hidden>");
    assert.equal(out.nested.cause, "secret=<hidden>");
    assert.equal(out.failure.message, "postgres://<hidden>@h/db");
    assert.equal(out.outputPreview, `token=${SENTINEL}`);
    assert.equal(out.nested.output, `secret=${SENTINEL}`);
    assert.equal(out.runId, "run-1");
});

test("redaction takes linear time on long hostile text", () => {
    for (const text of ["a-".repeat(100_000), "a".repeat(200_000), "x.".repeat(100_000) + "://", `${"k".repeat(100_000)}token`]) {
        const started = process.hrtime.bigint();
        redactWorkflowSecrets(text);
        assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_000, `${text.slice(0, 8)}… took too long`);
    }
});

test("refusals, adapter errors and sanitized messages hide secrets", () => {
    const refusal = new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `bad value token=${SENTINEL}`, { authorization: `Bearer ${SENTINEL}` });
    const failure = workflowStoreFailure(refusal);
    assert.ok(failure instanceof WorkflowStoreError);
    assert.equal(failure.code, "WORKFLOW_COMMAND_INVALID");
    assert.equal(failure.message, "bad value token=<hidden>");
    assert.deepEqual(failure.details, { authorization: "<hidden>" });
    const plain = new WorkflowStoreError("WORKFLOW_NOT_FOUND", "No v2 workflow x.");
    assert.equal(workflowStoreFailure(plain), plain);

    const other = Object.assign(new Error(`read failed: {"password":"${SENTINEL}"}`), { code: "X", status: 400, details: { secret: SENTINEL } });
    const adapted = workflowAdapterFailure(other);
    assert.equal(adapted, other);
    assert.ok(!adapted.message.includes(SENTINEL));
    assert.deepEqual(adapted.details, { secret: "<hidden>" });
    assert.ok(!sanitizeWorkflowErrorText(`Authorization: Bearer ${SENTINEL} and {"token":"${SENTINEL}"}`).includes(SENTINEL));
});

// Verification VR-5: a JSON member named __proto__ stays an own member of the copy, with an ordinary prototype.
test("VR-5: an own __proto__ member survives redaction of an error value and of event data", async () => {
    const { canonicalJson } = await import("../../dist/workflow/v2/json.js");
    const error = JSON.parse(`{"code":"x","message":"token=${SENTINEL}","details":{"__proto__":{"a":1},"n":2}}`);
    const redacted = redactWorkflowErrorValue(error);
    assert.equal(Object.getPrototypeOf(redacted.details), Object.prototype);
    assert.ok(Object.hasOwn(redacted.details, "__proto__"));
    assert.deepEqual(redacted.details.__proto__, { a: 1 });
    assert.equal(redacted.message, "token=<hidden>");
    assert.match(JSON.stringify(redacted), /"__proto__":\{"a":1\}/);
    assert.doesNotThrow(() => canonicalJson(redacted));
    const data = JSON.parse(`{"runId":"r","__proto__":{"b":2},"error":{"__proto__":{"c":3},"message":"secret=${SENTINEL}"}}`);
    const out = redactWorkflowEventData(data);
    assert.ok(Object.hasOwn(out, "__proto__"));
    assert.deepEqual(out.__proto__, { b: 2 });
    assert.ok(Object.hasOwn(out.error, "__proto__"));
    assert.equal(out.error.message, "secret=<hidden>");
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.doesNotThrow(() => canonicalJson(out));
});
