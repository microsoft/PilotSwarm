/**
 * Workflow v2 invocation credentials (design 04 scoped, service-issued
 * invocation credentials; migration 0102), on real PostgreSQL, INACTIVE: no
 * route, tool or worker issues or accepts one yet.
 *
 * - Issue: only for the binding the store establishes (an agent state's child
 *   for workflow.complete, a request's responder for workflow.respond), only
 *   while the effect is pending; the row holds the token's SHA-256, never the
 *   token; it expires at the TTL or the effect's deadline, whichever is
 *   first; issuing again for the same binding revokes the earlier one.
 * - Verify: the audience and the effect must match (403 scope otherwise); an
 *   unknown or malformed token is invalid; an expired, rotated or revoked one
 *   is refused (401); after the effect is decided it is closed (409) and
 *   revoked.
 * - Use: a completion or a response with a valid credential is given as its
 *   holder by the in-process tools' own implementation; without a credential
 *   (a person's sign-in alone) nothing is decided.
 *
 * No model runs and no controller runs here.
 */
import { describe, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import {
    completeWorkflowNodeWithCredential, issueWorkflowInvocationCredential, respondSessionRequestWithCredential, verifyWorkflowInvocationCredential,
} from "../../src/workflow/v2/invocation-credentials.ts";
import { REQUEST_TIMEOUT, requestFixture } from "../helpers/workflow-v2-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-v2-invocation-credentials-test" };

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** An agent state of a live run of `parent`'s, admitted pending with its child. */
async function agentState(h) {
    const compiled = compileWorkflowV2(AGENT_YAML, { enableRequests: true, enableAgents: true });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: h.parent, owner: h.owner,
        creationConfig: { workflowV2: { requestSha256: "credentials" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: h.parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR, operationId: "create",
        requestSha256: "credentials", publish: true, title: "Workflow: reviewer",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
    });
    const child = randomUUID();
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await h.store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId: child, controllingSessionId: h.parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    return { workflowSessionId, runId, child, nodeExecutionId };
}

async function refusedWith(call, code, status) {
    let caught;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    if (status !== undefined) expect(caught?.status).toBe(status);
    return caught;
}

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

