/**
 * Workflow Simplified stage 2.1b: a chat's Workflow Definitions through the portal (the Workflow tab's reads and a
 * person's save, start and delete), over the actual HTTP route with HttpApiTransport (the browser transport's base) and
 * through the runtime directly:
 * - readChatWorkflowDefinition says whether this caller may save, start and delete (`viewer`, updateWorkflow's own
 *   session:manage gate, decided on the read's access); a revision's YAML is for one who may: anyone else who can read the
 *   chat gets no YAML, and the input schema and diagnostics as a Workflow's reader gets them (R2-SF-2);
 * - list and read are session:read, with not-found privacy; save, start and delete are session:manage, and carry the
 *   signed-in caller as the actor, never a field of the request.
 *
 * Run: node --test web/test/workflow-chat-definitions-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";

import { PilotSwarmManagementClient } from "pilotswarm-sdk";
import { WorkflowStoreError } from "../../../sdk/dist/workflow/v2/store.js";
import { chatDefinitionFailure } from "../../ui/core/src/workflow-chat-definitions.js";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";

process.env.PILOTSWARM_WORKFLOWS = "on";

const SENTINEL = "sentinel-s21b-4c1e";
const owner = { provider: "dev", subject: "alice" };

/** A definition read as the management client answers it (stage 2.1b: with its graph and personCommands). */
function readOf(sessionId) {
    return {
        definitionId: "def-hn", ownerSessionId: sessionId, name: "hn-top-watch", currentRevision: 2, source: "chat", deletedAt: null,
        createdAt: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T09:02:00.000Z", newestValidRevision: 1,
        revisions: [], workflows: [], current: null,
        revision: { definitionId: "def-hn", revision: 2, valid: false, semver: "1.0.0", yamlSha256: "y2", irSha256: null, basedOn: 1,
            actor: { kind: "chat", sessionId }, imported: false, createdAt: "2026-11-07T09:02:00.000Z", errorCount: 1,
            yaml: `apiVersion: pilotswarm.dev/v2-draft\n# ${SENTINEL}\n`,
            diagnostics: [{ severity: "error", code: "WORKFLOW_SCHEMA_INVALID", path: `schemas.${SENTINEL}`, line: 2, message: `bad ${SENTINEL}` }] },
        graph: { revision: 2, initial: "calc", states: [], inputsSchema: { type: "object", description: SENTINEL, required: ["topic"],
            properties: { topic: { type: "string", default: SENTINEL, minLength: 2 } } } },
        personCommands: true,
    };
}

function harness() {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (sessionId === "missing" ? null : {
            rootSessionId: sessionId, isSystem: false, visibility: sessionId === "shared" ? "shared_read" : "private",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        listChatWorkflowDefinitions: async (sessionId, options) => { calls.push(["list", sessionId, options]); return [{ definitionId: "def-hn", name: "hn-top-watch" }]; },
        readChatWorkflowDefinition: async (sessionId, ref) => { calls.push(["read", sessionId, ref]); return readOf(sessionId); },
        saveChatWorkflowDefinition: async (sessionId, request, options) => { calls.push(["save", sessionId, request, options]); return { operation: "save", revision: 3 }; },
        startChatWorkflowDefinition: async (sessionId, request, options) => { calls.push(["start", sessionId, request, options]); return { operation: "start", workflowId: "wf-new" }; },
        deleteChatWorkflowDefinition: async (sessionId, request, options) => { calls.push(["delete", sessionId, request, options]); return { operation: "delete" }; },
    };
    return { runtime, calls };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject, displayName: subject === "alice" ? "Alice" : null }, authorization: { role } });

