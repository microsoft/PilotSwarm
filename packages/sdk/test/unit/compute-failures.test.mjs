import test from "node:test";
import assert from "node:assert/strict";
import { classifyComputeFailure, formatComputeFailure } from "../../dist/compute-failures.js";
import { COMPUTE_ERROR_CODES } from "../../dist/compute.js";

const permanentCodes = [
    "COMPUTE_TARGET_NOT_FOUND", "COMPUTE_TARGET_DISABLED", "COMPUTE_TARGET_FORBIDDEN",
    "COMPUTE_TARGET_INVALID", "COMPUTE_TARGET_CONFLICT", "COMPUTE_KIND_UNKNOWN",
    "COMPUTE_UNSUPPORTED", "COMPUTE_HOST_MODEL_UNAVAILABLE", "COMPUTE_ENDPOINT_REFUSED",
    "COMPUTE_HANDSHAKE_FAILED", "COMPUTE_SERVICE_IDENTITY_REFUSED",
];
for (const code of permanentCodes) {
    test(`${code} stops retries and gives a reason and corrective action`, () => {
        const failure = classifyComputeFailure(`${code}: original detail`);
        assert.equal(failure.code, code);
        assert.equal(failure.permanent, true);
        assert.match(failure.message, /original detail/);
        assert.ok(failure.action.length > 20);
        assert.ok(failure.message.endsWith(failure.action));
    });
}

test("every built-in code is classified", () => {
    for (const code of Object.values(COMPUTE_ERROR_CODES)) {
        assert.equal(classifyComputeFailure(`${code}: detail`).permanent, code !== "COMPUTE_UNAVAILABLE");
    }
});

test("unavailable keeps retries even when its detail looks like authentication or connection loss", () => {
    const result = classifyComputeFailure("COMPUTE_UNAVAILABLE: host offline; HTTP 401; connection closed");
    assert.equal(result.permanent, false);
    assert.match(result.message, /host offline/);
    assert.match(result.action, /start it/);
});

test("providers cannot override built-in classifications", () => {
    for (const permanent of [true, false]) {
        assert.equal(classifyComputeFailure({ ok: false, code: "COMPUTE_UNAVAILABLE", message: "offline", permanent }).permanent, false);
        assert.equal(classifyComputeFailure({ ok: false, code: "COMPUTE_TARGET_NOT_FOUND", message: "gone", permanent }).permanent, true);
    }
    assert.equal(classifyComputeFailure("COMPUTE_TARGET_DISABLED: [temporary] refused").permanent, true);
    assert.equal(classifyComputeFailure("COMPUTE_UNAVAILABLE: [permanent] offline").permanent, false);
});

test("provider-owned codes preserve their explicit kind across a string-only activity", () => {
    for (const permanent of [true, false]) {
        const original = { ok: false, code: "SANDBOX_QUOTA", message: "quota exceeded", permanent };
        const formatted = formatComputeFailure(original);
        const classified = classifyComputeFailure(formatted);
        assert.ok(classified, "the activity preserves the provider-owned failure");
        assert.equal(classified.permanent, permanent);
        assert.equal(classifyComputeFailure(original).permanent, permanent);
        assert.match(classifyComputeFailure(formatted).message, /quota exceeded/);
        assert.doesNotMatch(classifyComputeFailure(formatted).message, /\[(permanent|temporary)\]/);
    }
    assert.equal(classifyComputeFailure("COMPUTE_PROVIDER_BUSY: no capacity").permanent, false);
});

test("ordinary errors and mentions of compute codes do not change behavior", () => {
    for (const error of ["HTTP 401: Authentication failed", "connection closed", "Error with COMPUTE_TARGET_DISABLED: ignored", "COMPUTE_TARGET_DISABLED", "NETWORK: offline"]) {
        assert.equal(classifyComputeFailure(error), null, error);
    }
});

test("activity-wrapped compute errors are classified by their original code", () => {
    const prefix = "Activity 'runTurnV4' JS execution failed: GenericFailure, Error: ";
    for (const [message, permanent] of [
        ["COMPUTE_TARGET_NOT_FOUND: gone", true],
        ["COMPUTE_UNAVAILABLE: offline", false],
        ["SANDBOX_QUOTA: [permanent] refused", true],
    ]) {
        const classified = classifyComputeFailure(prefix + message);
        assert.ok(classified, "the runtime wrapper preserves the coded failure");
        assert.equal(classified.permanent, permanent);
    }
    assert.equal(classifyComputeFailure(`${prefix}ordinary runtime failure`), null);
    assert.equal(classifyComputeFailure("Text describing Activity 'runTurnV4' JS execution failed: GenericFailure, Error: COMPUTE_TARGET_DISABLED: ignored"), null);
});
