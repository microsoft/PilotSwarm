/**
 * Issue I8 (Task 4b): Portal visit ordering across re-entered parallel forks using composite
 * workflowVisitRank(execution, executions) = [parallelOrdinal, ordinal].
 *
 * Run: node --test packages/app/ui/core/test/workflow-branch-visit-order.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    compareWorkflowVisitRank, projectWorkflow, workflowVisitRank,
} from "../src/workflow-view.js";
import {
    workflowAgentLogVisits, workflowAgentNodeLog,
} from "../src/workflow-agent-log.js";
import {
    workflowNodeSummary,
} from "../src/workflow-node-summary.js";
import { WorkflowAgentLog } from "../../react/src/workflow-panels.js";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-11-26T17:50:00.000Z");
const at = clock => `2026-11-26T${clock}.000Z`;
const AGENT_SESSION = "agent-branch-continued";

const prompt = (seq, nx, clock, content) => ({
    sessionId: AGENT_SESSION, seq, eventType: "user.message", createdAt: at(clock),
    data: { content, clientMessageIds: [`workflow:wf-1:run-1:agent:${nx}`], sender: { kind: "agent", display: "workflow node invocation" } },
});
const chatEvent = (seq, eventType, clock, data) => ({ sessionId: AGENT_SESSION, seq, eventType, createdAt: at(clock), data });
const wfEvent = (seq, eventType, clock, data) => ({ sessionId: "wf-1", seq, eventType, createdAt: at(clock), data: { runId: "run-1", ...data } });

const fan1 = { id: "nx-fan1", stateId: "fan", ordinal: 1, scopeId: "root", status: "completed" };
const fan2 = { id: "nx-fan2", stateId: "fan", ordinal: 2, scopeId: "root", status: "pending" };
const f1v1 = {
    id: "nx-f1v1", stateId: "left_code", ordinal: 1, scopeId: "nx-fan1#0",
    branch: { parallelNodeExecutionId: "nx-fan1", index: 0, name: "left" },
    parallelOrdinal: 1, status: "completed", outcome: "again", resultKind: "business",
    outputPreview: "{\"step\":1}", enteredAt: at("17:40:01"), endedAt: at("17:40:09"),
    agent: { childSessionId: AGENT_SESSION, spawned: true },
};
const f1v2 = {
    id: "nx-f1v2", stateId: "left_code", ordinal: 2, scopeId: "nx-fan1#0",
    branch: { parallelNodeExecutionId: "nx-fan1", index: 0, name: "left" },
    parallelOrdinal: 1, status: "completed", outcome: "done", resultKind: "business",
    outputPreview: "{\"step\":2}", enteredAt: at("17:41:01"), endedAt: at("17:41:09"),
    agent: { childSessionId: AGENT_SESSION, spawned: true },
};
const f2v1 = {
    id: "nx-f2v1", stateId: "left_code", ordinal: 1, scopeId: "nx-fan2#0",
    branch: { parallelNodeExecutionId: "nx-fan2", index: 0, name: "left" },
    parallelOrdinal: 2, status: "completed", outcome: "done", resultKind: "business",
    outputPreview: "{\"step\":3}", enteredAt: at("17:42:01"), endedAt: at("17:42:09"),
    agent: { childSessionId: AGENT_SESSION, spawned: true },
};
const root1 = { id: "nx-r1", stateId: "outer", ordinal: 1, scopeId: "root", status: "completed" };
const root2 = { id: "nx-r2", stateId: "outer", ordinal: 2, scopeId: "root", status: "completed" };

test("workflowVisitRank orders [f1v1, f1v2, f2v1] across re-entered parallel forks and keeps [0, k] for root scope", () => {
    const allExecs = [fan1, fan2, f1v1, f1v2, f2v1, root1, root2];
    // Without stamped parallelOrdinal, workflowVisitRank resolves from executions via scopeId
    const bare = ({ parallelOrdinal: _, ...rest }) => rest;
    assert.deepEqual(workflowVisitRank(bare(f1v1), allExecs), [1, 1]);
    assert.deepEqual(workflowVisitRank(bare(f1v2), allExecs), [1, 2]);
    assert.deepEqual(workflowVisitRank(bare(f2v1), allExecs), [2, 1]);
    assert.deepEqual(workflowVisitRank(root1, allExecs), [0, 1]);
    assert.deepEqual(workflowVisitRank(root2, allExecs), [0, 2]);

    // With stamped parallelOrdinal and no executions array
    assert.deepEqual(workflowVisitRank(f2v1), [2, 1]);
    const sorted = [f2v1, f1v2, f1v1].sort((a, b) => compareWorkflowVisitRank(a, b));
    assert.deepEqual(sorted.map(v => v.id), ["nx-f1v1", "nx-f1v2", "nx-f2v1"]);
});

test("workflowNodeSummary picks fork-2 visit 1 as latest result and latest chat session over fork-1 visit 2", () => {
    const replacementSession = "agent-branch-replacement";
    const node = {
        id: "left_code", kind: "agent", type: "agent", session: "continue", runs: 3,
        outcomes: ["again", "done"], next: { again: "left_code", done: "left_done" },
        executions: [
            f1v1,
            f1v2,
            { ...f2v1, agent: { childSessionId: replacementSession, spawned: true } },
        ],
    };
    const summary = workflowNodeSummary(node, { execution: null, now: NOW });
    assert.equal(summary.result?.executionId, "nx-f2v1");
    assert.equal(summary.agent?.sessionId, replacementSession);
});

test("workflowAgentLogVisits and workflowAgentNodeLog order fork-2 visit 1 first, split turns cleanly, carry Base instructions, and show cycle 3", () => {
    const node = {
        id: "left_code", kind: "agent", type: "agent", session: "continue", runs: 3,
        outcomes: ["again", "done"], next: { again: "left_code", done: "left_done" },
        executions: [f1v1, f1v2, f2v1],
    };
    // Limit 2 must keep [f2v1, f1v2] (newest first), never dropping f2v1!
    assert.deepEqual(workflowAgentLogVisits(node, 2).map(v => v.id), ["nx-f2v1", "nx-f1v2"]);

    const baseSha = "a".repeat(64);
    const agentEvents = [
        chatEvent(1, "system.message", "17:40:01", {
            content: "[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. Full content omitted from CMS (420 chars). Snippet: Base prompt text.]",
            baseInstructions: { sessionId: AGENT_SESSION, artifact: `base-instructions-${baseSha.slice(0, 16)}.md`, sha256: baseSha, chars: 420 },
        }),
        prompt(2, "nx-f1v1", "17:40:02", "[SYSTEM: WORKFLOW NODE INVOCATION.]\n{}\nTask 1"),
        chatEvent(3, "assistant.message", "17:40:05", { content: "Fork 1 visit 1 reply." }),
        prompt(4, "nx-f1v2", "17:41:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2.]\n{}\nTask 2"),
        chatEvent(5, "assistant.message", "17:41:05", { content: "Fork 1 visit 2 reply." }),
        prompt(6, "nx-f2v1", "17:42:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 3.]\n{}\nTask 3"),
        chatEvent(7, "assistant.message", "17:42:05", { content: "Fork 2 visit 1 reply." }),
    ];
    const wfEvents = [
        wfEvent(10, "workflow.state_started", "17:40:01", { stateId: "left_code", nodeExecutionId: "nx-f1v1", step: 1, scopeId: "nx-fan1#0" }),
        wfEvent(11, "workflow.agent_spawned", "17:40:02", { stateId: "left_code", nodeExecutionId: "nx-f1v1", childSessionId: AGENT_SESSION, session: "continue", cycle: 1 }),
        wfEvent(12, "workflow.state_started", "17:41:01", { stateId: "left_code", nodeExecutionId: "nx-f1v2", step: 2, scopeId: "nx-fan1#0" }),
        wfEvent(13, "workflow.agent_spawned", "17:41:02", { stateId: "left_code", nodeExecutionId: "nx-f1v2", childSessionId: AGENT_SESSION, session: "continue", cycle: 2 }),
        wfEvent(14, "workflow.state_started", "17:42:01", { stateId: "left_code", nodeExecutionId: "nx-f2v1", step: 1, scopeId: "nx-fan2#0" }),
        wfEvent(15, "workflow.agent_spawned", "17:42:02", { stateId: "left_code", nodeExecutionId: "nx-f2v1", childSessionId: AGENT_SESSION, session: "continue", cycle: 3 }),
    ];

    const log = workflowAgentNodeLog({
        node, events: wfEvents, agentSessions: new Map([[AGENT_SESSION, agentEvents]]),
        coverage: new Map([[AGENT_SESSION, { hasOlder: false }]]), runId: "run-1", now: NOW, limit: 10,
    });
    // Newest first: f2v1 (with " · cycle 3"), then f1v2 ("Visit 2"), then f1v1 ("Visit 1")
    assert.deepEqual(log.groups.map(g => g.visitId), ["nx-f2v1", "nx-f1v2", "nx-f1v1"]);
    assert.equal(log.groups[0].header, "Visit 1 · cycle 3 · 17:42:01");
    assert.equal(log.groups[1].header, "Visit 2 · 17:41:01");
    assert.equal(log.groups[2].header, "Visit 1 · 17:40:01");

    // Transcript turns cleanly split per visit
    assert.ok(log.groups[0].rows.some(r => r.label === "Agent" && r.text.includes("Fork 2 visit 1 reply.")));
    assert.ok(log.groups[1].rows.some(r => r.label === "Agent" && r.text.includes("Fork 1 visit 2 reply.")));
    assert.ok(log.groups[2].rows.some(r => r.label === "Agent" && r.text.includes("Fork 1 visit 1 reply.")));

    // Base instructions shown in full on f1v1 and carried forward to f1v2 and f2v1
    const baseRowOf = group => group.rows.find(r => r.label === "Base instructions");
    assert.equal(baseRowOf(log.groups[2])?.carriedFrom ?? null, null);
    assert.equal(baseRowOf(log.groups[1])?.carriedFrom, 1);
    assert.equal(baseRowOf(log.groups[0])?.carriedFrom, 1);

    // Portal React panel renders fork-2 visit 1 first with its true cycle number
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "left_code" }));
    const idxF2 = html.indexOf("Visit 1 · cycle 3 · 17:42:01");
    const idxF1v2 = html.indexOf("Visit 2 · 17:41:01");
    const idxF1v1 = html.indexOf("Visit 1 · 17:40:01");
    assert.ok(idxF2 >= 0 && idxF1v2 > idxF2 && idxF1v1 > idxF1v2, `unexpected order in rendered HTML: ${[idxF2, idxF1v2, idxF1v1]}`);
    assert.ok(html.includes("Fork 2 visit 1 reply."));
});

test("projectWorkflow stamps parallelOrdinal onto branch executions so downstream views rank re-entered forks", () => {
    const view = projectWorkflow({
        definition: {
            revision: 1, initial: "fan",
            states: [
                { id: "fan", type: "parallel", next: { joined: "fan", failed: "done" } },
                { id: "left_code", type: "agent", session: "continue", parallel: "fan", branchName: "left", next: { again: "left_code", done: "left_done" } },
                { id: "left_done", type: "terminal", outcome: "succeeded", parallel: "fan", branchName: "left" },
                { id: "done", type: "terminal", outcome: "succeeded" },
            ],
        },
        events: [
            wfEvent(1, "workflow.started", "17:40:00", { revision: 1 }),
            wfEvent(2, "workflow.state_started", "17:40:00", { stateId: "fan", nodeExecutionId: "nx-fan1", step: 1, scopeId: "root" }),
            wfEvent(3, "workflow.state_started", "17:40:01", { stateId: "left_code", nodeExecutionId: "nx-f1v1", step: 1, scopeId: "nx-fan1#0" }),
            wfEvent(4, "workflow.state_completed", "17:40:05", { stateId: "left_code", nodeExecutionId: "nx-f1v1", step: 1, scopeId: "nx-fan1#0", outcome: "again", resultKind: "business" }),
            wfEvent(5, "workflow.state_started", "17:40:06", { stateId: "left_code", nodeExecutionId: "nx-f1v2", step: 2, scopeId: "nx-fan1#0" }),
            wfEvent(6, "workflow.state_completed", "17:40:09", { stateId: "left_code", nodeExecutionId: "nx-f1v2", step: 2, scopeId: "nx-fan1#0", outcome: "done", resultKind: "business" }),
            wfEvent(7, "workflow.state_completed", "17:40:10", { stateId: "fan", nodeExecutionId: "nx-fan1", step: 1, scopeId: "root", outcome: "joined", resultKind: "business" }),
            wfEvent(8, "workflow.state_started", "17:41:00", { stateId: "fan", nodeExecutionId: "nx-fan2", step: 2, scopeId: "root" }),
            wfEvent(9, "workflow.state_started", "17:41:01", { stateId: "left_code", nodeExecutionId: "nx-f2v1", step: 1, scopeId: "nx-fan2#0" }),
        ],
        now: NOW,
    });
    const leftNode = view.nodes.find(n => n.id === "left_code");
    assert.ok(leftNode);
    // nodeView exposes executions newest-first by composite [parallelOrdinal, ordinal]
    assert.deepEqual(leftNode.executions.map(e => [e.id, e.parallelOrdinal, e.ordinal]), [
        ["nx-f2v1", 2, 1],
        ["nx-f1v2", 1, 2],
        ["nx-f1v1", 1, 1],
    ]);
    // Production branch-node path in workflowNodeSummary (parallel: "fan") sees fork-2 visit 1 as current (running)
    const branchSummary = workflowNodeSummary(leftNode, { now: NOW });
    assert.match(branchSummary.now ?? "", /^Running/);
});
