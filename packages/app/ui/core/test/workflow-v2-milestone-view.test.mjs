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
    assert.match(stopping.label, /Stopping · admitted work may settle until 2026-11-02T10:00:00.000Z/);
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
    assert.ok(byId(branched, "work").description.includes("In branch 0 of its parallel state."));
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
