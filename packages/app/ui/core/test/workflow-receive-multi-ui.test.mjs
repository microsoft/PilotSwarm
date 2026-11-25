import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflow, workflowNodeLabel } from "../src/workflow-view.js";
import { workflowNodeCardWords } from "../src/workflow-words.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { WorkflowGraph } from "../../react/src/workflow-graph.js";
import { WorkflowNodeSummary } from "../../react/src/workflow-panels.js";

const READ_MODEL = {
    workflowId: "wf-parent",
    definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "h", source: null, notifyOnCompletion: true },
    revision: { revision: 1, definitionHash: "h", valid: true, irSha256: "ir", name: "tracker", diagnostics: [] },
    graph: {
        revision: 1,
        initial: "wait_child",
        states: [
            {
                id: "wait_child", type: "messaging", mode: "receive",
                contract: ["Progress@1", "WorkflowEnded@1"], from: null, waitSeconds: 60,
                outcomes: ["Progress@1", "WorkflowEnded@1", "elapsed"],
                next: { "Progress@1": "wait_child", "WorkflowEnded@1": "done", elapsed: "done" },
            },
            { id: "done", type: "terminal", outcome: "succeeded" },
        ],
    },
    runs: [{ runId: "run-1", mode: "live", status: "completed", revision: 1, outcome: "succeeded" }],
    run: {
        runId: "run-1", mode: "live", status: "completed", outcome: "succeeded",
        terminalState: "done", output: "{}", error: null, kvRevision: 1, kv: {}, inputs: {},
        nodeExecutions: [
            {
                nodeExecutionId: "nx-1", stateId: "wait_child", ordinal: 1, state: "completed",
                outcome: "Progress@1", resultKind: "business", winner: "message", attempts: 1, kvRevision: 1,
                enteredAt: "2026-11-25T00:00:00Z", endedAt: "2026-11-25T00:00:05Z",
                receive: { contract: ["Progress@1", "WorkflowEnded@1"], from: null, correlation: {} },
                inputPreview: "{}", outputPreview: "{\"contract\":\"Progress@1\",\"from\":\"wf-child\",\"payload\":{\"step\":1}}",
            },
        ],
        openExecutions: [],
        inbox: [
            { messageId: "m-1", contract: "Progress@1", senderSessionId: "wf-child", correlation: {}, acceptedAt: "2026-11-25T00:00:05Z", claimedBy: "nx-1", claimedAt: "2026-11-25T00:00:05Z", payloadPreview: "{\"step\":1}" },
        ],
        outbox: [], openInbox: [], openOutbox: [], pages: {},
    },
};

test("multi-contract receive renders label, card fact, edge labels, and visit contract + sender in details", () => {
    const flow = projectWorkflow({
        readModel: READ_MODEL,
        events: [],
        session: { sessionId: "wf-parent", status: "completed" },
        sessionName: id => (id === "wf-child" ? "progress-worker" : null),
    });
    const node = flow.nodes.find(n => n.id === "wait_child");
    assert.ok(node);
    assert.equal(workflowNodeLabel(node), "Receive · Progress@1, WorkflowEnded@1");
    assert.equal(workflowNodeCardWords({ kind: "receive", contract: ["Progress@1", "WorkflowEnded@1"], state: "done", outcome: "Progress@1", runs: 1 }).fact, "Progress, WorkflowEnded");
    assert.match(workflowNodeSummary(node).what, /Progress@1 or WorkflowEnded@1/);
    assert.ok(node.description.some(line => /Received Progress@1 from progress-worker./.test(line)), JSON.stringify(node.description));

    const graphHtml = renderToStaticMarkup(React.createElement(WorkflowGraph, { definition: flow.definition, nodes: flow.nodes, selected: "wait_child", select: () => {} }));
    assert.match(graphHtml, /Progress@1/);
    assert.match(graphHtml, /WorkflowEnded@1/);

    const panelNamedHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected: node, nodes: flow.nodes, select: () => {}, runId: "run-1", openSession: () => {},
        sessionName: id => (id === "wf-child" ? "progress-worker" : null),
    }));
    assert.match(panelNamedHtml, /Message types/);
    assert.match(panelNamedHtml, /Progress@1, WorkflowEnded@1/);
    const takenNamed = panelNamedHtml.match(/data-fact="receive-taken"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.match(takenNamed, /Message taken/);
    assert.match(takenNamed, /Progress@1 from progress-worker/);
    assert.ok(!takenNamed.includes("wf-child"), "Message taken must never render raw sender session id");

    const panelUnknownHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected: node, nodes: flow.nodes, select: () => {}, runId: "run-1", openSession: () => {},
    }));
    const takenUnknown = panelUnknownHtml.match(/data-fact="receive-taken"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.match(takenUnknown, /Message taken/);
    assert.match(takenUnknown, /<strong>Progress@1<\/strong>/);
    assert.ok(!takenUnknown.includes("wf-child"), "Message taken must omit unknown sender rather than show raw id");
});
