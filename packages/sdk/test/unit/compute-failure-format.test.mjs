/**
 * The one line a compute failure becomes
 * (docs/proposals/compute-providers.md, "Failures and their reasons").
 *
 * Every compute error the worker raises is built from a provider failure
 * through one helper, so what a provider said about its own failure — in
 * particular whether retrying can help at all — is still there for
 * whatever reads the turn's error.
 *
 * The rule that matters: a provider may say which kind one of ITS OWN
 * failures is, and only its own. A code PilotSwarm defines is classified
 * by PilotSwarm, so a provider cannot talk a permanent failure into
 * looking retryable or the other way round.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTE_ERROR_CODES } from "../../dist/compute.js";
import {
    classifyComputeFailure,
    computeFailureError,
    computeFailureMessage,
    formatComputeFailure,
    isBuiltInComputeCode,
} from "../../dist/compute-failures.js";

test("an ordinary failure is its code and its message", () => {
    assert.equal(
        formatComputeFailure({ ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: "no host is free" }),
        "COMPUTE_UNAVAILABLE: no host is free");
});

test("a provider's own code may say which kind it is", () => {
    assert.equal(
        formatComputeFailure({ ok: false, code: "ACME_QUOTA_SPENT", message: "this account has no capacity left", permanent: true }),
        "ACME_QUOTA_SPENT: [permanent] this account has no capacity left");
    assert.equal(
        formatComputeFailure({ ok: false, code: "ACME_WARMING_UP", message: "the pool is still filling", permanent: false }),
        "ACME_WARMING_UP: [temporary] the pool is still filling");
});

test("a provider cannot say which kind a built-in code is", () => {
    for (const code of Object.values(COMPUTE_ERROR_CODES)) {
        assert.equal(isBuiltInComputeCode(code), true, `${code} must be classified in compute-failures.ts`);
        for (const permanent of [true, false]) {
            assert.equal(
                formatComputeFailure({ ok: false, code, message: "whatever the provider says", permanent }),
                `${code}: whatever the provider says`,
                `${code} must not carry a provider's marker`);
        }
    }
    assert.equal(isBuiltInComputeCode("ACME_QUOTA_SPENT"), false);
});

test("a failure with no kind carries no marker at all", () => {
    assert.equal(
        formatComputeFailure({ ok: false, code: "ACME_SOMETHING", message: "it did not work" }),
        "ACME_SOMETHING: it did not work");
});

test("the error carries the code, the wait and a provider's own kind", () => {
    const own = computeFailureError({ code: "ACME_QUOTA_SPENT", message: "no capacity left", permanent: true });
    assert.equal(own.message, "ACME_QUOTA_SPENT: [permanent] no capacity left");
    assert.equal(own.code, "ACME_QUOTA_SPENT");
    assert.equal(own.permanent, true);

    const ours = computeFailureError({
        code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: "the host is offline",
        retryAfterMs: 5_000, permanent: true,
    });
    assert.equal(ours.message, "COMPUTE_UNAVAILABLE: the host is offline");
    assert.equal(ours.retryAfterMs, 5_000);
    assert.equal(ours.permanent, undefined, "a provider's marker is dropped on a built-in code");
});

test("a failure raised again from an error that already carries its code is not prefixed twice", () => {
    const first = computeFailureError({ code: COMPUTE_ERROR_CODES.HANDSHAKE_FAILED, message: "the host did not prove itself" });
    const again = computeFailureError({
        code: COMPUTE_ERROR_CODES.HANDSHAKE_FAILED,
        message: computeFailureMessage(COMPUTE_ERROR_CODES.HANDSHAKE_FAILED, first),
    });
    assert.equal(again.message, "COMPUTE_HANDSHAKE_FAILED: the host did not prove itself");

    // And a marker is not doubled either.
    const marked = computeFailureError({ code: "ACME_GONE", message: "that host was taken away", permanent: true });
    assert.equal(computeFailureMessage("ACME_GONE", marked), "that host was taken away");
});

test("a handshake failure uses the built-in code, and unreachability stays temporary", () => {
    assert.equal(COMPUTE_ERROR_CODES.HANDSHAKE_FAILED, "COMPUTE_HANDSHAKE_FAILED");
    assert.equal(COMPUTE_ERROR_CODES.UNAVAILABLE, "COMPUTE_UNAVAILABLE");
    assert.equal(isBuiltInComputeCode("COMPUTE_HANDSHAKE_FAILED"), true);
});

test("the codes the compute work added are classified the way the worker means them", () => {
    const kinds = Object.fromEntries(
        ["COMPUTE_HANDSHAKE_FAILED", "COMPUTE_SERVICE_IDENTITY", "COMPUTE_SERVICE_UNAVAILABLE", "COMPUTE_UNAVAILABLE"]
            .map((code) => [code, classifyComputeFailure(`${code}: something happened`)]));
    assert.equal(kinds.COMPUTE_HANDSHAKE_FAILED.permanent, true, "a host that cannot prove itself will not start proving itself");
    assert.equal(kinds.COMPUTE_SERVICE_IDENTITY.permanent, true, "a service that is not the registered one will not become it");
    assert.equal(kinds.COMPUTE_SERVICE_UNAVAILABLE.permanent, false, "a service that is not answering may answer later");
    assert.equal(kinds.COMPUTE_UNAVAILABLE.permanent, false);
    for (const [code, classified] of Object.entries(kinds)) {
        assert.ok(classified.action.trim(), `${code} must tell the person what to do`);
        assert.ok(classified.message.includes(code));
    }
});
