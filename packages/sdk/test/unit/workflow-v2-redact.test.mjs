import test from "node:test";
import assert from "node:assert/strict";
import {
    redactErrorThenClip, redactThenClip, redactWorkflowErrorText, redactWorkflowErrorValue, redactWorkflowEventData, redactWorkflowSecrets,
    workflowOutputTail,
} from "../../dist/workflow/v2/redact.js";
import { canonicalJson } from "../../dist/workflow/v2/json.js";
import { sanitizeWorkflowErrorText, workflowAdapterFailure, workflowStoreFailure } from "../../dist/workflow/v2/failure.js";
import { WorkflowStoreError } from "../../dist/workflow/v2/store.js";
import { completeWorkflowNodeFromTool, workflowCompletionFailure } from "../../dist/workflow/v2/agent-node-service.js";
import { respondSessionRequestFromTool, workflowRespondFailure } from "../../dist/workflow/v2/request-service.js";
import { WorkflowSchemaSet } from "../../dist/workflow/v2/schema.js";
import { jsonbSafeText } from "../../dist/workflow/v2/json.js";
import { workflowTestAnsweredProjection } from "../../dist/workflow/v2/test-mode.js";

// Adversarial review SF-6: one secret-safe projection of workflow error text, wherever it is persisted or shown.

const SENTINEL = "s3nt1nel-Secr3t";

