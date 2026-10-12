import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectActiveChat,
    selectChatLines,
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
    assert.doesNotMatch(messages[0].text, /workflow controller, not an LLM conversation/);
    assert.match(messages[0].text, /```mermaid\nflowchart TD/);
    assert.match(messages[0].text, /n0 --> n1/);
    assert.match(messages[0].text, /review · question \(current\)/);
    assert.match(messages[0].text, /\| prepare \(initial\) \| agent \| review \| accepted \|/);
    assert.match(messages[0].text, /\| review \| question \| done \| current \(question\) \|/);
    assert.match(messages[0].text, /## Execution progression/);
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

test("workflow sessions show authorized state execution details and inferred transitions", () => {
    const workflow = {
        sessionId: "workflow-detail",
        sessionKind: "workflow",
        title: "Arithmetic workflow",
        createdAt: 1,
        updatedAt: 2,
    };
    const child = {
        sessionId: "child-b",
        parentSessionId: workflow.sessionId,
        title: "Independent solver",
    };
    const childHistory = new Map([[
        child.sessionId,
        {
            loadState: "loaded",
            chat: [
                { id: "prompt", role: "user", text: "Solve 57 + 18." },
                {
                    id: "tool",
                    kind: "chat-call",
                    role: "tool",
                    name: "calculator",
                    category: "Tool",
                    text: "57 + 18",
                    arguments: { expression: "57 + 18" },
                    result: { value: 75 },
                    status: "Done",
                },
                { id: "answer", role: "assistant", text: "The result is 75." },
            ],
            events: [],
        },
    ]]);
    const state = {
        branding: { title: "PilotSwarm" },
        sessions: {
            activeSessionId: workflow.sessionId,
            byId: {
                [workflow.sessionId]: workflow,
                "child-a": {
                    sessionId: "child-a",
                    parentSessionId: workflow.sessionId,
                    title: "Preparer",
                },
                [child.sessionId]: child,
            },
        },
        history: { bySessionId: childHistory },
        executionHistory: {
            bySessionId: {
                [workflow.sessionId]: {
                    events: [
                        {
                            eventId: 10,
                            kind: "ActivityScheduled",
                            timestampMs: 1000,
                            data: JSON.stringify({
                                name: "executeWorkflowTransitionV2",
                                input: {
                                    context: {
                                        executionHistory: [{ executionSequence: 1 }],
                                    },
                                },
                            }),
                        },
                        {
                            eventId: 11,
                            sourceEventId: 10,
                            kind: "ActivityCompleted",
                            timestampMs: 1025,
                            data: JSON.stringify({ kind: "advance", target: "b" }),
                        },
                        {
                            eventId: 20,
                            kind: "ActivityScheduled",
                            timestampMs: 2000,
                            data: JSON.stringify({
                                name: "executeWorkflowTransitionV2",
                                input: {
                                    context: {
                                        executionHistory: [
                                            { executionSequence: 1 },
                                            { executionSequence: 2 },
                                        ],
                                    },
                                },
                            }),
                        },
                    ],
                },
                [child.sessionId]: {
                    events: [
                        {
                            kind: "ActivityScheduled",
                            data: JSON.stringify({
                                name: "unrelatedActivity",
                                input: { prompt: "This is not the agent task." },
                            }),
                        },
                        {
                            kind: "ActivityScheduled",
                            data: JSON.stringify({
                                name: "runTurnV3",
                                input: { prompt: "Execute workflow state B with 57 + 18." },
                            }),
                        },
                    ],
                },
            },
        },
        workflowOverview: {
            bySessionId: {
                [workflow.sessionId]: {
                    loadState: "loaded",
                    data: {
                        graph: {
                            graphId: "arithmetic@1",
                            initialStateId: "a",
                            nodes: [
                                { id: "a", type: "agent" },
                                { id: "b", type: "agent" },
                                { id: "done", type: "terminal" },
                            ],
                            edges: [
                                { from: "a", to: "b" },
                                { from: "b", to: "done" },
                            ],
                        },
                        projection: {
                            status: "running",
                            currentStateId: "b",
                            currentExecutionSequence: 2,
                            waitingOn: "agent-result",
                        },
                        executions: [
                            { executionSequence: 1, stateId: "a", status: "accepted", waitingOn: "agent-result" },
                            { executionSequence: 2, stateId: "b", status: "accepted", waitingOn: "agent-result" },
                        ],
                    },
                },
            },
        },
        workflowExecutions: {
            bySessionId: {
                [workflow.sessionId]: {
                    loadState: "loaded",
                    data: [
                        {
                            executionSequence: 1,
                            stateId: "a",
                            childSessionId: "child-a",
                            waitingOn: "agent-result",
                            status: "accepted",
                            outcome: "prepared",
                            output: { expression: "57 + 18" },
                            admittedAt: "2026-10-11T21:30:16.235Z",
                            acceptedAt: "2026-10-11T21:30:23.763Z",
                        },
                        {
                            executionSequence: 2,
                            stateId: "b",
                            childSessionId: child.sessionId,
                            waitingOn: "agent-result",
                            status: "accepted",
                            outcome: "solved",
                            output: { result: 75 },
                            admittedAt: "2026-10-11T21:30:24.301Z",
                            acceptedAt: "2026-10-11T21:30:34.084Z",
                        },
                    ],
                },
            },
        },
    };
    const [message] = selectActiveChat(state);

    assert.match(message.text, /## Node action details/);
    assert.deepEqual(message.workflowSections.map(section => section.title), [
        "Workflow definition",
        "Execution progression",
        "Node action details (2)",
    ]);
    assert.deepEqual(message.workflowSections.map(section => section.defaultOpen), [false, true, true]);
    const nodeSections = message.workflowSections[2].sections;
    assert.equal(nodeSections.length, 2);
    assert.equal(nodeSections[0].defaultOpen, false);
    assert.equal(nodeSections[1].defaultOpen, true);
    assert.match(nodeSections[0].title, /a · #1 · prepared → b/);
    assert.match(nodeSections[1].title, /b · #2 · solved/);
    assert.match(message.text, /\*\*State:\*\* b/);
    assert.match(message.text, /### Agent prompt[\s\S]*Execute workflow state B with 57 \+ 18\./);
    assert.doesNotMatch(message.text, /This is not the agent task/);
    assert.match(message.text, /### Agent transcript[\s\S]*The result is 75\./);
    assert.match(message.text, /### Submitted workflow result[\s\S]*\*\*Outcome:\*\* solved/);
    assert.match(message.text, /"result": 75/);
    assert.match(message.text, /### Transition function[\s\S]*Transition execution has not completed yet/i);
    assert.match(message.text, /\*\*Action admitted:\*\* `(?:11 Oct )?\d{2}:\d{2}:\d{2}`/);
    assert.match(message.text, /\*\*Invoked:\*\* `\d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2}`/);
    assert.match(message.text, /\*\*Completed:\*\* `\d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2}`/);
    assert.match(message.text, /\*\*Duration:\*\* 25 ms/);
    const sentinelLines = selectChatLines(state, 120, { tableMode: "sentinel" });
    const sectionStarts = sentinelLines.filter(line => line?.kind === "workflowSectionStart");
    assert.equal(sectionStarts.length, 5);
    assert.deepEqual(sectionStarts.map(line => line.defaultOpen), [false, true, true, false, true]);
    assert.ok(sentinelLines.some(line => line?.kind === "chatCall" && /calculator/.test(line.text)));

    state.sessions.activeSessionId = child.sessionId;
    const childMessages = selectActiveChat(state);
    assert.equal(childMessages[0].kind, "workflow-child-context");
    assert.match(childMessages[0].workflowSections[0].title, /Workflow execution context · b · #2/);
    assert.match(childMessages[0].text, /\*\*Parent workflow:\*\* Arithmetic workflow/);
    assert.match(childMessages[0].text, /### Agent prompt[\s\S]*Execute workflow state B with 57 \+ 18\./);
    assert.doesNotMatch(childMessages[0].text, /This is not the agent task/);
    assert.match(childMessages[0].text, /### Agent transcript[\s\S]*The result is 75\./);
    assert.match(childMessages[0].text, /\*\*Outcome:\*\* solved/);
    assert.match(childMessages[0].text, /"result": 75/);
    assert.equal(childMessages.length, 1);
    const childActivityMessages = childMessages[0].workflowSections[0].content
        .filter(part => part.type === "messages")
        .flatMap(part => part.messages);
    assert.deepEqual(childActivityMessages.map(message => message.id), [
        "workflow-child-prompt:child-b:2",
        "tool",
        "answer",
    ]);
    const childSentinelLines = selectChatLines(state, 120, { tableMode: "sentinel" });
    assert.ok(childSentinelLines.some(line => line?.kind === "chatCall" && /calculator/.test(line.text)));
});

test("workflow child selection loads its parent execution context", async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Workflow" },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "child-1", parentSessionId: "workflow-1", title: "Action" },
    });
    const calls = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async getWorkflowOverview(sessionId) {
                calls.push(["overview", sessionId]);
                return { graph: { nodes: [], edges: [] }, projection: null, executions: [] };
            },
            async listWorkflowExecutions(sessionId) {
                calls.push(["executions", sessionId]);
                return [{ executionSequence: 1, stateId: "A", childSessionId: "child-1" }];
            },
            async getExecutionHistory(sessionId) {
                calls.push(["history", sessionId]);
                return [];
            },
        },
    });

    const context = await controller.ensureWorkflowContextForSession("child-1", { force: true });
    assert.equal(context.workflowSessionId, "workflow-1");
    assert.deepEqual(calls, [
        ["overview", "workflow-1"],
        ["executions", "workflow-1"],
        ["history", "workflow-1"],
        ["history", "child-1"],
    ]);
});

test("parent workflow context does not wait for every child transcript", async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Workflow" },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "child-1", parentSessionId: "workflow-1", title: "Action" },
    });
    let releaseChildEvents;
    const childEvents = new Promise(resolve => {
        releaseChildEvents = resolve;
    });
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async getWorkflowOverview() {
                return { graph: { nodes: [], edges: [] }, projection: null, executions: [] };
            },
            async listWorkflowExecutions() {
                return [{ executionSequence: 1, stateId: "work", childSessionId: "child-1" }];
            },
            async getExecutionHistory() {
                return [];
            },
            async getSessionEvents(sessionId) {
                assert.equal(sessionId, "child-1");
                return childEvents;
            },
        },
    });

    const contextLoaded = controller.ensureWorkflowContextForSession("workflow-1", { force: true })
        .then(() => true);
    assert.equal(await Promise.race([
        contextLoaded,
        new Promise(resolve => setTimeout(() => resolve(false), 50)),
    ]), true);

    releaseChildEvents([]);
    await new Promise(resolve => setTimeout(resolve, 0));
});

test("workflow child context remains visible while cached workflow data refreshes", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: {
            sessionId: "workflow-1",
            sessionKind: "workflow",
            title: "Workflow",
        },
    });
    store.dispatch({
        type: "sessions/merged",
        session: {
            sessionId: "child-1",
            parentSessionId: "workflow-1",
            title: "Action",
        },
    });
    store.dispatch({
        type: "workflowOverview/loaded",
        sessionId: "workflow-1",
        overview: {
            graph: { nodes: [{ id: "A", type: "agent" }], edges: [] },
            projection: { currentExecutionSequence: 1, currentStateId: "A" },
        },
    });
    store.dispatch({
        type: "workflowExecutions/loaded",
        sessionId: "workflow-1",
        executions: [{
            executionSequence: 1,
            stateId: "A",
            childSessionId: "child-1",
            status: "completed",
            outcome: "done",
        }],
    });
    store.dispatch({ type: "sessions/selected", sessionId: "child-1" });

    const beforeRefresh = selectActiveChat(store.getState())[0];
    assert.equal(beforeRefresh.kind, "workflow-child-context");
    assert.match(beforeRefresh.workflowSections[0].title, /A · #1/);

    store.dispatch({
        type: "workflowOverview/loading",
        sessionId: "workflow-1",
        preserveData: true,
    });
    store.dispatch({
        type: "workflowExecutions/loading",
        sessionId: "workflow-1",
        preserveData: true,
    });

    const refreshingState = store.getState();
    assert.equal(refreshingState.workflowOverview.bySessionId["workflow-1"].loadState, "loaded");
    assert.equal(refreshingState.workflowExecutions.bySessionId["workflow-1"].loadState, "loaded");
    assert.equal(refreshingState.workflowOverview.bySessionId["workflow-1"].refreshing, true);
    assert.equal(refreshingState.workflowExecutions.bySessionId["workflow-1"].refreshing, true);

    const duringRefresh = selectActiveChat(refreshingState)[0];
    assert.equal(duringRefresh.kind, "workflow-child-context");
    assert.match(duringRefresh.workflowSections[0].title, /A · #1/);
    assert.doesNotMatch(duringRefresh.text, /Loading workflow execution context/);

    store.dispatch({
        type: "workflowOverview/failed",
        sessionId: "workflow-1",
        error: "refresh failed",
    });
    store.dispatch({
        type: "workflowExecutions/failed",
        sessionId: "workflow-1",
        error: "refresh failed",
    });

    const afterFailedRefresh = selectActiveChat(store.getState())[0];
    assert.equal(afterFailedRefresh.kind, "workflow-child-context");
    assert.match(afterFailedRefresh.workflowSections[0].title, /A · #1/);
    assert.equal(store.getState().workflowOverview.bySessionId["workflow-1"].loadState, "loaded");
    assert.equal(store.getState().workflowExecutions.bySessionId["workflow-1"].loadState, "loaded");
});

test("workflow execution loading uses full execution data and independently loads every child history", async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Example" },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "child-1", parentSessionId: "workflow-1", title: "Agent" },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "child-2", parentSessionId: "workflow-1", title: "Agent 2" },
    });
    store.dispatch({
        type: "workflowOverview/loaded",
        sessionId: "workflow-1",
        overview: {
            projection: { currentExecutionSequence: 1 },
            graph: { nodes: [], edges: [] },
            executions: [],
        },
    });
    const historySessionIds = [];
    const executionHistorySessionIds = [];
    const executions = [
        {
            executionSequence: 1,
            stateId: "prepare",
            childSessionId: "child-1",
            status: "accepted",
            waitingOn: "agent-result",
            outcome: "prepared",
            output: {},
        },
        {
            executionSequence: 2,
            stateId: "solve",
            childSessionId: "child-2",
            status: "admitted",
            waitingOn: "agent-result",
            outcome: null,
            output: null,
        },
    ];
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async listWorkflowExecutions(sessionId) {
                assert.equal(sessionId, "workflow-1");
                return executions;
            },
            async getSessionEvents(sessionId) {
                historySessionIds.push(sessionId);
                return [];
            },
            async getExecutionHistory(sessionId) {
                executionHistorySessionIds.push(sessionId);
                return [];
            },
        },
    });

    assert.equal(await controller.ensureWorkflowExecutions("workflow-1"), executions);
    await controller.ensureWorkflowChildHistories("workflow-1");
    assert.deepEqual(historySessionIds.sort(), ["child-1", "child-2"]);
    assert.deepEqual(executionHistorySessionIds.sort(), ["child-1", "child-2"]);
    assert.deepEqual(store.getState().workflowExecutions.bySessionId["workflow-1"].data, executions);
});

test("workflow child history loading bounds request fan-out", async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Example" },
    });
    const executions = Array.from({ length: 10 }, (_, index) => {
        const childSessionId = `child-${index + 1}`;
        store.dispatch({
            type: "sessions/merged",
            session: { sessionId: childSessionId, parentSessionId: "workflow-1", title: childSessionId },
        });
        return {
            executionSequence: index + 1,
            stateId: `state-${index + 1}`,
            childSessionId,
            status: "accepted",
        };
    });
    store.dispatch({
        type: "workflowExecutions/loaded",
        sessionId: "workflow-1",
        executions,
    });

    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async getSessionEvents() {
                activeLoads += 1;
                maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
                await new Promise(resolve => setTimeout(resolve, 5));
                activeLoads -= 1;
                return [];
            },
            async getExecutionHistory() {
                return [];
            },
        },
    });

    await controller.ensureWorkflowChildHistories("workflow-1");

    assert.equal(maximumActiveLoads, 6);
});

test("workflow child transcript authorization failure leaves execution content unavailable", async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "workflow-1", sessionKind: "workflow", title: "Example" },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "child-hidden", parentSessionId: "workflow-1", title: "Hidden child" },
    });
    store.dispatch({
        type: "workflowOverview/loaded",
        sessionId: "workflow-1",
        overview: {
            projection: { currentExecutionSequence: 1 },
            graph: { nodes: [], edges: [] },
            executions: [],
        },
    });
    store.dispatch({
        type: "workflowExecutions/loaded",
        sessionId: "workflow-1",
        executions: [{
            executionSequence: 1,
            stateId: "prepare",
            childSessionId: "child-hidden",
            status: "admitted",
            waitingOn: "agent-result",
            outcome: null,
            output: null,
        }],
    });
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async getSessionEvents(sessionId) {
                assert.equal(sessionId, "child-hidden");
                const error = new Error("Not found");
                error.status = 404;
                throw error;
            },
        },
    });

    await controller.ensureWorkflowChildHistories("workflow-1");
    assert.equal(store.getState().sessions.byId["child-hidden"], undefined);
    assert.equal(store.getState().history.bySessionId.has("child-hidden"), false);
});

test("a terminal projection identifies the transition-selected terminal state", () => {
    const session = {
        sessionId: "workflow-terminal",
        sessionKind: "workflow",
        title: "Terminal workflow",
    };
    const [message] = selectActiveChat({
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
                        graph: {
                            graphId: "terminal@1",
                            initialStateId: "work",
                            nodes: [
                                { id: "work", type: "action" },
                                { id: "done", type: "terminal" },
                            ],
                            edges: [{ from: "work", to: "done" }],
                        },
                        projection: {
                            status: "succeeded",
                            currentStateId: "done",
                            currentExecutionSequence: 1,
                            waitingOn: null,
                        },
                        executions: [{
                            executionSequence: 1,
                            stateId: "work",
                            status: "accepted",
                            waitingOn: "activity",
                        }],
                    },
                },
            },
        },
        workflowExecutions: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: [{
                        executionSequence: 1,
                        stateId: "work",
                        childSessionId: null,
                        waitingOn: "activity",
                        status: "accepted",
                        outcome: "complete",
                        output: { result: 75 },
                    }],
                },
            },
        },
    });

    assert.match(message.text, /### Transition function[\s\S]*\*\*Selected next state:\*\* done/);
    assert.match(message.workflowSections[2].sections[0].title, /work · #1 · complete → done/);
    assert.equal(message.workflowSections[2].sections[0].defaultOpen, true);
    assert.match(message.workflowSections[2].sections[0].text, /does not use a child agent session/);
    assert.doesNotMatch(message.workflowSections[2].sections[0].text, /### Agent prompt/);
});

test("repeated visits to the same state remain distinct execution sections", () => {
    const session = {
        sessionId: "workflow-retry",
        sessionKind: "workflow",
        title: "Retry workflow",
    };
    const [message] = selectActiveChat({
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
                        graph: {
                            graphId: "retry@1",
                            initialStateId: "check",
                            nodes: [
                                { id: "check", type: "observed-condition" },
                                { id: "done", type: "terminal" },
                            ],
                            edges: [
                                { from: "check", to: "check" },
                                { from: "check", to: "done" },
                            ],
                        },
                        projection: {
                            status: "running",
                            currentStateId: "check",
                            currentExecutionSequence: 2,
                            waitingOn: "observation",
                        },
                        executions: [],
                    },
                },
            },
        },
        workflowExecutions: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: [
                        {
                            executionSequence: 1,
                            stateId: "check",
                            childSessionId: null,
                            status: "accepted",
                            outcome: "retry",
                            output: { ready: false },
                        },
                        {
                            executionSequence: 2,
                            stateId: "check",
                            childSessionId: null,
                            status: "admitted",
                            outcome: null,
                            output: null,
                        },
                    ],
                },
            },
        },
    });

    const actions = message.workflowSections[2].sections;
    assert.equal(actions.length, 2);
    assert.match(actions[0].title, /check · #1 · retry → check/);
    assert.match(actions[1].title, /check · #2 · admitted/);
    assert.equal(actions[0].defaultOpen, false);
    assert.equal(actions[1].defaultOpen, true);
});

test("a stale projection does not invent a transition target for an older execution list", () => {
    const session = {
        sessionId: "workflow-stale",
        sessionKind: "workflow",
        title: "Stale workflow",
    };
    const [message] = selectActiveChat({
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
                        graph: {
                            graphId: "stale@1",
                            initialStateId: "first",
                            nodes: [
                                { id: "first", type: "agent" },
                                { id: "second", type: "agent" },
                                { id: "done", type: "terminal" },
                            ],
                            edges: [
                                { from: "first", to: "second" },
                                { from: "second", to: "done" },
                            ],
                        },
                        projection: {
                            status: "succeeded",
                            currentStateId: "done",
                            currentExecutionSequence: 2,
                            waitingOn: null,
                        },
                        executions: [],
                    },
                },
            },
        },
        workflowExecutions: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: [{
                        executionSequence: 1,
                        stateId: "first",
                        childSessionId: null,
                        status: "accepted",
                        outcome: "complete",
                        output: {},
                    }],
                },
            },
        },
    });

    const action = message.workflowSections[2].sections[0];
    assert.doesNotMatch(action.title, /→ done/);
    assert.doesNotMatch(action.text, /Selected next state:\*\* done/);
});

test("loaded history without a matching transition reports unavailable timing", () => {
    const session = {
        sessionId: "workflow-no-transition-history",
        sessionKind: "workflow",
        title: "Workflow",
    };
    const [message] = selectActiveChat({
        branding: { title: "PilotSwarm" },
        sessions: {
            activeSessionId: session.sessionId,
            byId: { [session.sessionId]: session },
        },
        history: { bySessionId: new Map() },
        executionHistory: {
            bySessionId: {
                [session.sessionId]: {
                    loading: false,
                    error: null,
                    fetchedAt: 123,
                    events: [],
                },
            },
        },
        workflowOverview: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: {
                        graph: {
                            graphId: "example@1",
                            initialStateId: "first",
                            nodes: [
                                { id: "first", type: "agent" },
                                { id: "second", type: "agent" },
                            ],
                            edges: [{ from: "first", to: "second" }],
                        },
                        projection: {
                            status: "running",
                            currentStateId: "second",
                            currentExecutionSequence: 2,
                            waitingOn: "agent-result",
                        },
                        executions: [],
                    },
                },
            },
        },
        workflowExecutions: {
            bySessionId: {
                [session.sessionId]: {
                    loadState: "loaded",
                    data: [
                        {
                            executionSequence: 1,
                            stateId: "first",
                            childSessionId: null,
                            status: "accepted",
                            outcome: "complete",
                            output: {},
                        },
                        {
                            executionSequence: 2,
                            stateId: "second",
                            childSessionId: null,
                            status: "admitted",
                            outcome: null,
                            output: null,
                        },
                    ],
                },
            },
        },
    });

    const action = message.workflowSections[2].sections[0];
    assert.match(action.text, /Exact transition timing is unavailable/);
    assert.doesNotMatch(action.text, /timing is loading/);
    assert.match(action.text, /Selected next state:\*\* second/);
});

test("execution history retention preserves workflow transition activity pairs", () => {
    const store = createStore(appReducer, createInitialState());
    const events = [
        {
            eventId: 1,
            kind: "ActivityScheduled",
            data: JSON.stringify({
                name: "executeWorkflowTransitionV2",
                input: { context: { executionHistory: [{ executionSequence: 1 }] } },
            }),
        },
        {
            eventId: 2,
            sourceEventId: 1,
            kind: "ActivityCompleted",
            data: JSON.stringify({ kind: "advance", target: "next" }),
        },
        ...Array.from({ length: 1000 }, (_, index) => ({
            eventId: index + 3,
            kind: "Other",
            data: null,
        })),
    ];

    store.dispatch({
        type: "executionHistory/loaded",
        sessionId: "workflow-history",
        events,
        fetchedAt: 123,
    });

    const retained = store.getState().executionHistory.bySessionId["workflow-history"].events;
    assert.equal(retained.length, 1002);
    assert.equal(retained[0].eventId, 1);
    assert.equal(retained[1].eventId, 2);
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
