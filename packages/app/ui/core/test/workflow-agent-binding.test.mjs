// An agent state's workflow interface and its pin (design 03, 04, 09; R09, R18; mock M17 "Inspect package pin") in
// the portal's node details and the TUI's workflow view, from the read model readWorkflowView returns: the interface
// the state names (describeWorkflowState's invoke.interface) and the pin of the shown run. That is the publication's
// (definition.publishedAgentPins, migration 0103) for the published revision, a real-agent test run's own
// (run.test.agentPins, migration 0105) when it tested the graph's revision, and none for a mocked test run. A pin shows
// the package, version, exact revision and the interface's digest, short. Malformed or older pins show what they hold.
// Read-only: nothing is sent.
//
// Run: node --test packages/app/ui/core/test/workflow-agent-binding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflow, workflowAgentBindingRows, workflowAgentTask } from "../src/workflow-view.js";
import { WorkflowNodeContent } from "../../react/src/workflow-panels.js";
import { RUN, readModel } from "./workflow-fixtures.mjs";

const REVISION = "0123456789abcdef".repeat(4);
const TESTED_REVISION = "89abcdef01234567".repeat(4);
const DIGEST = "fedcba9876543210".repeat(4);
/** A package agent that names its interface, a deployment agent, and an inline prompt; then the ends. */
const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0", interface: "review_change@1" },
        timeoutSeconds: 600, outcomes: ["accepted", "changes_required"], next: { accepted: "helper", changes_required: "failed", timed_out: "failed" } },
    { id: "helper", type: "agent", invoke: { source: "agent", name: "local-helper", package: null, version: null }, timeoutSeconds: 600,
        outcomes: ["ok"], next: { ok: "inline" } },
    { id: "inline", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
const PIN = { name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: REVISION,
    interface: { name: "review_change", version: "1", digest: DIGEST } };
const PINS = { review: PIN, helper: { name: "local-helper", package: null, version: null, packageId: null } };
const TEST = {
    notice: "TEST — scripts run normally; workflow tools are mocked.", agentMode: "real",
    agentNotice: "Agent steps run real agent sessions: they spend model tokens and their results vary as a model's do.",
    agentPins: { review: { ...PIN, revision: TESTED_REVISION } }, scenario: null, testedRevision: 1, stale: false, virtualClock: null,
    interceptions: [], coverage: { unanswered: [] },
};

const published = (pins = PINS) => readModel({ graph, definition: { publishedAgentPins: pins } });
/** A test run of `revision` (the graph shows revision 1), with the publication's pins beside it. */
const tested = (test, revision = 1) => readModel({ graph, definition: { currentRevision: revision, publishedAgentPins: PINS },
    run: { mode: "test", test }, runs: [{ runId: RUN, mode: "test", status: "running", revision, outcome: null }] });
const nodeOf = (model, id) => projectWorkflow({ readModel: model }).nodes.find(node => node.id === id);
const rowsOf = (model, id = "review") => workflowAgentBindingRows(nodeOf(model, id).binding);

test("a published revision's agent state shows the interface it names and what publication pinned: the package revision and the interface's digest", () => {
    const projection = projectWorkflow({ readModel: published() });
    const review = projection.nodes.find(node => node.id === "review");
    assert.deepEqual(review.binding, { interface: "review_change@1", pinnedBy: "publication", mocked: false,
        pin: { name: "code-reviewer", package: "review-kit", version: "1.2.0", revision: REVISION, interface: { ref: "review_change@1", digest: DIGEST } } });
    // Review 18:45Z: no hash in a value; the exact revision and digest are each row's tooltip (its third part).
    assert.deepEqual(workflowAgentBindingRows(review.binding), [
        ["Interface", "review_change@1"],
        ["Pinned", "review-kit 1.2.0", `revision ${REVISION}`],
        ["Interface fingerprint", "review_change@1", `digest ${DIGEST}`],
    ]);
    // A deployment agent is pinned by name; an inline prompt has nothing to pin.
    assert.deepEqual(rowsOf(published(), "helper"), [["Pinned", "local-helper · deployment agent"]]);
    const inline = projection.nodes.find(node => node.id === "inline");
    assert.equal("binding" in inline, false);
    assert.equal(workflowAgentTask(inline), "Inline prompt");
    assert.equal(workflowAgentTask(review), "code-reviewer · review-kit 1.2.0");
    // The portal's details say the same.
    const html = renderToStaticMarkup(React.createElement(WorkflowNodeContent, { tab: "details", selected: review, nodes: projection.nodes, select: () => {} }));
    for (const text of ["code-reviewer · review-kit 1.2.0", "Interface", "review_change@1", "Pinned", "review-kit 1.2.0", "Interface fingerprint"]) {
        assert.ok(html.includes(text), text);
    }
    assert.ok(!html.includes("0123456789ab") && !html.includes("fedcba987654"), "no hash where a person reads it");
});

test("a test run shows its own pins when it tested the graph's revision, none for another revision, and a mocked test says its agent is mocked", () => {
    assert.deepEqual(rowsOf(tested(TEST)), [
        ["Interface", "review_change@1"],
        ["Pinned for this test", "review-kit 1.2.0", `revision ${TESTED_REVISION}`],
        ["Interface fingerprint", "review_change@1", `digest ${DIGEST}`],
    ]);
    // A test of another revision: its pins are not those of the states drawn, and the publication's are not this run's.
    assert.deepEqual(rowsOf(tested(TEST, 2)), [["Interface", "review_change@1"]]);
    assert.deepEqual(rowsOf(tested({ ...TEST, agentMode: "mocked", agentPins: null })), [
        ["Interface", "review_change@1"],
        ["Agent", "Mocked", "The parent or the test's answers give its result"],
    ]);
});

test("a draft shows only the interface it names; an older or malformed pin shows what it holds, never a guessed revision or digest", () => {
    const draft = readModel({ graph, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null }, noRun: true });
    assert.deepEqual(nodeOf(draft, "review").binding, { interface: "review_change@1", pinnedBy: null, mocked: false, pin: null });
    assert.deepEqual(rowsOf(draft), [["Interface", "review_change@1"]]);
    // A publication made before revisions and interfaces were pinned.
    const older = published({ review: { name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1" } });
    assert.deepEqual(rowsOf(older), [
        ["Interface", "review_change@1"], ["Pinned", "review-kit 1.2.0"], ["Interface fingerprint", "Not pinned"],
    ]);
    const malformed = published({ review: { package: "review-kit", version: "1.2.0", revision: "not-a-hash",
        interface: { name: "review_change", version: "1", digest: "short" } } });
    assert.deepEqual(rowsOf(malformed), [
        ["Interface", "review_change@1"], ["Pinned", "review-kit 1.2.0"], ["Interface fingerprint", "Not pinned"],
    ]);
    assert.deepEqual(rowsOf(published("corrupt")), [["Interface", "review_change@1"]]);
    assert.deepEqual(rowsOf(published({ review: "corrupt" })), [["Interface", "review_change@1"]]);
});

function harness(view) {
    const calls = [];
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return view.readModel; },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return { controller, store, calls };
}
const detailTexts = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);

test("the TUI's workflow view shows the agent, its interface and its pin as the portal does, reading only", async () => {
    const live = harness({ readModel: published(), readModelRunId: null });
    await live.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const lines = detailTexts(live.store);
    for (const text of ["Agent: code-reviewer · review-kit 1.2.0", "Interface: review_change@1",
        "Pinned: review-kit 1.2.0", "Interface fingerprint: review_change@1"]) {
        assert.ok(lines.includes(text), `${text}\n${lines.join("\n")}`);
    }
    assert.ok(live.calls.every(call => call[0] === "readWorkflow"));

    const mocked = harness({ selectedRunId: RUN, readModel: tested({ ...TEST, agentMode: "mocked", agentPins: null }), readModelRunId: RUN });
    await mocked.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const mockedLines = detailTexts(mocked.store);
    assert.ok(mockedLines.includes("Agent: Mocked"), mockedLines.join("\n"));
    assert.ok(!mockedLines.some(line => line.startsWith("Pinned")), mockedLines.join("\n"));
});
