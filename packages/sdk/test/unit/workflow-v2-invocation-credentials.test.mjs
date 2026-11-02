/**
 * Workflow v2 invocation credentials, inactive (workflow/v2/invocation-credentials.ts;
 * design 04 scoped invocation credentials), over fake stores.
 *
 * - Issue: an opaque `pswic_` token of 32 random bytes; the store gets only its
 *   SHA-256 (and a fresh credential id), with the default TTL unless one is given.
 * - Verify: no token (a person's sign-in alone) is CREDENTIAL_REQUIRED, a
 *   malformed one CREDENTIAL_INVALID without reading the store; each store
 *   outcome maps to its code and HTTP status.
 * - The adapters act only as the credential's holder: the completion and the
 *   response reach the in-process tools' implementation with the holder as the
 *   caller and the credential's effect, never a session or request the call
 *   names; a refused credential reaches nothing.
 *
 * Run: node --test test/unit/workflow-v2-invocation-credentials.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    completeWorkflowNodeWithCredential, invocationCredentialSha256, issueWorkflowInvocationCredential, respondSessionRequestWithCredential,
    verifyWorkflowInvocationCredential, WORKFLOW_V2_CREDENTIAL_DEFAULT_TTL_SECONDS, WorkflowCredentialError,
} from "../../dist/workflow/v2/invocation-credentials.js";

const CREDENTIAL = { credentialId: "c-1", audience: "workflow.complete", workflowSessionId: "W", runId: "R", nodeExecutionId: "nx-1",
    holderSessionId: "C", revokedReason: null };

test("issues an opaque token and gives the store only its hash", async () => {
    const seen = [];
    const store = { issueInvocationCredential: async input => { seen.push(input); return { ...CREDENTIAL, tokenSha256: input.tokenSha256 }; } };
    const issued = await issueWorkflowInvocationCredential(store, { audience: "workflow.complete", nodeExecutionId: "nx-1", holderSessionId: "C" });
    assert.match(issued.token, /^pswic_[A-Za-z0-9_-]{43}$/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tokenSha256, createHash("sha256").update(issued.token).digest("hex"));
    assert.equal(seen[0].ttlSeconds, WORKFLOW_V2_CREDENTIAL_DEFAULT_TTL_SECONDS);
    assert.match(seen[0].credentialId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(seen[0]).includes(issued.token), false, "the store never sees the token");
    const again = await issueWorkflowInvocationCredential(store, { audience: "workflow.respond", nodeExecutionId: "nx-2", holderSessionId: "P", ttlSeconds: 60 });
    assert.notEqual(again.token, issued.token);
    assert.equal(seen[1].ttlSeconds, 60);
    assert.equal(invocationCredentialSha256(issued.token), seen[0].tokenSha256);
    for (const bad of [undefined, null, 7, "", "pswic_short", `Bearer ${issued.token}`, `${issued.token}x`]) assert.equal(invocationCredentialSha256(bad), null, String(bad));
});

test("refuses a missing or malformed token without reading the store, and maps each store outcome", async () => {
    let reads = 0;
    const storeWith = outcome => ({ verifyInvocationCredential: async () => { reads += 1; return outcome; } });
    const token = `pswic_${"a".repeat(43)}`;
    for (const missing of [undefined, null, ""]) {
        await assert.rejects(verifyWorkflowInvocationCredential(storeWith({ result: "valid", credential: CREDENTIAL }), missing, { audience: "workflow.complete" }),
            error => error instanceof WorkflowCredentialError && error.code === "CREDENTIAL_REQUIRED" && error.status === 403);
    }
    await assert.rejects(verifyWorkflowInvocationCredential(storeWith({ result: "valid", credential: CREDENTIAL }), "not-a-token", { audience: "workflow.complete" }),
        error => error.code === "CREDENTIAL_INVALID" && error.status === 403);
    assert.equal(reads, 0);
    assert.deepEqual(await verifyWorkflowInvocationCredential(storeWith({ result: "valid", credential: CREDENTIAL }), token, { audience: "workflow.complete" }), CREDENTIAL);
    for (const [result, code, status] of [["invalid", "CREDENTIAL_INVALID", 403], ["revoked", "CREDENTIAL_REVOKED", 403], ["expired", "CREDENTIAL_EXPIRED", 403],
        ["scope", "CREDENTIAL_SCOPE", 403], ["closed", "CREDENTIAL_CLOSED", 409]]) {
        await assert.rejects(verifyWorkflowInvocationCredential(storeWith({ result, credential: { ...CREDENTIAL, revokedReason: "lost" } }), token,
            { audience: "workflow.complete" }), error => error.code === code && error.status === status, result);
    }
});

test("acts only as the credential's holder, on the credential's effect", async () => {
    const token = `pswic_${"b".repeat(43)}`;
    const verified = [];
    const completions = [];
    const responses = [];
    const store = (outcome) => ({
        verifyInvocationCredential: async input => { verified.push(input); return outcome; },
        completeAgentNode: async input => {
            completions.push(input);
            return { kind: "accepted", replayed: false, controllerInstanceId: "wfc-W", receipt: { nodeExecutionId: "nx-1", workflowSessionId: "W", runId: "R",
                stateId: "review", kind: "result", outcome: "accepted", operationId: input.operationId, resultSha256: "h", decidedAt: "2026-11-02T00:00:00.000Z" } };
        },
        respondToRequest: async input => { responses.push(input); return { kind: "accepted", replayed: false, status: "responded", receipt: { exchangeId: input.exchangeId } }; },
    });
    const valid = { result: "valid", credential: CREDENTIAL };
    const done = JSON.parse(await completeWorkflowNodeWithCredential({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1", caller: "X",
        session_id: "X" }, { token, store: store(valid) }));
    assert.equal(done.ok, true);
    assert.deepEqual(completions, [{ childSessionId: "C", operationId: "op-1", call: { outcome: "accepted", output: { verdict: "ok" } } }]);
    // No holder named by the call (an in-process caller): the credential's own holder acts.
    assert.deepEqual(verified.at(-1), { tokenSha256: invocationCredentialSha256(token), audience: "workflow.complete", nodeExecutionId: null,
        holderSessionId: null });

    const responder = { result: "valid", credential: { ...CREDENTIAL, audience: "workflow.respond", nodeExecutionId: "nx-9", holderSessionId: "P" } };
    const answered = JSON.parse(await respondSessionRequestWithCredential({ operation_id: "op-2", response: { approved: true } }, { token, store: store(responder) }));
    assert.equal(answered.ok, true);
    assert.deepEqual(responses, [{ exchangeId: "nx-9", actorSessionId: "P", operationId: "op-2", call: { response: { approved: true } } }]);
    assert.deepEqual(verified.at(-1), { tokenSha256: invocationCredentialSha256(token), audience: "workflow.respond", nodeExecutionId: null });

    // A named effect is checked against the credential; a refused credential reaches nothing.
    await assert.rejects(completeWorkflowNodeWithCredential({ node_execution_id: "nx-2", outcome: "accepted", operation_id: "op-3" },
        { token, store: store({ result: "scope", credential: CREDENTIAL }) }), error => error.code === "CREDENTIAL_SCOPE");
    assert.equal(verified.at(-1).nodeExecutionId, "nx-2");
    // A route names the session it is for: the credential must be held by it.
    await completeWorkflowNodeWithCredential({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-6" },
        { token, store: store(valid), holderSessionId: "C" });
    assert.equal(verified.at(-1).holderSessionId, "C");
    assert.equal(completions.at(-1).childSessionId, "C");
    await assert.rejects(respondSessionRequestWithCredential({ request_id: "nx-9", operation_id: "op-4", response: {} },
        { token: undefined, store: store(responder) }), error => error.code === "CREDENTIAL_REQUIRED");
    // Only the two valid completions and the one valid answer reached the store; the refused ones reached nothing.
    assert.equal(completions.length, 2);
    assert.equal(responses.length, 1);
});
