// The Node panel says what you are looking at (owner feedback 2026-11-06, finding 7): what the node does in one sentence,
// Now and Runs in one line each, the last result as readable text, an agent node's chat and what its agent is told, and
// Next in words, one line per outcome, with what happens when it fails. No Details / Output / History tabs inside the
// panel's tab, and no engine words ("runtime error route"). One model (workflowNodeSummary) for the portal and the TUI.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-node-summary.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflowV2 } from "../src/workflow-v2-view.js";
import {
    workflowFirstSentence, workflowNodeDuration, workflowNodeNext, workflowNodeNow, workflowNodeRuns, workflowNodeSummary, workflowNodeWhat,
    workflowReadableValue,
} from "../src/workflow-node-summary.js";
import { WorkflowV2NodeSummary } from "../../react/src/workflow-v2-panels.js";
import { done, readModel, row, states as POLL_STATES } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-11-06T17:45:00.000Z");
const at = clock => `2026-11-06T${clock}.000Z`;

const AGENT = { id: "fact", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 93, outcomes: ["produced"], chat: "continue",
    next: { produced: "relay_to_chat", timed_out: "relay_to_chat" },
    about: { prompt: "Tell one new fact about PostgreSQL. Keep it short.\nUse the variables." } };
const graph = { revision: 1, initial: "fact", states: [
    AGENT,
    { id: "relay_to_chat", type: "messaging", mode: "send", contract: "Fact@1", recipient: "parent", outcomes: ["sent"], next: { sent: "pause", failure: "failed" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "fact" } },
    { id: "failed", type: "terminal", outcome: "failed" },
] };
const agent = id => ({ childSessionId: id, controllingSessionId: "parent", spawned: true, spawnAttempts: 1, end: null, endSent: false });
const model = readModel({ graph, nodeExecutions: [
    done("fact", 1, "produced", { winner: "agent", enteredAt: at("17:40:01"), endedAt: at("17:40:04"), outputPreview: "{\"fact\":\"PostgreSQL has MVCC.\"}",
        agent: agent("chat-1") }),
    done("fact", 2, "produced", { winner: "agent", enteredAt: at("17:42:01"), endedAt: at("17:42:05"), outputPreview: "{\"fact\":\"VACUUM frees dead rows.\"}",
        agent: agent("chat-1") }),
    row("fact", 3, "pending", { enteredAt: at("17:43:01"), deadline: at("17:44:34"), agent: agent("chat-1") }),
] });
const nodeOf = (id, from = model) => projectWorkflowV2({ readModel: from }).nodes.find(node => node.id === id);