test("a URL's user and password, a Bearer credential and key=value secrets are hidden; the rest is kept", () => {
    assert.equal(redactWorkflowSecrets(`connect to postgres://app:${SENTINEL}@db.example:5432/wf failed`),
        "connect to postgres://<hidden>@db.example:5432/wf failed");
    assert.equal(redactWorkflowSecrets(`Authorization: Bearer ${SENTINEL}`), "Authorization: Bearer <hidden>");
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
    const value = { code: "execution_failed", message: `password=${SENTINEL}`, details: [{ token: SENTINEL, key: SENTINEL, tokenLimit: 5 }, `Bearer ${SENTINEL}`] };
    // SF-6 verification: a member called `key` is hidden too, unless the error's code says it names a workflow variable.
    assert.deepEqual(redactWorkflowErrorValue(value), {
        code: "execution_failed", message: "password=<hidden>", details: [{ token: "<hidden>", key: "<hidden>", tokenLimit: 5 }, "Bearer <hidden>"],
    });
    assert.deepEqual(redactWorkflowErrorValue({ code: "KV_LIMIT", message: "too long", details: { key: "threshold" } }),
        { code: "KV_LIMIT", message: "too long", details: { key: "threshold" } });
    assert.deepEqual(redactWorkflowErrorValue({ key: "threshold" }, { keepKey: true }), { key: "threshold" });
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
    const plain = new WorkflowStoreError("WORKFLOW_NOT_FOUND", "No Workflow x.");
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

// SF-6 verification: the remaining exits (tests M-06).
test("SF-6: a lowercase bearer or basic credential is hidden whole", () => {
    for (const text of [`authorization: bearer ${SENTINEL}`, `Authorization: BEARER ${SENTINEL}`, `header basic ${SENTINEL}`]) {
        const redacted = redactWorkflowSecrets(text);
        assert.ok(!redacted.includes(SENTINEL), redacted);
    }
    for (const prose of ["A basic idea.", "the bearer of this message"]) assert.equal(redactWorkflowSecrets(prose), prose);
});

test("SF-6: stored error text is redacted as JSON when it is JSON, and as text otherwise; unchanged text stays byte-identical", async () => {
    const { redactWorkflowErrorText } = await import("../../dist/workflow/v2/redact.js");
    const { canonicalJson } = await import("../../dist/workflow/v2/json.js");
    const json = JSON.stringify({ code: "execution_failed", message: `postgres://u:${SENTINEL}@h/db`, details: { key: SENTINEL } });
    const stored = redactWorkflowErrorText(json, canonicalJson);
    assert.ok(!stored.includes(SENTINEL), stored);
    assert.deepEqual(JSON.parse(stored).details, { key: "<hidden>" });
    assert.equal(redactWorkflowErrorText(`plain token=${SENTINEL}`, canonicalJson), "plain token=<hidden>");
    const clean = JSON.stringify({ code: "timed_out", message: "The run reached its deadline." });
    assert.equal(redactWorkflowErrorText(clean, canonicalJson), clean);
});

test("SF-6: a controller's error is shown and kept in recover receipts with its secrets hidden", async () => {
    const { inspectWorkflowV2Controller } = await import("../../dist/workflow/v2/service.js");
    const view = await inspectWorkflowV2Controller({ duroxideClient: { getStatus: async () => ({ status: "Failed", error: `boom {"password":"${SENTINEL}"} Bearer ${SENTINEL}` }) } },
        { status: "running", controllerInstanceId: "ctl" });
    assert.equal(view.status, "Failed");
    assert.equal(view.needsRecovery, true);
    assert.ok(!view.error.includes(SENTINEL), view.error);
});

test("SF-6: a refusal keeps a KV key in its details, and hides any other `key`", () => {
    const kv = workflowStoreFailure(new WorkflowStoreError("KV_LIMIT", "KV keys are 1-128 characters.", { key: "threshold" }));
    assert.deepEqual(kv.details, { key: "threshold" });
    const other = workflowStoreFailure(new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "bad", { key: SENTINEL }));
    assert.deepEqual(other.details, { key: "<hidden>" });
});

// Verification of SF-6 in E2 (E2-R2, the SF-6 residual; tests E2-T4, E2-T5).
test("E2-T4: an Authorization header or field hides its whole value after the scheme word, any characters, any length", () => {
    for (const [text, hidden] of [
        [`Authorization: Basic abcdefghij`, "Authorization: Basic <hidden>"],
        [`authorization: bearer abc`, "authorization: bearer <hidden>"],
        [`Authorization=Basic Zm9v OmJhcg==`, "Authorization=Basic <hidden>"],
        [`Proxy-Authorization: Negotiate ${SENTINEL} more`, "Proxy-Authorization: Negotiate <hidden>"],
        [`authorization: ${SENTINEL}`, "authorization: <hidden>"],
        [`authorization="Bearer ${SENTINEL} x"; next`, `authorization="Bearer <hidden>"; next`],
        [`x_authorization_header: Digest username="u", response="${SENTINEL}"`, "x_authorization_header: Digest <hidden>"],
        [`first line\nAuthorization: Bearer ab\nlast line`, "first line\nAuthorization: Bearer <hidden>\nlast line"],
    ]) {
        assert.equal(redactWorkflowSecrets(text), hidden, text);
    }
    // Hidden once: a second pass changes nothing.
    const once = redactWorkflowSecrets(`Authorization: Bearer ${SENTINEL}`);
    assert.equal(redactWorkflowSecrets(once), once);
    // A JSON field named authorization is hidden whole.
    assert.deepEqual(JSON.parse(redactWorkflowSecrets(JSON.stringify({ authorization: "Basic abc" }))), { authorization: "<hidden>" });
});

test("E2-T4: elsewhere a Bearer token or a Basic credential of 8 or more characters is hidden, whatever its mix; prose stays", () => {
    for (const [text, hidden] of [
        [`sent Bearer abcdefgh to it`, "sent Bearer <hidden> to it"],
        [`sent BEARER ${SENTINEL}.x`, "sent BEARER <hidden>"],
        [`with Basic dXNlcjpwYXNz`, "with Basic <hidden>"],
        [`with basic abcdefghij then`, "with basic <hidden> then"],
        [`header basic ${SENTINEL}`, "header basic <hidden>"],
    ]) {
        assert.equal(redactWorkflowSecrets(text), hidden, text);
    }
    for (const prose of ["A basic idea.", "the bearer of this message", "Bearer abc", "Basic plan"]) assert.equal(redactWorkflowSecrets(prose), prose);
});

test("E2-T5: a member named for a secret hides its whole value, a list or an object too; numbers stay", () => {
    const value = { code: "execution_failed", message: "failed", details: {
        tokens: [SENTINEL, "two"], credentials: { user: "u", pass: SENTINEL }, apiKey: { value: SENTINEL }, tokenLimit: 5, secretSet: true, sig: null,
    } };
    const out = redactWorkflowErrorValue(value);
    assert.deepEqual(out.details, { tokens: "<hidden>", credentials: "<hidden>", apiKey: "<hidden>", tokenLimit: 5, secretSet: true, sig: null });
    assert.ok(!JSON.stringify(out).includes(SENTINEL));
});

test("E2-T5: only the top-level error's own KV code keeps a `key`; nested details cannot label themselves", () => {
    assert.deepEqual(redactWorkflowErrorValue({ code: "KV_LIMIT", message: "too long", details: { key: "threshold", nested: { key: "limit" } } }).details,
        { key: "threshold", nested: { key: "limit" } });
    const forged = redactWorkflowErrorValue({ code: "execution_failed", message: "x", details: { code: "KV_LIMIT", key: SENTINEL, inner: [{ code: "KV_CONFLICT", key: SENTINEL }] } });
    assert.deepEqual(forged.details, { code: "KV_LIMIT", key: "<hidden>", inner: [{ code: "KV_CONFLICT", key: "<hidden>" }] });
    // An event's error field is its own top level.
    assert.deepEqual(redactWorkflowEventData({ runId: "r", error: { code: "KV_LIMIT", details: { key: "threshold" } } }).error.details, { key: "threshold" });
    assert.deepEqual(redactWorkflowEventData({ runId: "r", error: { code: "x", details: { code: "KV_LIMIT", key: SENTINEL } } }).error.details,
        { code: "KV_LIMIT", key: "<hidden>" });
});

test("E2bH-SF6-1: an event's lastError field is an error field: its secrets are hidden", () => {
    const out = redactWorkflowEventData({ runId: "r", exchangeId: "x", attempts: 8, lastError: `enqueue failed: token=${SENTINEL}` });
    assert.equal(out.lastError, "enqueue failed: token=<hidden>");
    assert.equal(out.attempts, 8);
});

// Verification E2bH-T5: an Authorization value in mixed quotes and in JSON diagnostics, a scheme word alone, an opaque
// value; and text clipped before it is redacted (several store writes clip first: a stop's or a cancel's reason, event
// fields clipped by their producer): a credential the clip cut short is hidden whatever its length, so no prefix of it
// shows; clipped after redaction, nothing of it shows either.
test("E2bH-T5: quoted and JSON Authorization values, a scheme word alone, an opaque value; a credential cut by a clip is hidden whatever its length", () => {
    for (const [text, hidden] of [
        [`authorization='Bearer ${SENTINEL}'; next`, `authorization='Bearer <hidden>'; next`],
        [`{"error":"connect failed: \\"Authorization: Bearer ${SENTINEL}\\""}`, null],
        [`Header "Authorization" was 'Basic ${SENTINEL}'`, null],
        [`Authorization: Bearer`, "Authorization: <hidden>"],
        [`Authorization: ${SENTINEL}`, "Authorization: <hidden>"],
    ]) {
        const out = redactWorkflowSecrets(text);
        assert.equal(out.includes(SENTINEL), false, `${text} -> ${out}`);
        if (hidden !== null) assert.equal(out, hidden, text);
    }
    // Clipped first, then redacted: every cut inside the credential, by jsonbSafeText as the store clips.
    const CUT = "Zq9xw7Lk";
    for (const [lead, tail] of [[`call failed: Bearer `, " and more"], [`call failed: basic `, " and more"],
        [`connect to postgres://admin:`, "@db.example.com:5432/app and more"], [`headers: Authorization: Bearer `, " and more"],
        [`retry with token=`, " and more"]]) {
        const text = `${lead}${CUT}${SENTINEL}${tail}`;
        for (let kept = 1; kept < CUT.length; kept += 1) {
            const out = redactWorkflowSecrets(jsonbSafeText(text, lead.length + kept));
            assert.equal(out.includes(CUT.slice(0, kept)), false, `${lead} cut after ${kept}: ${out}`);
        }
        // Redacted first, then clipped: nothing of it either.
        for (let kept = 1; kept < CUT.length + 10; kept += 1) {
            assert.equal(jsonbSafeText(redactWorkflowSecrets(text), lead.length + kept).includes(CUT.slice(0, 1)), false, `${lead} then cut`);
        }
    }
    // A short word that no clip cut is prose, as before; and a URL clipped in its path keeps its host.
    for (const prose of ["A basic idea.", "the bearer of this message", "Basic plan", "https://example.com/pa…"]) {
        assert.equal(redactWorkflowSecrets(prose), prose);
    }
});

// Adversarial review R3-SF-2: text is redacted whole before it is cut, so a credential longer than the cut leaves no part;
// text that was cut before (rows stored earlier) still has a cut URL's user and password hidden, however long, in linear
// time. S6-SF2 (reverting R3-SF-4's exemption): a host and a port of digits only, cut right after the port, cannot be
// told from a user and a password of digits, so it is hidden too; a URL cut later (in its path) keeps its host.
test("R3-SF-2, S6-SF2: a URL password longer than the cut leaves no part, cut after or before redaction; a cut host:port is hidden too", () => {
    const LONG = "p".repeat(600);
    const text = `stop it: postgres://admin:${LONG}${SENTINEL}@db.example.com/app and more`;
    for (const out of [redactThenClip(text, 500), redactWorkflowSecrets(jsonbSafeText(text, 500)), redactErrorThenClip(text, 500)]) {
        assert.equal(out.includes("pppppppp"), false, out.slice(0, 120));
        assert.equal(out.includes(SENTINEL), false);
        assert.ok(out.startsWith("stop it: postgres://<hidden>"), out.slice(0, 60));
    }
    // A long user before the cut, no password yet: hidden too.
    assert.equal(redactWorkflowSecrets(`postgres://${"u".repeat(400)}:…`), "postgres://<hidden>…");
    // A host and its port, cut right after the port, reads as a user and a password of digits: hidden (privacy wins).
    assert.equal(redactWorkflowSecrets("see https://api.example.com:443…"), "see https://<hidden>…");
    assert.equal(redactWorkflowSecrets("https://10.0.0.1:5432…"), "https://<hidden>…");
    assert.equal(redactWorkflowSecrets("https://admin:12345678…"), "https://<hidden>…");
    // Cut later, in its path: the host and port stay.
    assert.equal(redactWorkflowSecrets("https://api.example.com:443/v1/items…"), "https://api.example.com:443/v1/items…");
    assert.equal(redactWorkflowSecrets("https://admin:Zq9…"), "https://<hidden>…");
    assert.equal(redactWorkflowSecrets("https://admin:44x…"), "https://<hidden>…");
    // Linear time on long and hostile cut-URL shapes.
    for (const hostile of [`x://${"a".repeat(200_000)}:${"b".repeat(200_000)}`, `x://${"a:".repeat(100_000)}`, `${"x://".repeat(50_000)}a:b`,
        `x://${"1".repeat(200_000)}:${"2".repeat(200_000)}`]) {
        const started = process.hrtime.bigint();
        redactWorkflowSecrets(hostile);
        assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_000, `${hostile.slice(0, 8)}… took too long`);
    }
});

