/**
 * Workflow Simplified stage 2.3 (P2, P3) and stage 2 review S2SF-F3: NodeSdkTransport.createWorkflowChat, the portal's
 * and the TUI direct mode's way to make a chat for a package's Workflow Definition. The chat is made with the instructions
 * prepared from one package version, and the attach takes exactly that version (its package id and content hash). When
 * the attach refuses (another version is active now, or the package is gone), no chat is left: it is deleted before it
 * has a turn, and no kickoff is sent.
 *
 * Run: node --test tui/test/workflow-chat-transport.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

const PREPARED = { ref: "release-tools/release-watch", semver: "1.0.0", packageId: "pkg-1", sha256: "a".repeat(64), model: null,
    title: "release-watch · release-tools", systemMessage: "This chat coordinates one Workflow Definition.", kickoff: "Greet them." };

function transportWith({ attach }) {
    const calls = [];
    const session = { sessionId: "chat-1", send: async (text, options) => { calls.push(["send", text, options?.sender?.kind]); } };
    const transport = {
        currentUser: null,
        sessionHandles: new Map(),
        client: { createSession: async (config) => { calls.push(["createSession", config.systemMessage]); return session; } },
        mgmt: {
            prepareWorkflowChat: async (ref) => { calls.push(["prepare", ref]); return PREPARED; },
            attachChatWorkflowPackage: async (sessionId, request) => { calls.push(["attach", sessionId, request]); return attach(request); },
            deleteSession: async (sessionId) => { calls.push(["delete", sessionId]); },
            getSession: async () => ({ model: "test:model" }),
        },
        createWorkflowChat: NodeSdkTransport.prototype.createWorkflowChat,
    };
    return { transport, calls };
}

test("the attach names the prepared package version; the kickoff is sent only after it", async () => {
    const { transport, calls } = transportWith({ attach: async () => ({ revision: 1, created: true }) });
    const made = await transport.createWorkflowChat(PREPARED.ref, { owner: { provider: "dev", subject: "alice" } });
    assert.equal(made.sessionId, "chat-1");
    assert.deepEqual(calls.map((call) => call[0]), ["prepare", "createSession", "attach", "send"]);
    assert.deepEqual(calls[2][2], { ref: PREPARED.ref, operationId: "workflow-chat:chat-1", coordinating: true, title: PREPARED.title,
        packageId: "pkg-1", sha256: PREPARED.sha256 });
    assert.equal(transport.sessionHandles.has("chat-1"), true);
});

test("S2SF-F3: when the attach refuses (another version, or no package), the chat is deleted, has no kickoff, and the refusal is the answer", async () => {
    for (const code of ["PACKAGE_VERSION_CHANGED", "PACKAGE_WORKFLOW_NOT_FOUND"]) {
        const { transport, calls } = transportWith({ attach: async () => { throw Object.assign(new Error(`refused ${code}`), { code }); } });
        await assert.rejects(transport.createWorkflowChat(PREPARED.ref, {}), (error) => error.code === code);
        assert.deepEqual(calls.map((call) => call[0]), ["prepare", "createSession", "attach", "delete"]);
        assert.equal(calls[3][1], "chat-1");
        assert.equal(transport.sessionHandles.has("chat-1"), false);
    }
});
