// Workflow v2 milestone shapes in the shared UI (INACTIVE: only controller 1.9.0 writes them, and only tests run it):
// agent and parallel states, a stopping and a stopped run, an agent state's child (opened from its node), a parallel
// state's branches, and a test run's notice, virtual clock and interceptions. Every state and read-model shape below is
// the one packages/sdk/src/workflow/v2 writes (describeWorkflowV2State, readWorkflowV2View).
//
// Run: node --test packages/app/ui/core/test/workflow-v2-milestone-view.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutWorkflowGraph } from "../src/workflow-view.js";
import {
    annotateWorkflowV2Edges, projectWorkflowV2, projectWorkflowV2ReadModel, workflowV2Definition, workflowV2NodeLabel, workflowV2RunStatus,
} from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent, WorkflowV2TestInterceptions, workflowV2RunPickerModel } from "../../react/src/workflow-v2-panels.js";
import { RUN, readModel, row, done } from "./workflow-v2-fixtures.mjs";

/** An agent state, a parallel state whose body is one script and a terminal, and the outer terminals. */
const milestoneStates = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" }, timeoutSeconds: 600,
        outcomes: ["accepted"], next: { accepted: "fan", timed_out: "failed" } },
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "work", states: ["work", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "branch_done" }, parallel: "fan" },
    { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states: milestoneStates };
const byId = (projection, id) => projection.nodes.find(node => node.id === id);

test("agent and parallel states are read as v2 states, with their own labels; malformed ones are refused", () => {
    const definition = workflowV2Definition(graph);
    assert.equal(definition.states.length, 6);
    assert.equal(workflowV2NodeLabel(milestoneStates[0]), "agent · code-reviewer");
    assert.equal(workflowV2NodeLabel({ ...milestoneStates[0], invoke: { source: "prompt" } }), "agent · inline prompt");
    assert.equal(workflowV2NodeLabel(milestoneStates[1]), "parallel · up to 2 branches");
    assert.throws(() => workflowV2Definition({ ...graph, states: [{ ...milestoneStates[0], invoke: undefined }, ...milestoneStates.slice(1)] }), /has no task/);
    assert.throws(() => workflowV2Definition({ ...graph, states: [milestoneStates[0], { ...milestoneStates[1], body: undefined }, ...milestoneStates.slice(2)] }),
        /has no body or concurrency/);
});

test("a parallel state is drawn leading to its body's first state, as how each branch starts", () => {
    const definition = workflowV2Definition(graph);
    const layout = annotateWorkflowV2Edges(definition, layoutWorkflowGraph(definition, 900));
    const start = layout.edges.find(edge => edge.from === "fan" && edge.to === "work");
    assert.ok(start, "the fan-out edge exists");
    assert.equal(start.kind, "branch");
    assert.equal(start.outcome, "each branch");
    assert.equal(layout.edges.find(edge => edge.from === "fan" && edge.to === "done").kind, "outcome");
});

test("a stopping run says what may still settle; a stopped run is ended, and the picker names it", () => {
    const stopping = workflowV2RunStatus({ run: { runId: RUN, mode: "live", status: "running", stop: { deadline: "2026-11-02T10:00:00.000Z" } }, runId: RUN });
    assert.equal(stopping.phase, "stopping");
    assert.match(stopping.label, /Stopping · steps already started may finish until 2026-11-02T10:00:00.000Z/);
    const stopped = projectWorkflowV2({ readModel: readModel({ graph, run: { status: "stopped" }, nodeExecutions: [done("review", 1, "accepted")] }) });
    assert.equal(stopped.status.phase, "stopped");
    assert.equal(stopped.status.ended, true);
    assert.match(stopped.status.label, /^Stopped/);
    const picker = workflowV2RunPickerModel({ workflowModel: readModel({ graph, run: { status: "stopped" } }) });
    assert.match(picker.options[1].label, /^Live · stopped/);
});