// Adversarial review R3-SF-3: a parallel state's timed_out report keeps its finished branches' business outputs exactly, as
// the blocked report does; its envelope, its other details and each branch's error have their secrets hidden. S6-SF2: only
// where the caller vouches for its origin (the controller's parallel decision, parallelReport); the same shape from
// anywhere else, an author's mocked error included, is an ordinary error.
test("R3-SF-3, S6-SF2: a vouched timed_out report keeps branch outputs as they are; the same shape unvouched is hidden like any error", () => {
    const output = { key: "ordinary-value", token: "an-ordinary-field", nested: { password: "a-business-field" } };
    const report = {
        joined: false, timedOut: true, total: 2, needed: 2, succeeded: 1, failFast: false,
        branches: [
            { index: 0, ended: "terminal", nodeExecutionId: "nx-a", outcome: "succeeded", resultKind: "business", output },
            { index: 1, ended: "cancelled", nodeExecutionId: "nx-b", outcome: "cancelled", resultKind: "runtime_error",
                error: { code: "cancelled", message: `token=${SENTINEL}`, details: { key: SENTINEL } }, cancelledBy: "timeout" },
        ],
    };
    const envelope = { code: "timed_out", message: `limit passed; password=${SENTINEL}`, details: report };
    const vouched = { parallelReport: true };
    const out = redactWorkflowErrorValue(envelope, vouched);
    assert.deepEqual(out.details.branches[0].output, output, "the business output exactly");
    assert.deepEqual(out.details.branches[0], report.branches[0]);
    assert.equal(JSON.stringify(out).includes(SENTINEL), false);
    assert.equal(out.message, "limit passed; password=<hidden>");
    assert.deepEqual(out.details.branches[1].error.details, { key: "<hidden>" });
    // The same as the blocked report's branch (a business output, never redacted), and as stored and read back.
    const blocked = { ...report, timedOut: false };
    assert.deepEqual(out.details.branches[0], blocked.branches[0]);
    const stored = redactWorkflowErrorText(canonicalJson(envelope), canonicalJson, vouched);
    assert.deepEqual(JSON.parse(stored).details.branches[0].output, output);
    // A report without secrets is stored as it was written.
    const clean = canonicalJson({ code: "timed_out", message: "limit passed", details: { ...report, branches: [report.branches[0]] } });
    assert.equal(redactWorkflowErrorText(clean, canonicalJson, vouched), clean);
    // Unvouched (any other writer or reader, an event's error, a forged mocked error of the same shape): hidden as any error.
    const hiddenOutput = { key: "<hidden>", token: "<hidden>", nested: { password: "<hidden>" } };
    assert.deepEqual(redactWorkflowErrorValue(envelope).details.branches[0].output, hiddenOutput);
    assert.deepEqual(JSON.parse(redactWorkflowErrorText(canonicalJson(envelope), canonicalJson)).details.branches[0].output, hiddenOutput);
    assert.deepEqual(redactWorkflowEventData({ error: envelope }).error.details.branches[0].output, hiddenOutput);
    assert.equal(JSON.stringify(redactWorkflowEventData({ error: canonicalJson(envelope) })).includes("an-ordinary-field"), false);
    // Any other error, timed_out included, keeps hiding a member named for a secret.
    assert.deepEqual(redactWorkflowErrorValue({ code: "timed_out", message: "x", details: { output: { key: "v" } } }, vouched).details, { output: { key: "<hidden>" } });
    assert.deepEqual(redactWorkflowErrorValue({ code: "timed_out", message: "x", details: { joined: false, timedOut: false, branches: [{ output: { key: "v" } }] } },
        vouched).details.branches[0].output, { key: "<hidden>" });
});

