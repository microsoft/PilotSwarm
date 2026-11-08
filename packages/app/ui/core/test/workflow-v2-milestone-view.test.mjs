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

// Times are shown in the reader's own time zone (owner decision local-time-20261104): this file fixes it to UTC, so no
// result depends on the zone of the machine that runs it.
process.env.TZ = "UTC";

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
    assert.equal(workflowV2NodeLabel(milestoneStates[0]), "Agent · code-reviewer");
    assert.equal(workflowV2NodeLabel({ ...milestoneStates[0], invoke: { source: "prompt" } }), "Agent");
    assert.equal(workflowV2NodeLabel(milestoneStates[1]), "For each · up to 2 at a time");
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
    assert.match(stopping.label, /Canceling · started nodes finish by 2026-11-02 10:00:00$/);
    const stopped = projectWorkflowV2({ readModel: readModel({ graph, run: { status: "stopped" }, nodeExecutions: [done("review", 1, "accepted")] }) });
    assert.equal(stopped.status.phase, "stopped");
    assert.equal(stopped.status.ended, true);
    // Words (Workflow Simplified 05, O8; review 18:45Z): a graceful stop reads Canceled; how it stopped is the tooltip.
    assert.equal(stopped.status.label, "Canceled");
    assert.equal(stopped.status.title, "Canceled after started nodes finished");
    const picker = workflowV2RunPickerModel({ workflowModel: readModel({ graph, run: { status: "stopped" } }) });
    // Review 19:27Z (C): the Workflow's own option is "Workflow · revision 1" (the title says its state); its tooltip says Canceled.
    assert.equal(picker.options[0].label, "Workflow · revision 1");
    assert.match(picker.options[0].title, / · Canceled/);
});

test("an agent state's node names its child session and opens its actual chat; a branch state names its branch", () => {
    const model = readModel({ graph, nodeExecutions: [
        row("review", 1, "pending", { agent: { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false },
            deadline: "2026-11-02T10:10:00.000Z" }),
    ] });
    const projection = projectWorkflowV2({ readModel: model });
    const review = byId(projection, "review");
    assert.equal(review.stateLabel, "Running · until its result");
    assert.deepEqual(review.current.agent, { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false });
    // flow-07: the chat's id and who may write to it are said once, in Agent session; the description only says how the step completes.
    assert.ok(!review.description.some(line => line.includes("child-1")), review.description.join("\n"));
    const opened = [];
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
        tab: "details", selected: review, nodes: projection.nodes, select: () => {}, openSession: id => opened.push(id),
    }));
    assert.ok(html.includes("Open the agent&#x27;s chat (read-only)"));
    assert.ok(html.includes("code-reviewer · review-kit 1.2.0"));
    assert.ok(html.includes("People can read this chat"));
    assert.equal(html.split("child-1").length - 1, 1, "the child session id is shown once");
    assert.equal(html.split("result completes this node").length - 1, 1, "how the node completes is said once");
    // Deadline at reads like the activity list, not raw ISO.
    assert.ok(html.includes("2026-11-02 10:10:00 UTC") && !html.includes("2026-11-02T10:10:00"), html);

    // Mock M14 / ui-02: the chat's own block uses plain labels, and an ended chat says how, in the activity list's words.
    const ended = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [done("review", 1, "accepted",
        { agent: { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: "done", endSent: true } })] }) });
    const endedHtml = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
        tab: "details", selected: byId(ended, "review"), nodes: ended.nodes, select: () => {} }));
    assert.match(endedHtml, /<span>Agent chat<\/span><strong>child-1<\/strong>/);
    assert.match(endedHtml, /<span>Status<\/span><strong>Ended \(result taken\)<\/strong>/);
    assert.ok(!endedHtml.includes("Child session") && !endedHtml.includes("Lifecycle"), endedHtml);

    const branched = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "pending", { branches: 3 }),
        row("work", 1, "pending", { scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
    ] }) });
    assert.equal(byId(branched, "fan").stateLabel, "Running · 0/3 ok");
    assert.ok(byId(branched, "fan").description.includes("3 items."));
    // People read branches from 1 (owner batch 7, H2); the data's index is 0.
    assert.ok(byId(branched, "work").description.includes("Item 1 of fan."));
    // Mock M21: the branches now, from the loaded executions: one begun and still working, two not begun yet.
    assert.ok(byId(branched, "fan").description.includes("Items now: 1 running · 2 waiting · 0 ended"), byId(branched, "fan").description.join("\n"));
    const progressed = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "pending", { branches: 3 }),
        ...[0, 1].map(index => done("work", 1, "ok", { nodeExecutionId: `nx-work-${index}`, scopeId: `nx-fan-1#${index}`, branch: { parallelNodeExecutionId: "nx-fan-1", index } })),
        row("branch_done", 1, "completed", { nodeExecutionId: "nx-branch-done-0", outcome: "succeeded", resultKind: "business", winner: "controller",
            scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
        row("work", 1, "pending", { nodeExecutionId: "nx-work-2", scopeId: "nx-fan-1#2", branch: { parallelNodeExecutionId: "nx-fan-1", index: 2 } }),
    ] }) });
    // Re-check RC-8: branch 2's work finished and its end is not admitted yet: it is between steps, still at work.
    assert.ok(byId(progressed, "fan").description.includes("Items now: 2 running · 0 waiting · 1 ended"), byId(progressed, "fan").description.join("\n"));
    // Mock M22: a blocked join says how many of its branches succeeded.
    const blocked = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("review", 1, "accepted"),
        row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller" }),
        row("branch_done", 1, "completed", { nodeExecutionId: "nx-branch-done-0", outcome: "succeeded", resultKind: "business", winner: "controller",
            scopeId: "nx-fan-1#0", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }),
        done("work", 1, "ok", { nodeExecutionId: "nx-work-1", scopeId: "nx-fan-1#1", branch: { parallelNodeExecutionId: "nx-fan-1", index: 1 } }),
    ] }) });
    assert.ok(byId(blocked, "fan").description.includes("Join blocked: 1/3 ok"), byId(blocked, "fan").description.join("\n"));
    // The portal's Details read the same lines.
    const fanHtml = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: byId(blocked, "fan"), nodes: blocked.nodes, select() {} }));
    assert.ok(fanHtml.includes("Join blocked: 1/3 ok"));
});

