/**
 * Workflow Simplified stage 2.3 (P2, P3) and stage 2 review S2SF-F3: NodeSdkTransport.createSessionForWorkflow, the portal's
 * and the TUI direct mode's way to make a session for a package's Workflow Definition. The session is made with the instructions
 * prepared from one package version, and the attach takes exactly that version (its package id and content hash). When
 * the attach refuses (another version is active now, or the package is gone), no session is left: it is deleted before it
 * has a turn, and no kickoff is sent.
 *
 * Run: node --test tui/test/workflow-session-transport.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "pilotswarm-sdk";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

const PREPARED = { ref: "release-tools/release-watch", semver: "1.0.0", packageId: "pkg-1", sha256: "a".repeat(64), model: null,
    title: "release-watch · release-tools", systemMessage: "This session coordinates one Workflow Definition.", kickoff: "Greet them." };

function transportWith({ attach, currentUser = null }) {
    const calls = [];
    const session = { sessionId: "owner-1", send: async (text, options) => { calls.push(["send", text, options?.sender?.kind]); } };
    const mgmt = {
        _ensureStarted() {},
        _definitionFailure: (error) => error,
        prepareSessionForWorkflow: async (ref, principal) => { calls.push(["prepare", ref, principal]); return PREPARED; },
        attachSessionWorkflowPackage: async (sessionId, request, options) => { calls.push(["attach", sessionId, request, options?.principal]); return attach(request); },
        deleteSession: async (sessionId) => { calls.push(["delete", sessionId]); },
        getSession: async () => ({ model: "test:model" }),
    };
    mgmt.createSessionForWorkflow = PilotSwarmManagementClient.prototype.createSessionForWorkflow.bind(mgmt);
    const transport = {
        currentUser,
        sessionHandles: new Map(),
        client: { createSession: async (config) => { calls.push(["createSession", config.systemMessage, Object.hasOwn(config, "owner") ? config.owner : undefined]); return session; } },
        mgmt,
        createSessionForWorkflow: NodeSdkTransport.prototype.createSessionForWorkflow,
    };
    return { transport, calls };
}

test("the attach names the prepared package version; the kickoff is sent only after it", async () => {
    const { transport, calls } = transportWith({ attach: async () => ({ revision: 1, created: true }) });
    const made = await transport.createSessionForWorkflow(PREPARED.ref, { owner: { provider: "dev", subject: "alice" } });
    assert.equal(made.sessionId, "owner-1");
    assert.deepEqual(calls.map((call) => call[0]), ["prepare", "createSession", "attach", "send"]);
    assert.deepEqual(calls[2][2], { ref: PREPARED.ref, operationId: "session-for-workflow:owner-1", coordinating: true, title: PREPARED.title,
        packageId: "pkg-1", sha256: "a".repeat(64) });
    assert.equal(transport.sessionHandles.has("owner-1"), true);
});

test("Task 3: with currentUser set and no owner passed, prepare/attach receive currentUser as principal while createSession gets no owner", async () => {
    const localUser = { provider: "local", subject: "default", displayName: "Local" };
    const { transport, calls } = transportWith({ attach: async () => ({ revision: 1, created: true }), currentUser: localUser });
    await transport.createSessionForWorkflow(PREPARED.ref, {});
    assert.deepEqual(calls[0][2], localUser);
    assert.equal(calls[1][2], undefined, "createSession must receive no owner when owner is omitted");
    assert.deepEqual(calls[2][3], localUser);
});

test("S2SF-F3: when the attach refuses (another version, or no package), the session is deleted, has no kickoff, and the refusal is the answer", async () => {
    for (const code of ["PACKAGE_VERSION_CHANGED", "PACKAGE_WORKFLOW_NOT_FOUND"]) {
        const { transport, calls } = transportWith({ attach: async () => { throw Object.assign(new Error(`refused ${code}`), { code }); } });
        await assert.rejects(transport.createSessionForWorkflow(PREPARED.ref, {}), (error) => error.code === code);
        assert.deepEqual(calls.map((call) => call[0]), ["prepare", "createSession", "attach", "delete"]);
        assert.equal(calls[3][1], "owner-1");
        assert.equal(transport.sessionHandles.has("owner-1"), false);
    }
});

test("N-9: createSessionForWorkflow throws if NodeSdkTransport has not started (client is null)", async () => {
    const { transport } = transportWith({ attach: async () => ({ revision: 1, created: true }) });
    transport.client = null;
    await assert.rejects(transport.createSessionForWorkflow(PREPARED.ref, {}), /not started/);
});
