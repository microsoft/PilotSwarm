/**
 * Workflow Simplified, stage 1 (spec draft 3, sections 03, 10 and W5–W7): node look and words.
 * - Each node says its type in a word: Script (never "node" for the Node.js runtime), Agent, Wait, Ask, Send, Receive,
 *   For each, End (F5, 03).
 * - The node a Workflow starts at carries the Start marker; ends are rings in their outcome's colour (F4).
 * - A node several items reached counts its items with nouns, red if any failed, never the last item's colour
 *   (usability finding 1): a failed run's step is not green, and a successful first-2-of-3 run's step is not red.
 * - A count is a badge, "↻ 3", with its words in its title ("Ran 3 times"), never "×3" (finding 4; OF-S2-2). Nodes not
 *   reached are dimmed (W7).
 * - The Workflow's state words: Completed, Canceled (O8), Canceling….
 *
 * Run: node --test test/workflow-simplified-node-look.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { projectWorkflowV2, workflowV2ContinueWords, workflowV2ItemCountsText, workflowV2NodeLabel } from "../src/workflow-v2-view.js";
import { workflowOutcomeWord } from "../src/workflow-words.js";
import { WorkflowStepCard } from "../../react/src/workflow-graph.js";
import { done, readModel, row } from "./workflow-v2-fixtures.mjs";

const branch = (fan, index) => ({ scopeId: `${fan}#${index}`, branch: { parallelNodeExecutionId: fan, index } });

const forEach = (join = "all_required") => ({
    revision: 1, initial: "prepare",
    states: [
        { id: "prepare", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "fan" } },
        { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 3, join, failFast: false,
            body: { initial: "check", states: ["check", "item_done"] }, outcomes: ["joined", "blocked"], next: { joined: "summarize", blocked: "stuck" } },
        { id: "check", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "item_done" }, parallel: "fan" },
        { id: "item_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
        { id: "summarize", type: "agent", invoke: { source: "prompt" }, outcomes: ["ok"], next: { ok: "done" }, timeoutSeconds: 300 },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "stuck", type: "terminal", outcome: "failed" },
    ],
});

const byId = (projection, id) => projection.nodes.find(node => node.id === id);
const card = node => renderToStaticMarkup(React.createElement(WorkflowStepCard, { node, selected: false, onSelect() {} }));

test("each node says its type in a word (03, F5)", () => {
    assert.equal(workflowV2NodeLabel({ id: "a", type: "script", runtime: "node" }), "Script", "never 'script · node'");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "agent", invoke: { source: "prompt" } }), "Agent");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "agent", invoke: { source: "agent", name: "reviewer" } }), "Agent · reviewer");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "wait", seconds: 90 }), "Wait · 1 min 30 s");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "messaging", mode: "request", contract: "Approval@1" }), "Ask · Approval@1");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "messaging", mode: "send", contract: "Note@1" }), "Send · Note@1");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "messaging", mode: "receive", contract: "Build@1" }), "Receive · Build@1");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "parallel", concurrency: 3 }), "For each · up to 3 at a time");
    assert.equal(workflowV2NodeLabel({ id: "a", type: "terminal", outcome: "cancelled" }), "End · canceled", "O8: one l on screens");
    assert.equal(workflowOutcomeWord("cancelled"), "canceled");
    assert.equal(workflowV2ItemCountsText({ ok: 2, failed: 1, canceled: 0, running: 0 }), "2 ok · 1 failed");
    assert.equal(workflowV2ContinueWords({ join: "all_required" }), "Joins when all succeed");
    assert.equal(workflowV2ContinueWords({ join: { first: 2 }, forEach: { count: 3 } }), "Joins at the first 2 of 3");
});

test("a failed For each item makes its node red, counted with nouns: never the green of the item that ended last (finding 1)", () => {
    const fan = "nx-fan";
    const rows = [
        done("prepare", 1, "ok", { nodeExecutionId: "nx-prepare" }),
        done("fan", 1, "blocked", { nodeExecutionId: fan, branches: 3 }),
        done("check", 1, "ok", { nodeExecutionId: "nx-a", completedAt: "2026-11-05T07:20:01Z", ...branch(fan, 0) }),
        row("check", 1, "completed", { nodeExecutionId: "nx-c", outcome: "crashed", resultKind: "runtime_error", winner: "controller",
            completedAt: "2026-11-05T07:20:02Z", errorPreview: JSON.stringify({ message: "cherry is out of stock" }), ...branch(fan, 2) }),
        done("check", 1, "ok", { nodeExecutionId: "nx-b", completedAt: "2026-11-05T07:20:03Z", ...branch(fan, 1) }),
    ];
    const projection = projectWorkflowV2({ readModel: readModel({ graph: forEach(), nodeExecutions: rows,
        run: { status: "completed", terminalState: "stuck", outcome: "failed" } }) });
    const check = byId(projection, "check");
    assert.equal(check.state, "failed", "red: an item failed");
    assert.equal(check.stateLabel, "2 ok · 1 failed");
    assert.deepEqual(check.itemCounts, { ok: 2, failed: 1, canceled: 0, running: 0, total: 3 });
    const html = card(check);
    assert.ok(html.includes("is-failed") && html.includes("2 ok · 1 failed") && !html.includes("×"), html);
    // The For each box says how many succeeded; the join words say when the Workflow continues.
    const fanNode = byId(projection, "fan");
    assert.equal(fanNode.joinBar.group.label, "For each item");
    assert.equal(fanNode.joinBar.label, "Joins when all succeed");
    // Nodes the Workflow did not reach are dimmed; the end it reached is filled.
    assert.ok(card(byId(projection, "summarize")).includes("is-not-reached"));
    const stuck = card(byId(projection, "stuck"));
    assert.ok(stuck.includes("is-terminal") && stuck.includes("is-reached") && stuck.includes('data-outcome="failed"'), stuck);
    assert.ok(!card(byId(projection, "done")).includes("is-reached"));
    // The Start marker is on the first node only.
    assert.ok(card(byId(projection, "prepare")).includes("ps-workflow-node-start"));
    assert.ok(!card(byId(projection, "check")).includes("ps-workflow-node-start"));
});

test("an item canceled because the first k already succeeded is not a failure (finding 1, the reverse case)", () => {
    const fan = "nx-fan";
    const rows = [
        done("prepare", 1, "ok", { nodeExecutionId: "nx-prepare" }),
        done("fan", 1, "joined", { nodeExecutionId: fan, branches: 3 }),
        done("check", 1, "ok", { nodeExecutionId: "nx-a", ...branch(fan, 0) }),
        done("check", 1, "ok", { nodeExecutionId: "nx-b", ...branch(fan, 1) }),
        row("check", 1, "completed", { nodeExecutionId: "nx-c", outcome: "cancelled", resultKind: "runtime_error", winner: "join", ...branch(fan, 2) }),
    ];
    const projection = projectWorkflowV2({ readModel: readModel({ graph: forEach({ first: 2 }), nodeExecutions: rows,
        run: { status: "completed", terminalState: "done", outcome: "succeeded" } }) });
    const check = byId(projection, "check");
    assert.notEqual(check.state, "failed");
    assert.equal(check.stateLabel, "2 ok · 1 canceled");
    assert.equal(projection.status.label, "Completed", "a succeeded end needs no outcome");
});

test("a node that ran several times says so as a badge with its words in the title (finding 4; OF-S2-2)", () => {
    const graph = { revision: 1, initial: "poll", states: [
        { id: "poll", type: "script", runtime: "node", outcomes: ["again", "done"], next: { again: "poll", done: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] };
    const rows = [done("poll", 1, "again"), done("poll", 2, "again"), row("poll", 3, "pending")];
    const poll = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows }) }), "poll");
    const html = card(poll);
    assert.ok(html.includes(">↻ 3<") && html.includes('title="Ran 3 times"') && !html.includes("×3"), html);
    // Its type is the icon; the word is in its title, never a row of the card.
    assert.ok(html.includes('data-kind="script"') && !html.includes(">Script<") && html.includes('title="poll · Script · Running · Ran 3 times"'), html);
});

test("the Workflow's own state words: Canceled (immediately or after started nodes finished), Canceling…, Completed · outcome (05, O8)", () => {
    const status = run => projectWorkflowV2({ readModel: readModel({ run }) }).status.label;
    assert.equal(status({ status: "cancelled" }), "Canceled");
    assert.equal(status({ status: "stopped" }), "Canceled");
    // Review 18:45Z: how it was stopped is the tooltip.
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "stopped" } }) }).status.title, "Canceled after started nodes finished");
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "cancelled" } }) }).status.title, "Canceled at once");
    assert.match(status({ status: "running", stop: { requestedAt: "2026-11-05T07:00:00Z", deadline: "2026-11-05T07:01:00Z", graceSeconds: 60 } }), /^Canceling · started nodes finish by /);
    assert.equal(status({ status: "completed", outcome: "blocked", terminalState: "done" }), "Completed · blocked");
    assert.equal(status({ status: "admitted" }), "Running", "accepted but not begun reads Running");
});
