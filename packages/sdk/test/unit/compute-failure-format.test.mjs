/**
 * The one line a compute failure becomes
 * (docs/proposals/compute-providers.md, "Failures").
 *
 * Every compute error the worker raises is built from a provider failure
 * through one helper, so it always reads `CODE: message`, carries its code
 * and retry hint, and is never prefixed twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTE_ERROR_CODES } from "../../dist/compute.js";
import { computeFailureError, computeFailureMessage, formatComputeFailure } from "../../dist/compute-failures.js";

test("a failure is its code and its message", () => {
    assert.equal(
        formatComputeFailure({ ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: "no host is free" }),
        "COMPUTE_UNAVAILABLE: no host is free");
    assert.equal(
        formatComputeFailure({ ok: false, code: "ACME_QUOTA_SPENT", message: "this account has no capacity left" }),
        "ACME_QUOTA_SPENT: this account has no capacity left");
});

test("the error the worker throws carries the code and the retry hint", () => {
    const error = computeFailureError({ code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: " the host is starting ", retryAfterMs: 5_000 });
    assert.equal(error.message, "COMPUTE_UNAVAILABLE: the host is starting");
    assert.equal(error.code, COMPUTE_ERROR_CODES.UNAVAILABLE);
    assert.equal(error.retryAfterMs, 5_000);
    assert.equal("retryAfterMs" in computeFailureError({ code: "X_Y", message: "m" }), false);
});

test("a failure without a code is reported as unavailable", () => {
    const error = computeFailureError({ code: "  ", message: "nothing said" });
    assert.equal(error.code, COMPUTE_ERROR_CODES.UNAVAILABLE);
    assert.equal(error.message, "COMPUTE_UNAVAILABLE: nothing said");
});

test("a failure raised again is never prefixed twice", () => {
    const first = computeFailureError({ code: COMPUTE_ERROR_CODES.HANDSHAKE_FAILED, message: "the host could not prove itself" });
    const again = computeFailureError({ code: first.code, message: computeFailureMessage(first.code, first) });
    assert.equal(again.message, "COMPUTE_HANDSHAKE_FAILED: the host could not prove itself");
    assert.equal(computeFailureMessage("COMPUTE_UNAVAILABLE", "plain text"), "plain text");
});