test("an agent state's node names its child session and opens its actual chat; a branch state names its branch", () => {
    const model = readModel({ graph, nodeExecutions: [
        row("review", 1, "pending", { agent: { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false },
            deadline: "2026-11-02T10:10:00.000Z" }),
    ] });
    const projection = projectWorkflowV2({ readModel: model });
    const review = byId(projection, "review");
    assert.equal(review.stateLabel, "Agent working · waiting for its typed result");
    assert.deepEqual(review.current.agent, { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false });
    assert.ok(review.description.some(line => line.includes("child session child-1")));
    const opened = [];
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
        tab: "details", selected: review, nodes: projection.nodes, select: () => {}, openSession: id => opened.push(id),
    }));
    assert.ok(html.includes("Open the agent&#x27;s chat (read-only)"));
    assert.ok(html.includes("code-reviewer · review-kit 1.2.0"));
    assert.ok(html.includes("People can read this chat"));

    const branched = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "pending", { branches: 3 }),
        row("work", 1, "pending", { scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
    ] }) });
    assert.equal(byId(branched, "fan").stateLabel, "Running its branches");
    assert.ok(byId(branched, "fan").description.includes("3 branches from its manifest."));
    assert.ok(byId(branched, "work").description.includes("In branch 0 of its parallel step."));
    // Mock M21: the branches now, from the loaded executions: one begun and still working, two not begun yet.
    assert.ok(byId(branched, "fan").description.includes("Branches now: 1 active, 2 queued, 0 ended."), byId(branched, "fan").description.join("\n"));
    const progressed = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "pending", { branches: 3 }),
        ...[0, 1].map(index => done("work", 1, "ok", { nodeExecutionId: `nx-work-${index}`, scopeId: `nx-fan-1#${index}`, branch: { parallelNodeExecutionId: "nx-fan-1", index } })),
        row("branch_done", 1, "completed", { nodeExecutionId: "nx-branch-done-0", outcome: "succeeded", resultKind: "business", winner: "controller",
            scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
        row("work", 1, "pending", { nodeExecutionId: "nx-work-2", scopeId: "nx-fan-1#2", branch: { parallelNodeExecutionId: "nx-fan-1", index: 2 } }),
    ] }) });
    assert.ok(byId(progressed, "fan").description.includes("Branches now: 1 active, 0 queued, 2 ended."), byId(progressed, "fan").description.join("\n"));
    // Mock M22: a blocked join says how many of its branches succeeded.
    const blocked = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller" }),
        row("branch_done", 1, "completed", { nodeExecutionId: "nx-branch-done-0", outcome: "succeeded", resultKind: "business", winner: "controller",
            scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
        done("work", 1, "ok", { nodeExecutionId: "nx-work-1", scopeId: "nx-fan-1#1", branch: { parallelNodeExecutionId: "nx-fan-1", index: 1 } }),
    ] }) });
    assert.ok(byId(blocked, "fan").description.includes("Join blocked: 1 of 3 branches succeeded."), byId(blocked, "fan").description.join("\n"));
    // The portal's Details read the same lines.
    const fanHtml = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: byId(blocked, "fan"), nodes: blocked.nodes, select() {} }));
    assert.ok(fanHtml.includes("Join blocked: 1 of 3 branches succeeded."));
});

test("a real-agent test run says its agents are real, and lists their mocked tool calls under their agent state", () => {
    const test = {
        notice: "TEST — scripts run normally; framework tools are mocked.", agentMode: "real",
        agentNotice: "Agent states run real agent sessions: they spend model tokens and their results vary as a model's do.",
        agentPins: null, scenario: null, testedRevision: 1, stale: false, virtualClock: { now: "9000-01-01T00:00:00.000Z", elapsedSeconds: 0 },
        interceptions: [{ interceptionId: "nx-1/call-1", operation: "tool.call", tool: "read_build", stateId: "review", state: "awaiting_parent", response: null }],
        coverage: { unanswered: ["nx-1/call-1"] },
    };
    const project = item => projectWorkflowV2ReadModel(readModel({ graph, definition: { state: "draft", currentRevision: 1, publishedRevision: null },
        run: { mode: "test", test: item }, runs: [{ runId: RUN, mode: "test", status: "running", revision: 1 }] })).banners.map(banner => banner.text);
    const texts = project(test);
    assert.ok(texts.includes(test.notice));
    assert.ok(texts.includes(test.agentNotice));
    // Without its text, the banner still says so; a mocked test has none.
    assert.ok(project({ ...test, agentNotice: undefined }).includes("Agent steps run real agent sessions; their framework tool calls are mocked."));
    assert.ok(!project({ ...test, agentMode: "mocked" }).some(text => text.includes("run real agent sessions")));
    const html = renderToStaticMarkup(React.createElement(WorkflowV2TestInterceptions, { test }));
    assert.ok(html.includes("tool.call · read_build"));
    assert.ok(html.includes("review"));
});