// Narrow verification of R3-SF-2 (S6-SF2): text cut before it was redacted (the effect orchestrations' 4,000-character
// message, an event's error) can end inside a JSON field named for a secret, with no closing quote. Its value is hidden to
// the end, plain or escaped inside a JSON string; a field with its closing quote, or one not named for a secret, is as
// before. Linear time on long and hostile shapes.
test("S6-SF2: a secret-named JSON field whose closing quote a clip removed is hidden to the end, plain or escaped", () => {
    const LONG = "t".repeat(5_000);
    const raw = `request failed: {"token":"${LONG}${SENTINEL}","other":1}`;
    // As the effect orchestration cut it before (4,000 characters), as text and inside its stored error.
    const cut = jsonbSafeText(raw, 4_000);
    assert.equal(redactWorkflowSecrets(cut), 'request failed: {"token":"<hidden>…');
    const stored = redactWorkflowErrorText(canonicalJson({ code: "execution_failed", message: cut }), canonicalJson);
    assert.equal(JSON.parse(stored).message, 'request failed: {"token":"<hidden>…');
    // A whole envelope cut as text (an event's error stored before): the field escaped inside its message.
    const shown = redactWorkflowSecrets(jsonbSafeText(canonicalJson({ code: "execution_failed", message: raw }), 2_000));
    assert.equal(shown.includes("tttttttt"), false, shown.slice(-80));
    assert.ok(shown.endsWith('\\"token\\":\\"<hidden>…'), shown.slice(-60));
    // Cut right after an escape character, or with no cut mark: still hidden to the end.
    assert.equal(redactWorkflowSecrets('{"password":"abc\\'), '{"password":"<hidden>');
    assert.equal(redactWorkflowSecrets('{"api_key": "abc'), '{"api_key": "<hidden>');
    // Closed fields, other names and prose: as before.
    assert.equal(redactWorkflowSecrets('{"token":"abc","note":"tail…'), '{"token":"<hidden>","note":"tail…');
    assert.equal(redactWorkflowSecrets('{"note":"abc…'), '{"note":"abc…');
    // Now redacted before it is cut: the same message leaves nothing either.
    assert.equal(redactThenClip(raw, 4_000).includes("tttttttt"), false);
    for (const hostile of [`{"token":"${"a".repeat(200_000)}`, '"token":"x\\'.repeat(100_000), '\\"token\\":\\"'.repeat(50_000),
        '"token":"a",'.repeat(50_000), `${'"token":"'.repeat(50_000)}"`]) {
        const started = process.hrtime.bigint();
        redactWorkflowSecrets(hostile);
        assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_000, `${hostile.slice(0, 12)}… took too long`);
    }
});