describe("workflow v2 invocation credentials (inactive)", () => {
    it("issues a completion credential only to an agent state's child, keeps only its hash, and lets only its holder complete the state", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const state = await agentState(h);
            const complete = { audience: "workflow.complete", nodeExecutionId: state.nodeExecutionId, holderSessionId: state.child };

            // Only the state's child, and only the completion audience, get one; nothing is written for a refusal.
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, { ...complete, holderSessionId: h.parent }), "CREDENTIAL_BINDING_INVALID");
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, { ...complete, audience: "workflow.respond" }), "CREDENTIAL_BINDING_INVALID");
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, { ...complete, ttlSeconds: 86_401 }), "WORKFLOW_COMMAND_INVALID");
            expect(await h.store.listInvocationCredentials(state.nodeExecutionId)).toEqual([]);

            const first = await issueWorkflowInvocationCredential(h.store, { ...complete, ttlSeconds: 60 });
            expect(first.token).toMatch(/^pswic_[A-Za-z0-9_-]{43}$/);
            expect(first.credential).toMatchObject({ audience: "workflow.complete", workflowSessionId: state.workflowSessionId, runId: state.runId,
                nodeExecutionId: state.nodeExecutionId, holderSessionId: state.child, revokedAt: null, tokenSha256: sha256(first.token) });
            // Its lifetime is the TTL (the state's deadline is an hour away); the stored row holds the hash, never the token.
            expect(first.credential.expiresAt.getTime() - first.credential.issuedAt.getTime()).toBe(60_000);
            const stored = await h.q(`SELECT row_to_json(c)::text AS row FROM SCHEMA.workflow_invocation_credentials c WHERE node_execution_id = $1`,
                [state.nodeExecutionId]);
            expect(stored).toHaveLength(1);
            expect(stored[0].row).not.toContain(first.token);
            expect(stored[0].row).not.toContain(first.token.slice("pswic_".length));

            // It is checked for its audience and effect; an unknown or malformed token is invalid.
            expect(await verifyWorkflowInvocationCredential(h.store, first.token, { audience: "workflow.complete", nodeExecutionId: state.nodeExecutionId }))
                .toMatchObject({ credentialId: first.credential.credentialId });
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, first.token, { audience: "workflow.respond" }), "CREDENTIAL_SCOPE", 403);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, first.token, { audience: "workflow.complete", nodeExecutionId: "nx-other" }),
                "CREDENTIAL_SCOPE", 403);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, `pswic_${"A".repeat(43)}`, { audience: "workflow.complete" }), "CREDENTIAL_INVALID", 401);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, "Bearer something", { audience: "workflow.complete" }), "CREDENTIAL_INVALID", 401);

            // Issuing again rotates: the earlier one is revoked. An expired one is refused; an explicit revocation holds.
            const second = await issueWorkflowInvocationCredential(h.store, complete);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, first.token, { audience: "workflow.complete" }), "CREDENTIAL_REVOKED", 401);
            expect((await h.store.listInvocationCredentials(state.nodeExecutionId)).map(item => item.revokedReason)).toEqual(["rotated", null]);
            await h.q(`UPDATE SCHEMA.workflow_invocation_credentials SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
                WHERE credential_id = $1`, [second.credential.credentialId]);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, second.token, { audience: "workflow.complete" }), "CREDENTIAL_EXPIRED", 401);
            const third = await issueWorkflowInvocationCredential(h.store, complete);
            expect(await h.store.revokeInvocationCredentials({ credentialId: third.credential.credentialId, reason: "lost" })).toBe(1);
            expect(await h.store.revokeInvocationCredentials({ credentialId: third.credential.credentialId, reason: "again" })).toBe(0);
            const revoked = await refusedWith(() => verifyWorkflowInvocationCredential(h.store, third.token, { audience: "workflow.complete" }),
                "CREDENTIAL_REVOKED", 401);
            expect(revoked.details).toEqual({ reason: "lost" });

            // A person's sign-in alone completes nothing; the holder's credential completes the state as its child.
            const done = { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" };
            await refusedWith(() => completeWorkflowNodeWithCredential(done, { token: undefined, store: h.store }), "CREDENTIAL_REQUIRED", 401);
            expect((await h.store.readNodeExecution(state.nodeExecutionId)).state).toBe("pending");
            const fourth = await issueWorkflowInvocationCredential(h.store, complete);
            const answer = JSON.parse(await completeWorkflowNodeWithCredential({ ...done, node_execution_id: state.nodeExecutionId },
                { token: fourth.token, store: h.store }));
            expect(answer).toMatchObject({ ok: true, replayed: false, nodeExecutionId: state.nodeExecutionId, outcome: "accepted", kind: "result" });
            expect(await h.store.readNodeExecution(state.nodeExecutionId)).toMatchObject({ state: "completed", winner: "agent", output: { verdict: "ok" } });

            // Once the state is decided its credential is closed (and revoked), and no new one is issued.
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, fourth.token, { audience: "workflow.complete" }), "CREDENTIAL_CLOSED", 409);
            expect((await h.store.listInvocationCredentials(state.nodeExecutionId)).at(-1)).toMatchObject({ revokedReason: "decided" });
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, complete), "CREDENTIAL_BINDING_CLOSED");
        } finally {
            await h.stop();
        }
    });

    it("issues a response credential only to a request's responder, and answers the request as the responder with it", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            const respond = { audience: "workflow.respond", nodeExecutionId: exchangeId, holderSessionId: h.parent };
            const someone = randomUUID();
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, { ...respond, holderSessionId: someone }), "CREDENTIAL_BINDING_INVALID");
            await refusedWith(() => issueWorkflowInvocationCredential(h.store, { ...respond, audience: "workflow.complete" }), "CREDENTIAL_BINDING_INVALID");
            const issued = await issueWorkflowInvocationCredential(h.store, respond);

            // The credential names the request; a call naming another request is out of its scope.
            await refusedWith(() => respondSessionRequestWithCredential({ request_id: "nx-other", operation_id: "op-0", response: { approved: true } },
                { token: issued.token, store: h.store }), "CREDENTIAL_SCOPE", 403);
            await refusedWith(() => respondSessionRequestWithCredential({ request_id: exchangeId, operation_id: "op-0", response: { approved: true } },
                { token: null, store: h.store }), "CREDENTIAL_REQUIRED", 401);
            const answer = JSON.parse(await respondSessionRequestWithCredential({ operation_id: "op-1", response: { approved: true } },
                { token: issued.token, store: h.store }));
            expect(answer).toMatchObject({ ok: true, replayed: false });
            expect(await h.store.readNodeExecution(exchangeId)).toMatchObject({ state: "completed", winner: "response", output: { approved: true } });
            const operations = await h.q(`SELECT actor_session_id FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1`, [exchangeId]);
            expect(operations).toEqual([{ actor_session_id: h.parent }]);
            await refusedWith(() => verifyWorkflowInvocationCredential(h.store, issued.token, { audience: "workflow.respond" }), "CREDENTIAL_CLOSED", 409);
        } finally {
            await h.stop();
        }
    });
});
