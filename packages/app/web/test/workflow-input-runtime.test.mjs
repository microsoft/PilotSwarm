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

// Adapted from the independent test design 090ad919-r2 (W1, W2): the portal passes the SDK's refusal on unchanged for an
// answer, steer or event to an agent state's subtree, stamps the person on ordinary input, and tells a caller who cannot
// read the session nothing about its workflow (design 03 "Direct human-input denial"; R13; T116). The W1 event row pins
// that the portal stamps no sender on sendSessionEvent today: change that row on purpose if it ever does.
// Distinctive ids so a leak check by substring is meaningful.
const SECRET_WF = "wf-secret-7c1e";
const SECRET_CTRL = "ctrl-secret-91ab";
const INPUT_REASON = "This session runs a workflow state. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.";
const SECRET_DENIED = { canSendPrompt: false, canAnswer: false, canSteer: false, reason: INPUT_REASON, workflowSessionId: SECRET_WF, controllingSessionId: SECRET_CTRL };
const SECRET_OPEN = { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null };

function inputDenial(sessionId, what) {
    return Object.assign(new Error(`Session ${sessionId} runs a workflow state for workflow ${SECRET_WF}: people cannot send it ${what}.`),
        { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403, details: { sessionId, controllingSessionId: SECRET_CTRL } });
}

/** alice owns every session (private); "child" is in an agent state's subtree; "plain" is ordinary. */
function inputRuntimeWith() {
    const calls = [];
    const policyReads = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    const owner = { provider: "dev", subject: "alice" };
    const input = (method, what) => async (sessionId, ...rest) => {
        calls.push([method, sessionId, ...rest]);
        if (sessionId === "child") throw inputDenial(sessionId, what);
        return { ok: true, method };
    };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: "root-1", isSystem: false, visibility: "private", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        getWorkflowInputPolicy: async (sessionId) => { policyReads.push(sessionId); return sessionId === "child" ? SECRET_DENIED : SECRET_OPEN; },
        recordAuthzAudit: async () => {},
        mgmt: { getSession: async () => null },
        sendMessage: input("sendMessage", "prompts"),
        sendAnswer: input("sendAnswer", "answers"),
        steerSessionTurn: input("steerSessionTurn", "steers"),
        sendSessionEvent: input("sendSessionEvent", "events"),
    };
    return { runtime, calls, policyReads };
}


const deniedExactly = (sessionId) => (error) => {
    assert.equal(error.code, "WORKFLOW_HUMAN_INPUT_DENIED");
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, { sessionId, controllingSessionId: SECRET_CTRL });
    return true;
};