// Narrow verification of R3-SF-2 (S6-SF2): an answered test interception's error event is redacted whole before it is cut,
// so a mocked error's secret longer than the event's 2,000 characters leaves no part.
test("S6-SF2: a mocked error's event has its secrets hidden before it is cut", () => {
    const valueText = canonicalJson({ code: "execution_failed", message: "mocked", details: { token: `${"k".repeat(3_000)}${SENTINEL}` } });
    const projection = workflowTestAnsweredProjection({ workflowSessionId: "wf", runId: "run-1" }, { nodeExecutionId: "nx-1", nodeId: "review", ordinal: 1 },
        { interceptionId: "i-1", operation: "agent", response: { kind: "error", disposition: "parent" } },
        { outcome: "execution_failed", resultKind: "runtime_error", valueText, winner: "effect" });
    const error = projection.events[1].data.error;
    assert.equal(error.includes("kkkkkkkk") || error.includes(SENTINEL), false, error.slice(0, 120));
    assert.equal(JSON.parse(error).details.token, "<hidden>");
});

// Adversarial review R2-SF-4 (with R2-RT-3): the agent's completion tool and the request answer tool answer every failure
// through the same secret-safe projection, and a problem's message names no literal value of the schema's author.
test("R2-SF-4: complete_workflow_node's and respond_session_request's failures are coded, with their secrets hidden", async () => {
    const leaking = [
        new Error(`connect to postgres://app:${SENTINEL}@db.example:5432/wf failed; token=${SENTINEL}`),
        new WorkflowStoreError("NODE_CLOSED", `closed (token=${SENTINEL})`, { token: SENTINEL, nested: { url: `https://u:${SENTINEL}@x.example/y`, n: 1 } }),
    ];
    for (const error of leaking) {
        const completion = await completeWorkflowNodeFromTool({ outcome: "accepted", output: {}, operation_id: "op" },
            { callerSessionId: "child", client: null, store: { completeAgentNode: async () => { throw error; } } });
        const response = await respondSessionRequestFromTool({ request_id: "r", response: {}, operation_id: "op" },
            { callerSessionId: "parent", store: { respondToRequest: async () => { throw error; } } });
        for (const text of [completion, response, workflowCompletionFailure(error), workflowRespondFailure(error)]) {
            assert.ok(!text.includes(SENTINEL), text);
            const answer = JSON.parse(text);
            assert.equal(answer.ok, false);
            assert.equal(answer.error.code, error instanceof WorkflowStoreError ? "NODE_CLOSED" : "WORKFLOW_ERROR", text);
        }
    }
    // A refusal's problems (the store's answer) have their secrets hidden too.
    const refused = await completeWorkflowNodeFromTool({ outcome: "accepted", output: {}, operation_id: "op" }, { callerSessionId: "child", client: null,
        store: { completeAgentNode: async () => ({ kind: "refused", replayed: false, code: "OUTPUT_INVALID",
            problems: [{ path: "/", message: `bad token=${SENTINEL}` }], attemptsLeft: 2, state: "pending" }) } });
    assert.ok(!refused.includes(SENTINEL), refused);
    assert.deepEqual(JSON.parse(refused).error.code, "OUTPUT_INVALID");
});