async function serve(runtime) {
    const requireAuth = (req, _res, next) => {
        const subject = String(req.headers["x-test-user"] || "alice");
        req.auth = { principal: { provider: "dev", subject, displayName: subject === "alice" ? "Alice" : null },
            authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = (subject) => new HttpApiTransport({ api: new ApiClient({ apiUrl: origin,
        fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } }) }) });
    return { server, transport, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Stage 2 review S2SF-F1: an agent state's inline prompt on the chat definition's graph is for whoever may change it, as
// its YAML is; a reader of the chat gets the state's description and no prompt. Synthetic marker only.
const PROMPT_MARKER = "prompt-marker-s2sf-f1-chat-5b7e";
function promptReadOf(sessionId) {
    const read = readOf(sessionId);
    return { ...read, graph: { ...read.graph, states: [
        { id: "ask", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["done"], next: { done: "end" },
            about: { description: "Summarizes the build.", prompt: `Use the token ${PROMPT_MARKER} to read the build.` } },
        { id: "solo", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["done"], next: { done: "end" },
            about: { prompt: `Only a prompt: ${PROMPT_MARKER}` } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] } };
}

test("S2SF-F1: a reader of the chat gets no agent state's inline prompt on the definition's graph (runtime and GET); the owner gets it", async () => {
    const { runtime } = harness();
    runtime.transport.readChatWorkflowDefinition = async (sessionId) => promptReadOf(sessionId);
    const owned = await runtime.call("readChatWorkflowDefinition", { sessionId: "shared", definitionId: "def-hn", revision: 2 }, as("alice"));
    assert.deepEqual(owned.graph, promptReadOf("shared").graph);
    const served = await serve(runtime);
    try {
        const reads = [
            await runtime.call("readChatWorkflowDefinition", { sessionId: "shared", definitionId: "def-hn", revision: 2 }, as("bob")),
            await served.transport("bob").readChatWorkflowDefinition("shared", { definitionId: "def-hn", revision: 2 }),
        ];
        assert.ok(JSON.stringify(await served.transport("alice").readChatWorkflowDefinition("shared", { definitionId: "def-hn", revision: 2 })).includes(PROMPT_MARKER));
        for (const read of reads) {
            assert.equal(JSON.stringify(read).includes(PROMPT_MARKER), false, JSON.stringify(read));
            const byId = Object.fromEntries(read.graph.states.map((state) => [state.id, state]));
            assert.deepEqual(byId.ask.about, { description: "Summarizes the build." });
            assert.equal("about" in byId.solo, false);
            assert.equal(read.viewer.allowed, false);
        }
    } finally {
        await served.close();
    }
});

test("a revision's read says who may change it: the owner gets its YAML and graph, a reader gets neither YAML nor the author's words", async () => {
    const { runtime } = harness();
    const owned = await runtime.call("readChatWorkflowDefinition", { sessionId: "shared", definitionId: "def-hn", revision: 2 }, as("alice"));
    assert.deepEqual(owned, { ...readOf("shared"), viewer: { allowed: true, reason: null } });
    const read = await runtime.call("readChatWorkflowDefinition", { sessionId: "shared", definitionId: "def-hn", revision: 2 }, as("bob"));
    assert.equal(JSON.stringify(read).includes(SENTINEL), false, JSON.stringify(read));
    assert.equal("yaml" in read.revision, false);
    assert.equal(read.viewer.allowed, false);
    assert.equal(typeof read.viewer.reason, "string");
    assert.deepEqual(read.revision.diagnostics, [{ severity: "error", code: "WORKFLOW_SCHEMA_INVALID",
        message: "This version has an error. People who can change this workflow see where and why." }]);
    assert.deepEqual(read.graph.inputsSchema, { type: "object", required: ["topic"], properties: { topic: { type: "string", minLength: 2 } } });
    assert.equal(read.personCommands, true);
    // Someone who cannot see the chat, and a chat that does not exist: not found, nothing read.
    for (const [sessionId, subject] of [["s1", "bob"], ["missing", "alice"]]) {
        await assert.rejects(runtime.call("readChatWorkflowDefinition", { sessionId, definitionId: "def-hn" }, as(subject)),
            (error) => error.status === 404 && error.code === "NOT_FOUND");
    }
});

test("the browser transport's five chat-definition methods reach the route: reads for a reader, changes only for the owner, as the caller", async () => {
    const { runtime, calls } = harness();
    const { transport, close } = await serve(runtime);
    try {
        const alice = transport("alice");
        const bob = transport("bob");
        assert.deepEqual(await alice.listChatWorkflowDefinitions("shared", { includeDeleted: true }), [{ definitionId: "def-hn", name: "hn-top-watch" }]);
        assert.deepEqual(calls.at(-1), ["list", "shared", { includeDeleted: true }]);
        await bob.listChatWorkflowDefinitions("shared");
        assert.deepEqual(calls.at(-1), ["list", "shared", { includeDeleted: false }]);
        const ownerRead = await alice.readChatWorkflowDefinition("shared", { definitionId: "def-hn", revision: 2 });
        assert.equal(ownerRead.revision.yaml.includes(SENTINEL), true);
        assert.deepEqual(calls.at(-1), ["read", "shared", { definitionId: "def-hn", name: null, revision: 2 }]);
        const readerRead = await bob.readChatWorkflowDefinition("shared", { definitionId: "def-hn", revision: 2 });
        assert.equal(JSON.stringify(readerRead).includes(SENTINEL), false);
        assert.equal(readerRead.viewer.allowed, false);

        const saved = await alice.saveChatWorkflowDefinition("shared", { definitionId: "def-hn", name: "hn-top-watch", yaml: "y", expectedRevision: 2, operationId: "op-1" });
        assert.deepEqual(saved, { operation: "save", revision: 3 });
        const [, , request, options] = calls.at(-1);
        assert.deepEqual(request, { name: "hn-top-watch", yaml: "y", definitionId: "def-hn", expectedRevision: 2, operationId: "op-1" });
        assert.deepEqual(options.principal, { provider: "dev", subject: "alice", displayName: "Alice" });
        const started = await alice.startChatWorkflowDefinition("shared", { definitionId: "def-hn", runAgainOf: "wf-a", inputs: { topic: "ai" }, operationId: "op-2" });
        assert.equal(started.workflowId, "wf-new");
        assert.deepEqual(calls.at(-1).slice(2), [{ definitionId: "def-hn", revision: null, runAgainOf: "wf-a", inputs: { topic: "ai" }, vars: null, notifyParent: true,
            operationId: "op-2" }, { principal: { provider: "dev", subject: "alice" } }]);
        await alice.deleteChatWorkflowDefinition("shared", { definitionId: "def-hn", operationId: "op-3" });
        assert.deepEqual(calls.at(-1).slice(2, 3), [{ definitionId: "def-hn", operationId: "op-3" }]);

        // A reader of the chat cannot change its definitions: refused before anything is sent.
        const before = calls.length;
        for (const send of [
            () => bob.saveChatWorkflowDefinition("shared", { definitionId: "def-hn", name: "hn-top-watch", yaml: "y", expectedRevision: 2, operationId: "op-4" }),
            () => bob.startChatWorkflowDefinition("shared", { definitionId: "def-hn", operationId: "op-5" }),
            () => bob.deleteChatWorkflowDefinition("shared", { definitionId: "def-hn", operationId: "op-6" }),
        ]) {
            await assert.rejects(send(), (error) => error.status === 403 || error.status === 404);
        }
        assert.equal(calls.length, before);
    } finally {
        await close();
    }
});

// UX2D-F1: a stale save's refusal through the real answer: the management client's failure, the route's error body (HTTP
// status and JSON), the browser transport and the Workflow tab's words. Its details (who saved, when) reach the page, so
// it says the time in the person's own clock and offers Reload; before, the details were dropped (no exposeDetails) and the
// page showed the server's sentence with its UTC time and no Reload.
test("UX2D-F1: a stale save's refusal reaches the page with who saved and when, so it shows the local time and Reload", async () => {
    const { runtime } = harness();
    const savedAt = "2026-11-07T16:19:29.223Z";
    const refusal = new WorkflowStoreError("REVISION_STALE",
        `Revision 6 was saved by Alice Anderson at ${savedAt}. Reload to edit it. Nothing was saved.`,
        { definitionId: "def-hn", currentRevision: 6, expectedRevision: 5, savedBy: { kind: "user", provider: "dev", subject: "alice", display: "Alice Anderson" },
            savedAt });
    runtime.transport.saveChatWorkflowDefinition = async () => { throw PilotSwarmManagementClient.prototype._definitionFailure.call({}, refusal); };
    const { transport, close } = await serve(runtime);
    try {
        let caught = null;
        try {
            await transport("alice").saveChatWorkflowDefinition("shared", { definitionId: "def-hn", name: "hn-top-watch", yaml: "y", expectedRevision: 5, operationId: "op-s" });
        } catch (error) { caught = error; }
        assert.equal(caught?.status, 409);
        assert.equal(caught?.code, "REVISION_STALE");
        assert.deepEqual(caught?.details, { definitionId: "def-hn", currentRevision: 6, expectedRevision: 5,
            savedBy: { kind: "user", provider: "dev", subject: "alice", display: "Alice Anderson" }, savedAt });
        const words = chatDefinitionFailure(caught, { timeOf: value => (value === savedAt ? "8:19 AM" : null) });
        assert.equal(words.stale, 6, "Reload is offered");
        assert.equal(words.message, "Revision not saved: revision 6 was saved by Alice Anderson at 8:19 AM. Reload to edit it.");
        assert.ok(!words.message.includes("2026-11-07T"));
    } finally {
        await close();
    }
});
