// An agent node's Log shows its chat (owner feedback 2026-11-06, finding 8): one group per visit, newest first
// ("Visit 2 · 17:42:01"), each with its Prompt, Agent and Workflow rows in time order, told apart by label (and, in the
// portal, the colour of the row's edge). A chat that continues across visits is cut at each visit's prompt. Tool calls are
// one line each, to expand; long text folds with Show more. The base instructions are not recorded, and the Log says so.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-agent-log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    WORKFLOW_AGENT_LOG_FOLD, WORKFLOW_AGENT_LOG_NOTE, workflowAgentLogChats, workflowAgentNodeLog, workflowLogFold, workflowPromptVisit,
} from "../src/workflow-agent-log.js";
import { WorkflowV2AgentLog } from "../../react/src/workflow-v2-panels.js";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-11-06T17:50:00.000Z");
const at = clock => `2026-11-06T${clock}.000Z`;
const CHAT = "chat-continued";
const prompt = (seq, nx, clock, content) => ({ sessionId: CHAT, seq, eventType: "user.message", createdAt: at(clock),
    data: { content, clientMessageIds: [`workflow:wf-1:run-1:agent:${nx}`], sender: { kind: "agent", display: "workflow node invocation" } } });
const chatEvent = (seq, eventType, clock, data) => ({ sessionId: CHAT, seq, eventType, createdAt: at(clock), data });
const wfEvent = (seq, eventType, clock, data) => ({ sessionId: "wf-1", seq, eventType, createdAt: at(clock), data: { runId: "run-1", stateId: "talk", ...data } });

const node = {
    id: "talk", kind: "agent", type: "agent", runs: 2, outcomes: ["again", "finish"], next: { again: "pause", finish: "done" },
    executions: [
        { id: "nx-1", ordinal: 1, status: "completed", outcome: "again", resultKind: "business", enteredAt: at("17:40:01"), endedAt: at("17:40:09"),
            agent: { childSessionId: CHAT } },
        { id: "nx-2", ordinal: 2, status: "pending", enteredAt: at("17:42:01"), deadline: at("17:43:01"), agent: { childSessionId: CHAT } },
    ],
};
node.current = node.executions[1];
const LONG = `${"MVCC keeps old row versions. ".repeat(40)}End.`;
const chat = [
    chatEvent(1, "session.turn_started", "17:40:01", {}),
    prompt(2, "nx-1", "17:40:02", "[SYSTEM: WORKFLOW NODE INVOCATION.]\n{\"input\":{}}\n[SYSTEM: The task of this state:]\nTell one fact."),
    chatEvent(3, "tool.execution_start", "17:40:03", { toolCallId: "t1", toolName: "read_facts", arguments: { key_pattern: "facts/%" } }),
    chatEvent(4, "tool.execution_complete", "17:40:04", { toolCallId: "t1", toolName: "read_facts", result: { count: 0 } }),
    chatEvent(5, "assistant.message", "17:40:05", { content: "PostgreSQL uses MVCC." }),
    chatEvent(6, "tool.execution_start", "17:40:06", { toolCallId: "t2", toolName: "complete_workflow_node",
        arguments: { outcome: "again", output: { fact: "MVCC" }, operation_id: "op-1", node_execution_id: "nx-1" } }),
    chatEvent(7, "tool.execution_complete", "17:40:07", { toolCallId: "t2", toolName: "complete_workflow_node", result: "{\"ok\":true}" }),
    prompt(8, "nx-2", "17:42:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2.]\n{\"cycle\":2}\n[SYSTEM: The task of this state:]\nTell one fact."),
    chatEvent(9, "system.message", "17:42:03", { content: "Workspace note." }),
    chatEvent(10, "assistant.message", "17:42:04", { content: LONG }),
];
const events = [
    wfEvent(20, "workflow.state_started", "17:40:01", { nodeExecutionId: "nx-1", step: 1 }),
    wfEvent(21, "workflow.agent_spawned", "17:40:02", { nodeExecutionId: "nx-1", childSessionId: CHAT, chat: "continue", cycle: 1 }),
    wfEvent(22, "workflow.state_completed", "17:40:08", { nodeExecutionId: "nx-1", step: 1, outcome: "again" }),
    wfEvent(23, "workflow.agent_cycle_ended", "17:40:09", { nodeExecutionId: "nx-1", childSessionId: CHAT, turnStopped: true }),
    wfEvent(24, "workflow.state_started", "17:42:01", { nodeExecutionId: "nx-2", step: 2 }),
    wfEvent(25, "workflow.state_started", "17:42:01", { runId: "run-other", nodeExecutionId: "nx-2", step: 2 }),
];

