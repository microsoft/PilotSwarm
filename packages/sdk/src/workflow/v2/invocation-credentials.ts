import { createHash, randomBytes, randomUUID } from "node:crypto";
import { completeWorkflowNodeFromTool, type WorkflowAgentWakeClient } from "./agent-node-service.js";
import { respondSessionRequestFromTool, type WorkflowResponseWakeDispatcher } from "./request-service.js";
import type { WorkflowCredentialAudience, WorkflowInvocationCredential, WorkflowStore } from "./store.js";

/**
 * Workflow v2 invocation credentials (design 04: "The public completion
 * endpoint must not let an ordinary human bearer token complete a node. Use
 * trusted in-process context or scoped service-issued invocation credentials
 * with caller identity, audience, session/run/node binding, expiry and
 * revocation. Never place signing credentials in scripts or YAML. MCP and TUI
 * direct mode go through the same authorization layer." INACTIVE: no route,
 * tool or worker issues or accepts one yet).
 *
 * A credential lets one holder session act on one pending workflow effect from
 * outside its in-process tools: answer the request of a request state (audience
 * workflow.respond; the holder is its responder) or complete an agent state
 * (audience workflow.complete; the holder is its child). It is an opaque random
 * token (`pswic_` and 32 random bytes): there is no signing key anywhere, and
 * only its SHA-256 is stored (migration 0102). The host issues it, in process,
 * for a binding the store checks; the token is returned once.
 *
 * Using it (the single authorization layer for the REST, MCP and TUI routes):
 * the token must be given (a person's bearer token alone is never enough), be
 * known, not revoked or expired, carry the audience of the action and, where
 * the call names them, its request or node; the effect must still be pending
 * in an active run. The action then runs as the credential's holder through
 * the in-process tools' own implementation, which decides again under its
 * locks; nothing in the call names the acting session.
 *
 * Lifetime: at most `ttlSeconds` (default 3,600, at most 86,400), never past
 * the effect's deadline; revoked when another is issued for the same binding
 * (rotated), when its effect is found decided (decided), or explicitly.
 */

export const WORKFLOW_INVOCATION_CREDENTIAL_PREFIX = "pswic_";
export const WORKFLOW_V2_CREDENTIAL_DEFAULT_TTL_SECONDS = 3_600;
const TOKEN_PATTERN = /^pswic_[A-Za-z0-9_-]{43}$/;

/** A refused credential: its code and HTTP status. */
export class WorkflowCredentialError extends Error {
    readonly status: number;
    constructor(readonly code: string, message: string, readonly details: { [key: string]: string | null } | null = null) {
        super(message);
        this.name = "WorkflowCredentialError";
        this.status = code === "CREDENTIAL_SCOPE" ? 403 : code === "CREDENTIAL_CLOSED" ? 409 : 401;
    }
}

