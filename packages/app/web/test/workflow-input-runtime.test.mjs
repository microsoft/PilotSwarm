/**
 * Workflow agent states (design 03 human-input denial; INACTIVE): the portal's
 * getSessionAccess tells a client that a session in a workflow agent state's
 * subtree takes no prompts, answers or steers from people (canSendPrompt,
 * canAnswer, canSteer false, with the workflow and its controlling agent),
 * whatever their write access; a session outside every agent state keeps the
 * response it always had. The refusal itself is the SDK's (the transport's
 * send raises it; the runtime passes it on with its status): a client's
 * flags only explain it.
 *
 * Run: node --test web/test/workflow-input-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

const DENIED = {
    canSendPrompt: false, canAnswer: false, canSteer: false,
    reason: "This session runs a workflow state. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.",
    workflowSessionId: "W", controllingSessionId: "P",
};

function runtimeWith() {
    const sent = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: "P", isSystem: false, visibility: "private", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        getWorkflowInputPolicy: async (sessionId) => (sessionId === "child"
            ? DENIED
            : { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null }),
        recordAuthzAudit: async () => {},
        mgmt: { getSession: async () => null },
        sendMessage: async (sessionId, prompt, options) => {
            if (sessionId === "child") {
                throw Object.assign(new Error(`Session ${sessionId} runs a workflow state for workflow W: people cannot send it prompts.`),
                    { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403 });
            }
            sent.push({ sessionId, prompt, sender: options.sender });
        },
    };
    return { runtime, sent };
}

const as = (subject) => ({ principal: { provider: "dev", subject }, authorization: { role: "user" } });

test("getSessionAccess adds the workflow input flags only for a session in an agent state's subtree", async () => {
    const { runtime } = runtimeWith();
    const child = await runtime.call("getSessionAccess", { sessionId: "child" }, as("alice"));
    assert.equal(child.canWrite, true);
    assert.equal(child.canSendPrompt, false);
    assert.equal(child.canAnswer, false);
    assert.equal(child.canSteer, false);
    assert.deepEqual(child.workflowInput, { reason: DENIED.reason, workflowSessionId: "W", controllingSessionId: "P" });

    const plain = await runtime.call("getSessionAccess", { sessionId: "plain" }, as("alice"));
    assert.equal(plain.canWrite, true);
    for (const key of ["canSendPrompt", "canAnswer", "canSteer", "workflowInput"]) assert.equal(Object.hasOwn(plain, key), false, key);
});

test("a person's prompt to such a session fails with the SDK's 403; an ordinary one is sent with the stamped sender", async () => {
    const { runtime, sent } = runtimeWith();
    await assert.rejects(runtime.call("sendMessage", { sessionId: "child", prompt: "hi" }, as("alice")),
        error => error.code === "WORKFLOW_HUMAN_INPUT_DENIED" && error.status === 403);
    await runtime.call("sendMessage", { sessionId: "plain", prompt: "hi", options: { sender: { kind: "agent", sessionId: "forged" } } }, as("alice"));
    assert.equal(sent.length, 1);
    // A client-supplied agent stamp is overwritten: the portal's caller is a person.
    assert.equal(sent[0].sender.kind, "user");
});