test("a test run keeps its notice visible, with its staleness, virtual clock and open interceptions", () => {
    const test = {
        notice: "TEST — scripts run normally; framework tools are mocked.", agentMode: "mocked", scenario: null, testedRevision: 1, stale: true,
        virtualClock: { now: "9000-01-01T01:00:00.000Z", elapsedSeconds: 3600 },
        interceptions: [
            { interceptionId: "nx-1/call-1", operation: "tool.call", tool: "read_build", stateId: "fetch", state: "responded",
                response: { kind: "success", disposition: "fixture" } },
            { interceptionId: "nx-2/agent", operation: "agent", tool: null, stateId: "review", state: "awaiting_parent", response: null },
        ],
        coverage: { unanswered: ["nx-2/agent"] },
    };
    const model = projectWorkflowV2ReadModel(readModel({ graph, definition: { state: "draft", currentRevision: 2, publishedRevision: null },
        run: { mode: "test", test }, runs: [{ runId: RUN, mode: "test", status: "running", revision: 1 }] }));
    const texts = model.banners.map(banner => banner.text);
    assert.ok(texts.includes(test.notice));
    assert.ok(texts.some(text => text.includes("This test ran revision 1; the definition is now at revision 2")));
    assert.ok(texts.some(text => text.startsWith("Virtual clock: 1 h")));
    assert.ok(texts.includes("1 intercepted effect waits for the parent's answer."));
    const html = renderToStaticMarkup(React.createElement(WorkflowV2TestInterceptions, { test }));
    assert.ok(html.includes("Intercepted effects (2)"));
    assert.ok(html.includes("tool.call · read_build"));
    assert.ok(html.includes("success · fixture"));
    assert.ok(html.includes("Waiting for the parent"));
});

/** Every element of a React element tree whose props match `predicate`; function components are expanded with their props. */
function elementsOf(node, predicate, found = []) {
    if (Array.isArray(node)) { for (const child of node) elementsOf(child, predicate, found); return found; }
    if (!node || typeof node !== "object") return found;
    if (typeof node.type === "function") return elementsOf(node.type(node.props), predicate, found);
    if (predicate(node)) found.push(node);
    return elementsOf(node.props?.children, predicate, found);
}

// The portal's node Details as controls, not only as text (accounting rows 34, 35, 48, 49, 76): a transition button selects
// its target state; an agent state's child button opens exactly that child's chat; the outcomes, the parallel manifest and
// join rows are shown.
test("the portal's Details: a transition selects its state, the agent child opens its own chat, outcomes and a parallel state's rows are shown", () => {
    const projection = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        row("review", 1, "pending", { agent: { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false } }),
    ] }) });
    const review = byId(projection, "review");
    const selected = [];
    const opened = [];
    const tree = WorkflowV2NodeContent({ tab: "details", selected: review, nodes: projection.nodes, select: id => selected.push(id), openSession: id => opened.push(id) });
    // The child-chat button shares the transition buttons' look (class), so each is picked by its own marker.
    const transitions = elementsOf(tree, element => element.type === "button" && element.props.className === "ps-workflow-transition"
        && element.props["data-action"] === undefined);
    assert.deepEqual(transitions.map(button => button.props.disabled), [false, false], "both targets are states of this graph");
    for (const button of transitions) button.props.onClick();
    assert.deepEqual(selected, ["fan", "failed"], "each transition selects exactly its target");
    assert.deepEqual(opened, [], "no transition opens a session");
    const child = elementsOf(tree, element => element.type === "button" && element.props["data-action"] === "open-agent-chat");
    assert.equal(child.length, 1);
    assert.equal(child[0].props.children, "Open the agent's chat (read-only)");
    child[0].props.onClick();
    assert.deepEqual(opened, ["child-1"]);
    const html = renderToStaticMarkup(tree);
    assert.ok(html.includes("<span>Outcomes</span><strong>accepted</strong>"), html);

    const fan = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [done("review", 1, "accepted"), row("fan", 1, "pending", { branches: 3 })] }) }), "fan");
    const fanHtml = renderToStaticMarkup(WorkflowV2NodeContent({ tab: "details", selected: fan, nodes: projection.nodes, select() {} }));
    for (const [label, value] of [["Branches start at", "work"], ["Concurrency", "Up to 2 branches at a time"], ["Join", "Every branch must succeed"], ["Branches", "3"]]) {
        assert.ok(fanHtml.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: ${fanHtml}`);
    }
});