test("a real-agent test run says its agents are real, and lists their mocked tool calls under their agent state", () => {
    const test = {
        notice: "TEST — scripts run normally; workflow tools are mocked.", agentMode: "real",
        agentNotice: "Agent steps run real agent sessions: they spend model tokens and their results vary as a model's do.",
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
    assert.ok(project({ ...test, agentNotice: undefined }).includes("Agent steps run real agent sessions; their workflow tool calls are mocked."));
    assert.ok(!project({ ...test, agentMode: "mocked" }).some(text => text.includes("run real agent sessions")));
    const html = renderToStaticMarkup(React.createElement(WorkflowV2TestInterceptions, { test }));
    assert.ok(html.includes("tool.call · read_build"));
    assert.ok(html.includes("review"));
});

test("a test run keeps its notice visible, with its staleness, virtual clock and open interceptions", () => {
    const test = {
        notice: "TEST — scripts run normally; workflow tools are mocked.", agentMode: "mocked", scenario: null, testedRevision: 1, stale: true,
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
    assert.ok(texts.includes("1 call waits for the parent's answer."));
    const html = renderToStaticMarkup(React.createElement(WorkflowV2TestInterceptions, { test }));
    assert.ok(html.includes("Calls (2)"));
    assert.ok(html.includes("tool.call · read_build"));
    assert.ok(html.includes("success · prepared answer"));
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
    // Owner batch 7 (H2): its For each section (where the items come from, how many at a time, the join rule), its branch steps
    // from the first, and its routes from the join.
    for (const [label, value] of [["Items", "${input.items}"], ["At a time", "2"], ["Join", "All must succeed"],
        ["Items started", "3"]]) {
        assert.ok(fanHtml.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: ${fanHtml}`);
    }
    assert.ok(fanHtml.indexOf("<h3>For each</h3>") < fanHtml.indexOf("<h3>Nodes per item</h3>"), fanHtml);
    assert.ok(fanHtml.indexOf("data-branch-step=\"work\"") < fanHtml.indexOf("data-branch-step=\"branch_done\""), "the first step first");
    assert.ok(fanHtml.includes("<h3>Next steps from the join</h3>"), fanHtml);
});