test("what it does, in one sentence: the description, else from the prompt or the node's kind", () => {
    assert.equal(workflowNodeWhat(nodeOf("fact")), "Asks an agent: “Tell one new fact about PostgreSQL.”");
    assert.equal(workflowNodeWhat({ ...nodeOf("fact"), about: { description: "Finds one fact.", prompt: "x" } }), "Finds one fact.");
    assert.equal(workflowNodeWhat(nodeOf("relay_to_chat")), "Sends a Fact@1 message to the parent session.");
    assert.equal(workflowNodeWhat(nodeOf("pause")), "Waits 30 s.");
    assert.equal(workflowNodeWhat(nodeOf("failed")), "Ends the Workflow: failed.");
    const named = { id: "review", kind: "agent", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" } };
    assert.equal(workflowNodeWhat(named), "Asks agent code-reviewer · review-kit 1.2.0 to do its task with the node's input.");
    const poll = projectWorkflowV2({ readModel: readModel() }).nodes;
    assert.equal(workflowNodeWhat(poll.find(node => node.id === "poll")), "Runs the script poll, for at most 5 min.");
    assert.equal(workflowNodeWhat(poll.find(node => node.id === "await_ack")), "Waits for an Ack@1 message from the parent session, for at most 10 min.");
    assert.equal(workflowFirstSentence(`${"word ".repeat(60)}end.`, 40).length, 40);
});

test("Now, Runs and the last result say where the node is, how often it ran and what it produced", () => {
    const node = nodeOf("fact");
    assert.equal(node.current.enteredAt, at("17:43:01"), "the read model's visit times reach the projection");
    assert.equal(workflowNodeNow(node, node.current, NOW), "Agent working since 17:43:01 UTC · time limit 17:44:34 UTC");
    assert.equal(workflowNodeRuns(node, node.current, NOW), "Visit 3 · started 17:43:01 UTC");
    const ended = node.executions.find(item => item.ordinal === 2);
    assert.equal(workflowNodeNow(node, ended, NOW), "Done 17:42:05 UTC · produced");
    assert.equal(workflowNodeRuns(node, ended, NOW), "Ran 3 times · last 17:42:01 UTC–17:42:05 UTC (4 s)");
    // The last result is the latest ended visit's own value, as text: the fact, not only "produced".
    const summary = workflowNodeSummary(node, { now: NOW });
    assert.deepEqual({ label: summary.result.label, text: summary.result.text }, { label: "Last result", text: "VACUUM frees dead rows." });
    assert.equal(summary.agent.chatMode, "Continues the same chat");
    assert.equal(summary.agent.chatSessionId, "chat-1");
    assert.equal(summary.agent.told, "Tell one new fact about PostgreSQL. Keep it short.\nUse the variables.");
    // Failures and cancels in words.
    const failed = { status: "completed", resultKind: "runtime_error", outcome: "execution_failed", endedAt: at("17:44:00"),
        errorPreview: "{\"code\":\"execution_failed\",\"message\":\"The API refused the call. Try later.\"}" };
    assert.equal(workflowNodeNow(node, failed, NOW), "Failed 17:44:00 UTC · The API refused the call.");
    assert.equal(workflowNodeNow(node, { ...failed, outcome: "cancelled" }, NOW), "Canceled 17:44:00 UTC");
    assert.equal(workflowNodeNow(node, { ...failed, outcome: "timed_out" }, NOW), "Time limit passed 17:44:00 UTC");
    const failedNode = { ...node, executions: [{ ...failed, id: "nx-9", ordinal: 9 }] };
    assert.deepEqual(workflowNodeSummary(failedNode, { execution: failedNode.executions[0], now: NOW }).result,
        { label: "What went wrong", text: "The API refused the call. Try later. (execution_failed)", truncated: false, executionId: "nx-9", error: true });
    assert.equal(workflowNodeNow({ kind: "script", type: "script", runs: 0 }, null, NOW), "Not reached yet.");
    assert.equal(workflowNodeDuration(125_000), "2 min 5 s");
    assert.equal(workflowNodeDuration(3_780_000), "1 h 3 min");
});

test("a result preview reads as text: a single text field as itself, plain fields as lines, the rest as JSON; a cut one says so", () => {
    assert.deepEqual(workflowReadableValue("{\"fact\":\"MVCC\"}"), { text: "MVCC", truncated: false });
    assert.deepEqual(workflowReadableValue("\"plain words\""), { text: "plain words", truncated: false });
    assert.deepEqual(workflowReadableValue("{\"count\":3,\"ok\":true,\"name\":\"x\"}"), { text: "count: 3\nok: true\nname: x", truncated: false });
    assert.deepEqual(workflowReadableValue("{\"list\":[1,2]}"), { text: "{\n  \"list\": [\n    1,\n    2\n  ]\n}", truncated: false });
    assert.deepEqual(workflowReadableValue("{\"text\":\"xxxx…"), { text: "{\"text\":\"xxxx…", truncated: true });
    assert.equal(workflowReadableValue("null"), null);
    assert.equal(workflowReadableValue(undefined), null);
});

test("Next says where each outcome goes in words, and what happens when it fails with no route for it", () => {
    assert.deepEqual(workflowNodeNext(nodeOf("fact")), {
        lines: [
            { label: "produced", target: "relay_to_chat", kind: "outcome", text: "produced → relay_to_chat" },
            { label: "timed_out", target: "relay_to_chat", kind: "error", text: "If its time limit passes → relay_to_chat" },
        ],
        failure: "If it fails another way: the Workflow stops.",
    });
    assert.equal(workflowNodeNext(nodeOf("relay_to_chat")).failure, null, "a failure route takes every error");
    assert.equal(workflowNodeNext(nodeOf("pause")).failure, "If it fails: the Workflow stops.");
    assert.equal(workflowNodeNext({ ...nodeOf("pause"), parallel: "fan" }).failure, "If it fails: its item ends.");
    assert.deepEqual(workflowNodeNext(nodeOf("failed")), { lines: [], failure: null });
});

test("the portal's Node panel: one view, in words, with the agent's prompt folded and its chat one click away", () => {
    const projection = projectWorkflowV2({ readModel: model });
    const selected = projection.nodes.find(node => node.id === "fact");
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected, nodes: projection.nodes, select: () => {},
        openSession: () => {}, runId: projection.runId }));
    for (const words of ["Asks an agent: “Tell one new fact about PostgreSQL.”", "Now", "Agent working since ", "17:43:01 UTC", "Runs", "Visit 3",
        "Last result", "VACUUM frees dead rows.", "Chat", "Continues the same chat", "What the agent is told", "Open the agent chat",
        "produced → relay_to_chat", "If its time limit passes → relay_to_chat", "If it fails another way: the Workflow stops."]) {
        assert.ok(html.includes(words), words);
    }
    for (const gone of ["runtime error route", "Node detail views", "Last outcome", "Deadline at", "Inline prompt", "Visits"]) {
        assert.ok(!html.includes(gone), `no "${gone}"`);
    }
    assert.match(html, /<details class="ps-wf-told"><summary>What the agent is told<\/summary><pre>Tell one new fact/);
    // A script node with no run yet: what it does and where it goes; nothing about runs or results.
    const fresh = projectWorkflowV2({ readModel: readModel({ graph: { revision: 1, initial: "poll", states: POLL_STATES } }) });
    const poll = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: fresh.nodes.find(node => node.id === "poll"),
        nodes: fresh.nodes, select: () => {} }));
    assert.ok(poll.includes("Runs the script poll, for at most 5 min."));
    assert.ok(poll.includes("Not reached yet."));
    assert.ok(!poll.includes("Last result"));
    assert.ok(poll.includes("If its time limit passes → failed") && poll.includes("If it fails → failed"));
});