test("a prompt names its visit by its client message id; the chats read are the shown visits' (a continued chat once)", () => {
    assert.equal(workflowPromptVisit(chat[1]), "nx-1");
    assert.equal(workflowPromptVisit(chat[4]), null);
    assert.deepEqual(workflowAgentLogChats(node), [CHAT]);
    assert.deepEqual(workflowLogFold("short"), { text: "short" });
    const folded = workflowLogFold(LONG);
    assert.equal(folded.more, LONG);
    assert.ok(folded.text.length <= WORKFLOW_AGENT_LOG_FOLD + 1 && folded.text.endsWith("…"));
});

test("one group per visit, newest first; each visit's chat rows and Workflow rows in time order, told apart", () => {
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", now: NOW });
    assert.equal(log.note, WORKFLOW_AGENT_LOG_NOTE);
    assert.equal(log.loading, false);
    assert.deepEqual(log.groups.map(group => [group.header, group.status]), [
        ["Visit 2 · 17:42:01 UTC", "Agent working since 17:42:01 UTC · time limit 17:43:01 UTC"],
        ["Visit 1 · 17:40:01 UTC", "Done 17:40:09 UTC · again"],
    ]);
    const [second, first] = log.groups;
    assert.deepEqual(first.rows.map(row => [row.kind, row.label, row.text.split("\n")[0]]), [
        ["workflow", "Workflow", "Node talk started"],
        ["prompt", "Prompt", "[SYSTEM: WORKFLOW NODE INVOCATION.]"],
        ["workflow", "Workflow", "Agent chat for node talk created (session chat-con)"],
        ["agent", "Tool", "read_facts — facts/%"],
        ["agent", "Agent", "PostgreSQL uses MVCC."],
        ["result", "Typed result", "again · {\"fact\":\"MVCC\"}"],
        ["workflow", "Workflow", "Node talk ended: again"],
        ["workflow", "Workflow", "Node talk visit ended; its agent chat stays open for the next visit (its running turn was stopped)"],
    ]);
    const tool = first.rows.find(row => row.label === "Tool");
    assert.match(tool.detail, /^Arguments\n\{\n {2}"key_pattern": "facts\/%"\n\}\n\nResult\n\{\n {2}"count": 0\n\}$/);
    assert.deepEqual(first.rows.map(row => row.time), first.rows.map(row => row.time).slice().sort());
    // The second visit gets only its own part of the one chat (cut at its prompt), and only its own run's lines.
    assert.deepEqual(second.rows.map(row => [row.kind, row.label]), [
        ["workflow", "Workflow"], ["prompt", "Prompt"], ["prompt", "Note to the agent"], ["agent", "Agent"],
    ]);
    const answer = second.rows.find(row => row.label === "Agent");
    assert.equal(answer.more, LONG, "a long answer folds");
    // Not read yet: the visit says so, and nothing is guessed.
    const unread = workflowAgentNodeLog({ node, events, chats: new Map(), runId: "run-1", now: NOW });
    assert.equal(unread.loading, true);
    assert.ok(unread.groups.every(group => group.loading && group.rows.every(row => row.kind === "workflow")));
    // Older visits beyond the limit: "Show older visits".
    assert.equal(workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", limit: 1, now: NOW }).more, true);
});

test("the portal draws each row with its label, folds long text and expands a tool call; the note says what is not recorded", () => {
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "talk", onMore: () => {} }));
    assert.ok(html.includes("The agent&#x27;s base instructions are not recorded in its chat."));
    assert.ok(html.includes("Visit 2 · 17:42:01 UTC") && html.includes("Visit 1 · 17:40:01 UTC"));
    assert.ok(html.indexOf("Visit 2") < html.indexOf("Visit 1"), "newest visit first");
    for (const kind of ["prompt", "agent", "result", "workflow"]) assert.ok(html.includes(`data-kind="${kind}"`), kind);
    assert.match(html, /<details><summary>read_facts — facts\/%<\/summary><pre>Arguments/);
    assert.ok(html.includes("Show more"));
    assert.ok(!html.includes(LONG), "the long answer is folded");
    const failed = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, {
        log: workflowAgentNodeLog({ node, events, chats: new Map(), runId: "run-1", now: NOW }), failed: new Set([CHAT]) }));
    assert.ok(failed.includes("Its agent chat could not be read."));
});