/** The SHA-256 of a well-formed token, or null for anything that is not one. */
export function invocationCredentialSha256(token: unknown): string | null {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issue a credential for `holderSessionId` on node execution `nodeExecutionId`
 * (the host's in-process call; see the module's comment). Returns the token,
 * once, and the stored record (which holds only its hash).
 */
export async function issueWorkflowInvocationCredential(store: Pick<WorkflowStore, "issueInvocationCredential">, input: {
    audience: WorkflowCredentialAudience;
    nodeExecutionId: string;
    holderSessionId: string;
    ttlSeconds?: number;
}): Promise<{ token: string; credential: WorkflowInvocationCredential }> {
    const token = `${WORKFLOW_INVOCATION_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    const credential = await store.issueInvocationCredential({
        credentialId: randomUUID(), tokenSha256: invocationCredentialSha256(token)!, audience: input.audience, nodeExecutionId: input.nodeExecutionId,
        holderSessionId: input.holderSessionId, ttlSeconds: input.ttlSeconds ?? WORKFLOW_V2_CREDENTIAL_DEFAULT_TTL_SECONDS,
    });
    return { token, credential };
}

/**
 * Check a token for one use of `expected.audience` (and, when named, on that
 * node execution and for that holder). Returns the credential; throws
 * WorkflowCredentialError: CREDENTIAL_REQUIRED (none given), CREDENTIAL_INVALID
 * (malformed or unknown), CREDENTIAL_REVOKED, CREDENTIAL_EXPIRED (401 each),
 * CREDENTIAL_SCOPE (403: another audience, effect or holder) or
 * CREDENTIAL_CLOSED (409: its effect was decided or its run ended; the
 * credential is revoked).
 */
export async function verifyWorkflowInvocationCredential(store: Pick<WorkflowStore, "verifyInvocationCredential">, token: unknown, expected: {
    audience: WorkflowCredentialAudience;
    nodeExecutionId?: string | null;
    holderSessionId?: string | null;
}): Promise<WorkflowInvocationCredential> {
    if (token === undefined || token === null || token === "") {
        throw new WorkflowCredentialError("CREDENTIAL_REQUIRED", "This action needs a workflow invocation credential; a person's sign-in alone does not grant it.");
    }
    const tokenSha256 = invocationCredentialSha256(token);
    if (tokenSha256 === null) throw new WorkflowCredentialError("CREDENTIAL_INVALID", "The workflow invocation credential is not valid.");
    const checked = await store.verifyInvocationCredential({ tokenSha256, ...expected });
    switch (checked.result) {
        case "valid": return checked.credential;
        case "invalid": throw new WorkflowCredentialError("CREDENTIAL_INVALID", "The workflow invocation credential is not valid.");
        case "revoked": throw new WorkflowCredentialError("CREDENTIAL_REVOKED", "The workflow invocation credential was revoked.",
            { reason: checked.credential?.revokedReason ?? null });
        case "expired": throw new WorkflowCredentialError("CREDENTIAL_EXPIRED", "The workflow invocation credential expired.");
        case "scope": throw new WorkflowCredentialError("CREDENTIAL_SCOPE", "The workflow invocation credential does not allow this action on this effect.");
        case "closed": throw new WorkflowCredentialError("CREDENTIAL_CLOSED", "The effect of this credential was already decided, or its run ended.",
            { nodeExecutionId: checked.credential?.nodeExecutionId ?? null });
    }
}

/**
 * Answer a request with a credential (the respond route's adapter): the
 * credential (audience workflow.respond) must be for this request, or names it
 * when the call does not; the answer is then given as its holder by
 * respond_session_request's own implementation. Returns its JSON answer;
 * throws a refused credential.
 */
export async function respondSessionRequestWithCredential(args: Record<string, unknown>, context: {
    token: unknown; store: WorkflowStore; dispatcher?: Pick<WorkflowResponseWakeDispatcher, "dispatchNow"> | null;
}): Promise<string> {
    const named = typeof args.request_id === "string" && args.request_id ? args.request_id : null;
    const credential = await verifyWorkflowInvocationCredential(context.store, context.token, { audience: "workflow.respond", nodeExecutionId: named });
    return respondSessionRequestFromTool({ ...args, request_id: credential.nodeExecutionId },
        { callerSessionId: credential.holderSessionId, store: context.store, dispatcher: context.dispatcher ?? null });
}

/**
 * Complete an agent state with a credential (the completion route's adapter):
 * the credential (audience workflow.complete) must be for this node execution
 * when the call names one (`node_execution_id`); the completion is then given
 * as its holder, the state's child, by complete_workflow_node's own
 * implementation. Returns its JSON answer; throws a refused credential.
 */
export async function completeWorkflowNodeWithCredential(args: Record<string, unknown>, context: {
    token: unknown; store: Pick<WorkflowStore, "verifyInvocationCredential" | "completeAgentNode">; client?: WorkflowAgentWakeClient | null;
}): Promise<string> {
    const named = typeof args.node_execution_id === "string" && args.node_execution_id ? args.node_execution_id : null;
    const credential = await verifyWorkflowInvocationCredential(context.store, context.token, { audience: "workflow.complete", nodeExecutionId: named });
    return completeWorkflowNodeFromTool(args, { callerSessionId: credential.holderSessionId, store: context.store, client: context.client ?? null });
}