// W1 — owner's answer/steer/event to an agent-state subtree session: refusal passes through unchanged; ordinary session works
// with the server-stamped sender (positive control); a forged client sender/caller is overwritten (negative control).
test("answer, steer and event to an agent state's subtree keep the SDK refusal; ordinary inputs carry a server-stamped person", async () => {
    const { runtime, calls } = inputRuntimeWith();
    await assert.rejects(runtime.call("sendAnswer", { sessionId: "child", answer: "yes" }, as("alice")), deniedExactly("child"));
    await assert.rejects(runtime.call("steerSessionTurn", { sessionId: "child", options: { prompt: "faster" } }, as("alice")), deniedExactly("child"));
    await assert.rejects(runtime.call("sendSessionEvent", { sessionId: "child", eventName: "nudge", data: { a: 1 } }, as("alice")), deniedExactly("child"));

    await runtime.call("sendAnswer", { sessionId: "plain", answer: "yes", options: { expectedQuestion: "q-1", sender: { kind: "agent", sessionId: "forged" } } }, as("alice"));
    await runtime.call("steerSessionTurn", { sessionId: "plain", options: { prompt: "faster", origin: "tui", caller: { sender: { kind: "agent" }, viewer: { principal: { provider: "dev", subject: "mallory" } } } } }, as("alice"));
    await runtime.call("sendSessionEvent", { sessionId: "plain", eventName: "nudge", data: { a: 1 } }, as("alice"));

    const [, , answer, answerOptions] = calls.find(([m, s]) => m === "sendAnswer" && s === "plain");
    assert.equal(answer, "yes");
    assert.equal(answerOptions.expectedQuestion, "q-1");
    assert.deepEqual(Object.keys(answerOptions).sort(), ["expectedQuestion", "sender"], "only expectedQuestion and the stamped sender reach the transport");
    assert.equal(answerOptions.sender.kind, "user");
    assert.equal(answerOptions.sender.provider, "dev");
    assert.equal(answerOptions.sender.subject, "alice");
    assert.equal(answerOptions.sender.origin, "api", "sendAnswer passes no origin to _buildSender: default api");

    const [, , steerOptions] = calls.find(([m, s]) => m === "steerSessionTurn" && s === "plain");
    assert.equal(steerOptions.prompt, "faster");
    assert.equal(steerOptions.caller.sender.kind, "user");
    assert.equal(steerOptions.caller.sender.subject, "alice");
    assert.equal(steerOptions.caller.sender.origin, "tui");
    assert.deepEqual(steerOptions.caller.viewer.principal, { provider: "dev", subject: "alice" }, "forged viewer overwritten");

    const event = calls.find(([m, s]) => m === "sendSessionEvent" && s === "plain");
    assert.deepEqual(event, ["sendSessionEvent", "plain", "nudge", { a: 1 }], "events carry no sender at 090ad919 (SDK decides)");
});

// W2 — privacy: a caller who cannot read the session learns nothing about the workflow; owner positive control sees it.
test("a non-reader gets exactly 404 Session not found with no workflow detail, no policy read and no transport input", async () => {
    const { runtime, calls, policyReads } = inputRuntimeWith();
    for (const [method, params] of [
        ["sendMessage", { sessionId: "child", prompt: "hi" }],
        ["sendAnswer", { sessionId: "child", answer: "yes" }],
        ["steerSessionTurn", { sessionId: "child", options: { prompt: "x" } }],
        ["sendSessionEvent", { sessionId: "child", eventName: "nudge", data: {} }],
        ["getSessionAccess", { sessionId: "child" }],
    ]) {
        await assert.rejects(runtime.call(method, params, as("bob")), (error) => {
            assert.equal(error.message, "Session not found.", method);
            assert.equal(error.code, "NOT_FOUND", method);
            assert.equal(error.status, 404, method);
            assert.deepEqual(Object.keys(error).sort(), ["code", "status"], `${method}: no details/workflowInput fields`);
            const text = `${error.message} ${JSON.stringify(error)}`;
            for (const secret of [SECRET_WF, SECRET_CTRL, INPUT_REASON, "workflow"]) assert.equal(text.includes(secret), false, `${method} leaks ${secret}`);
            return true;
        });
    }
    assert.equal(calls.length, 0, "no input reached the transport");
    assert.deepEqual(policyReads, [], "the workflow input policy was not even read for a non-reader");

    // Positive control: the owner reads the same session and sees the workflow detail the policy reports.
    const access = await runtime.call("getSessionAccess", { sessionId: "child" }, as("alice"));
    assert.equal(access.canSendPrompt, false);
    assert.equal(access.canAnswer, false);
    assert.equal(access.canSteer, false);
    assert.deepEqual(access.workflowInput, { reason: INPUT_REASON, workflowSessionId: SECRET_WF, controllingSessionId: SECRET_CTRL });
    assert.deepEqual(policyReads, ["child"]);
    // Ordinary-session control: no workflow fields at all.
    const plain = await runtime.call("getSessionAccess", { sessionId: "plain" }, as("alice"));
    for (const key of ["canSendPrompt", "canAnswer", "canSteer", "workflowInput"]) assert.equal(Object.hasOwn(plain, key), false, key);
});
