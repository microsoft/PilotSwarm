import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectActiveChat,
} from "../src/index.js";

test("workflow sessions show sanitized topology and execution status instead of chat", () => {
    const session = {
        sessionId: "workflow-1",
        sessionKind: "workflow",
        title: "Release workflow",
        createdAt: 1,
        updatedAt: 2,
    };
    const messages = selectActiveChat({
        branding: { title: "PilotSwarm" },
        sessions: {
            activeSessionId: session.sessionId,
            byId: { [session.sessionId]: session },
        },
        history: { bySessionId: new Map() },
        workflowOverview: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: {
                        workflowSessionId: session.sessionId,
                        graph: {
                            graphId: "example@1",
                            initialStateId: "prepare",
                            nodes: [
                                { id: "prepare", type: "agent" },
                                { id: "review", type: "question" },
                                { id: "done", type: "terminal" },
                            ],
                            edges: [
                                { from: "prepare", to: "review" },
                                { from: "review", to: "done" },
                            ],
                        },
                        projection: {
                            status: "running",
                            currentStateId: "review",
                            currentExecutionSequence: 2,
                            waitingOn: "question",
                        },
                        executions: [
                            {
                                executionSequence: 1,
                                stateId: "prepare",
                                status: "accepted",
                                waitingOn: "agent-result",
                            },
                            {
                                executionSequence: 2,
                                stateId: "review",
                                status: "admitted",
                                waitingOn: "question",
                            },
                        ],
                    },
                },
            },
        },
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /workflow controller, not an LLM conversation/);
    assert.match(messages[0].text, /```mermaid\nflowchart TD/);
    assert.match(messages[0].text, /n0 --> n1/);
    assert.match(messages[0].text, /review · question \(current\)/);
    assert.match(messages[0].text, /\| prepare \(initial\) \| agent \| review \| accepted \|/);
    assert.match(messages[0].text, /\| review \| question \| done \| current \(question\) \|/);
    assert.match(messages[0].text, /## Execution history/);
    assert.doesNotMatch(messages[0].text, /prompt|configuration|output/i);
    assert.doesNotMatch(messages[0].text, /Start interacting/);
});

test("workflow overview loading stores only the server-provided sanitized view", async () => {
    const overview = {
        workflowSessionId: "workflow-1",
        graph: {
            graphId: "example@1",
            initialStateId: "start",
            nodes: [{ id: "start", type: "action" }],
            edges: [],
        },
        projection: null,
        executions: [],
    };
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Example" },
    });
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async getWorkflowOverview(sessionId) {
                assert.equal(sessionId, "workflow-1");
                return overview;
            },
        },
    });

    assert.equal(await controller.ensureWorkflowOverview("workflow-1"), overview);
    assert.deepEqual(store.getState().workflowOverview.bySessionId["workflow-1"], {
        loadState: "loaded",
        data: overview,
        error: null,
        loadedAt: store.getState().workflowOverview.bySessionId["workflow-1"].loadedAt,
    });
});

test("a missing authorized workflow overview does not remain in a loading state", () => {
    const session = { sessionId: "workflow-missing", sessionKind: "workflow", title: "Missing" };
    const [message] = selectActiveChat({
        branding: { title: "PilotSwarm" },
        sessions: {
            activeSessionId: session.sessionId,
            byId: { [session.sessionId]: session },
        },
        history: { bySessionId: new Map() },
        workflowOverview: {
            bySessionId: {
                [session.sessionId]: { loadState: "loaded", data: null, error: null },
            },
        },
    });

    assert.match(message.text, /topology was not found/i);
    assert.doesNotMatch(message.text, /Loading workflow topology/);
});