test("R2-SF-4: a problem's message names no value of a const or an enum; its other details stay", () => {
    const set = new WorkflowSchemaSet({ C: { const: `${SENTINEL}-c` }, E: { enum: ["a", `${SENTINEL}-e`] }, N: { type: "integer", minimum: 3 } });
    const problems = [...set.validate("C", "x"), ...set.validate("E", "x")];
    assert.deepEqual(problems.map(problem => problem.message), ["The value must be the allowed value", "The value must be one of the allowed values"]);
    assert.ok(!JSON.stringify(problems).includes(SENTINEL));
    assert.deepEqual(set.validate("N", 1).map(problem => problem.message), ["The value must be at least 3"]);
});

// S7-DX stderr guard: a process output tail cut at its front begins inside a line, so a secret's value can be there without
// its name and no rule recognizes it. Its partial first line is dropped before redaction, and "…" marks the cut.
test("S7-DX: a process output tail cut at its front loses its partial first line before redaction", () => {
    const whole = `Error: boom\ntoken=${SENTINEL}\n`;
    assert.equal(workflowOutputTail(whole, false), whole, "output kept whole is unchanged");
    // The kept tail begins inside "token=<value>": only the value is left, with nothing that names it.
    const tail = `${SENTINEL}abcdef0123456789\nError: boom\n    at main (script.mjs:3:9)\n`;
    assert.equal(redactWorkflowSecrets(tail).includes(SENTINEL), true, "precondition: no rule recognizes a bare value");
    const guarded = workflowOutputTail(tail, true);
    assert.equal(guarded, "…\nError: boom\n    at main (script.mjs:3:9)\n");
    assert.equal(redactWorkflowSecrets(guarded).includes(SENTINEL), false);
    // One line only, cut: nothing of it is kept.
    assert.equal(workflowOutputTail(`${SENTINEL}${"x".repeat(100)}`, true), "…");
    // A tail cut right at a line's start loses nothing but that empty part.
    assert.equal(workflowOutputTail("\nnext line", true), "…\nnext line");
});
