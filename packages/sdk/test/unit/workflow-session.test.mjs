import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";

test("createWorkflowSession persists a non-conversational child and returns its durable result", async () => {
    const writes = [];
    const starts = [];
    const updates = [];
    const completedAt = new Date("2026-10-02T13:00:00.000Z");
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async (id, name, input, version) => {
            starts.push({ id, name, input, version });
        },
    };
    client._catalog = {
        createSession: async (sessionId, options) => writes.push({ sessionId, options }),
        updateSession: async (sessionId, update) => updates.push({ sessionId, update }),
        getChildOutcome: async childSessionId => ({
            childSessionId,
            parentSessionId: "parent-1",
            contractJson: null,
            resultJson: {
                outcome: "succeeded",
                summary: "Workflow finished.",
                result: { artifact: "report.json" },
                metadata: { revision: 1 },
            },
            verdict: "success",
            summary: "Workflow finished.",
            completedAt,
            createdAt: completedAt,
            updatedAt: completedAt,
        }),
    };

    const workflow = await client.createWorkflowSession({
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        definition: { kind: "registered", definitionId: "definition-1" },
        inputs: { target: "staging" },
    });

    assert.deepEqual(writes, [{
        sessionId: "workflow-1",
        options: {
            sessionKind: "workflow",
            parentSessionId: "parent-1",
            owner: null,
            groupId: null,
            visibility: null,
            creationConfig: {
                workflow: {
                    definition: { kind: "registered", definitionId: "definition-1" },
                    inputs: { target: "staging" },
                },
            },
        },
    }]);
    assert.deepEqual(starts, [{
        id: "session-workflow-1",
        name: "workflow-session-v1",
        input: {
            sessionId: "workflow-1",
            parentSessionId: "parent-1",
            definition: { kind: "registered", definitionId: "definition-1" },
            inputs: { target: "staging" },
        },
        version: "1.0.0",
    }]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionId, "workflow-1");
    assert.equal(updates[0].update.orchestrationId, "session-workflow-1");
    assert.equal(updates[0].update.state, "running");
    assert.ok(updates[0].update.lastActiveAt instanceof Date);
    assert.equal("send" in workflow, false, "workflow handles must not expose chat methods");
    assert.deepEqual(await workflow.waitForResult(), {
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        outcome: "succeeded",
        summary: "Workflow finished.",
        result: { artifact: "report.json" },
        completedAt: completedAt.toISOString(),
        metadata: { revision: 1 },
    });
});

test("root workflow sessions do not pretend to return a child result", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {},
    };
    client._catalog = {
        createSession: async () => {},
        updateSession: async () => {},
        getChildOutcome: async () => null,
    };
    const workflow = await client.createWorkflowSession({
        sessionId: "workflow-root",
        definition: { kind: "package", packageName: "ops", workflowName: "report", version: "1.0.0" },
    });

    await assert.rejects(
        workflow.waitForResult(),
        error => error?.code === "WORKFLOW_RESULT_PARENT_REQUIRED",
    );
});

test("workflow sessions cannot be resumed as LLM conversations", async () => {
    const client = new PilotSwarmClient({});
    client._catalog = {
        getSession: async () => ({ sessionId: "workflow-1", sessionKind: "workflow", state: "pending" }),
    };

    await assert.rejects(
        client.resumeSession("workflow-1"),
        error => error?.code === "WORKFLOW_SESSION_NOT_CONVERSATIONAL",
    );
});
