// Owner batch 5 (g-03): the workflow pane shows its header and the graph; the step log, the run's activity, the notices
// and a test run's calls each open from their own icon button (aria-label the plain name, aria-expanded, aria-controls),
// closed by default and remembered in the workflow's view state. Notices and Test calls carry a count.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-pane-panels.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowV2NoticeLevel, workflowV2OpenCalls, workflowV2ShownNotices, projectWorkflowV2 } from "../src/workflow-v2-view.js";
import { workflowStepLogLines, WORKFLOW_STEP_LOG_EMPTY_TEXT, WORKFLOW_STEP_LOG_LOADING_TEXT } from "../src/workflow-sessions.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { readModel, done } from "./workflow-v2-fixtures.mjs";

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModelRunId: null, ...view } });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}
const LOG = React.createElement("p", { className: "fake-log" }, "LOG LINES");
const main = ({ controller }) => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, log: LOG, icon: null }));

/** A live run that ended (its activity says why) on a published revision with a newer draft (one notice). */
const ended = () => readModel({ revision: { revision: 2 }, run: { status: "completed", outcome: "succeeded", terminalState: "done" },
    nodeExecutions: [done("poll", 1, "changed"), done("notify", 1, "sent"), done("await_ack", 1, "received")] });
const DRAFT_NOTICE = "Showing published revision 1. Revision 2 is a newer draft.";

/** A running test run with two held calls, one of them waiting for an answer. */
const testing = () => readModel({ run: { mode: "test", test: {
    notice: "TEST — scripts run normally; workflow tools are mocked.", agentMode: "mocked", scenario: null, testedRevision: 1, stale: false,
    virtualClock: { now: "9000-01-01T01:00:00.000Z", elapsedSeconds: 3600 },
    interceptions: [
        { interceptionId: "nx-poll-1/call-1", operation: "tool.call", tool: "read_build", stateId: "poll", state: "responded",
            arguments: "{}", responseSchema: { type: "object" }, response: { kind: "success", disposition: "fixture" } },
        { interceptionId: "nx-notify-1/send", operation: "send", tool: null, stateId: "notify", state: "awaiting_parent",
            arguments: "{}", responseSchema: { type: "object" }, response: null },
    ],
    coverage: { unanswered: ["nx-notify-1/send"] },
} } });

const tool = (html, name) => html.match(new RegExp(`<button [^>]*aria-label="${name}"[^>]*>`))?.[0] ?? null;

test("the pane opens with the header and the graph only: no step log, run activity, notices or test calls", () => {
    const html = main(mount({ readModel: ended() }));
    assert.ok(html.includes("aria-label=\"Workflow graph\""));
    assert.ok(!html.includes("class=\"ps-workflow-log\"") && !html.includes("LOG LINES") && !html.includes("Resize the step log"));
    assert.ok(!html.includes("<section class=\"ps-workflow-run-activity\"") && !html.includes("Why it ended"));
    assert.ok(!html.includes("class=\"ps-workflow-banners\"") && !html.includes(DRAFT_NOTICE));
    // Their buttons are there, closed; Test calls only with a test run.
    for (const name of ["Step log", "Run activity", "Notices"]) assert.match(tool(html, name), /aria-expanded="false"/, name);
    assert.equal(tool(html, "Test calls"), null);
    assert.match(html, /style="grid-template-rows:minmax\(150px, 1fr\)"/, "the graph takes the whole split");
});

test("each button opens its own panel, named by the button's aria-controls", () => {
    const html = main(mount({ readModel: ended(), logOpen: true, activityOpen: true, noticesOpen: true }));
    const panel = name => {
        const button = tool(html, name);
        assert.match(button, /aria-expanded="true"/, name);
        const id = button.match(/aria-controls="([^"]+)"/)?.[1];
        assert.ok(id && html.includes(`id="${id}"`), `${name} names its panel`);
        return id;
    };
    const log = panel("Step log");
    assert.match(html, new RegExp(`<div id="${log}" class="ps-workflow-log"><p class="fake-log">LOG LINES</p></div>`));
    assert.ok(html.includes("aria-label=\"Resize the step log\""), "the step log keeps its divider");
    assert.match(html, /class="ps-workflow-split is-log-open" style="grid-template-rows:minmax\(150px, 1fr\) 12px 210px"/);
    panel("Run activity");
    assert.ok(html.includes("<section class=\"ps-workflow-run-activity\""));
    assert.ok(html.includes("Why it ended: It reached &#x27;done&#x27; (succeeded)."));
    panel("Notices");
    assert.ok(html.includes("class=\"ps-workflow-banners\"") && html.includes(DRAFT_NOTICE));
});

test("Notices counts its notices with the most serious tint; Test calls counts the calls that wait, and opens them with the clock", () => {
    const published = main(mount({ readModel: ended() }));
    assert.match(published, /aria-label="Notices" data-title="1 notice about this workflow and its run\."[^>]*>.*?<span class="ps-workflow-tool-badge" data-level="info" aria-hidden="true">1<\/span>/);
    const view = { readModel: testing() };
    const html = main(mount(view));
    assert.match(html, /aria-label="Notices" data-title="3 notices about this workflow and its run\."[^>]*>.*?<span class="ps-workflow-tool-badge" data-level="warning" aria-hidden="true">3<\/span>/);
    assert.match(html, /aria-label="Test calls" data-title="1 call waits for an answer\."[^>]*>.*?<span class="ps-workflow-tool-badge" data-level="warning" aria-hidden="true">1<\/span>/);
    assert.ok(!html.includes("Calls (2)"));
    const open = main(mount({ ...view, testCallsOpen: true }));
    assert.ok(open.includes("Calls (2)"), "the held calls");
    assert.match(tool(open, "Test calls"), /aria-expanded="true"/);
});

test("opening and closing a panel is the workflow's view state, kept per workflow", () => {
    const harness = mount({ readModel: ended() });
    harness.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { logOpen: true } });
    assert.equal(harness.store.getState().ui.workflowViews.wf.logOpen, true);
    assert.ok(main(harness).includes("LOG LINES"));
    harness.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { logOpen: false } });
    assert.ok(!main(harness).includes("LOG LINES"));
});

test("the counts and tint come from the notices and the test's calls", () => {
    assert.deepEqual(workflowV2ShownNotices([{ level: "info", text: "a" }, null, { level: "warning", text: "" }, { text: "b" }]),
        [{ level: "info", text: "a" }, { text: "b" }]);
    assert.deepEqual(workflowV2ShownNotices(undefined), []);
    assert.equal(workflowV2NoticeLevel([{ level: "info" }, { level: "warning" }]), "warning");
    assert.equal(workflowV2NoticeLevel([{ level: "info" }, { level: "error" }, { level: "warning" }]), "error");
    assert.equal(workflowV2NoticeLevel([{ level: "info" }]), "info");
    assert.equal(workflowV2NoticeLevel([]), null);
    assert.equal(workflowV2OpenCalls(null), 0);
    assert.equal(workflowV2OpenCalls({ coverage: { unanswered: ["a", "b"] }, interceptions: [] }), 2);
    assert.equal(workflowV2OpenCalls({ interceptions: [{ state: "awaiting_parent" }, { state: "responded" }, null] }), 1);
});

// Batch 5 (g-07): "No run yet" is said once, by the run's status in the header.
test("with no run, 'No run yet' appears once: in the status, not in the notices or a run picker", () => {
    const projected = projectWorkflowV2({ readModel: readModel({ noRun: true }) });
    assert.deepEqual(projected.banners.filter(banner => banner.code === "no-run").map(banner => banner.text), ["No run yet."], "the terminal still lists it");
    assert.deepEqual(workflowV2ShownNotices(projected.banners), []);
    const html = main(mount({ readModel: readModel({ noRun: true }), noticesOpen: true }));
    assert.equal(html.match(/No runs? yet/g)?.length, 1);
    assert.match(html, /<span class="ps-workflow-status">No run yet<\/span>/);
    assert.ok(!html.includes("aria-label=\"Workflow run\""), "no run picker until a run exists");
    assert.equal(tool(html, "Notices"), null, "nothing else to say, so no Notices button");
    // Other runs: the notice that names them stays.
    const others = main(mount({ readModel: readModel({ noRun: true, runs: [{ runId: "old", mode: "test", status: "completed", revision: 1, outcome: "succeeded" }] }),
        noticesOpen: true }));
    assert.ok(others.includes("No live run is selected; 1 other run exists."));
    assert.ok(others.includes("aria-label=\"Workflow run\""));
});

// Batch 5 (g-06): an empty step log says so in words, never with the splash art or "No messages yet."
test("an empty step log says 'No step output yet.', while loading says so, and keeps a failed read's words", () => {
    const splash = { kind: "markup", value: "P I L O T S W A R M", splashAlt: null };
    const words = [{ text: WORKFLOW_STEP_LOG_EMPTY_TEXT, color: "gray" }];
    assert.deepEqual(workflowStepLogLines([splash], { chat: [], loadState: "loaded" }), words);
    assert.deepEqual(workflowStepLogLines([{ text: "No messages yet.", color: "gray" }], null), words);
    assert.deepEqual(workflowStepLogLines([splash, [{ text: "", color: null }]], { chat: [] }), words);
    assert.deepEqual(workflowStepLogLines([splash], { chat: [], loadState: "loading" }), [{ text: WORKFLOW_STEP_LOG_LOADING_TEXT, color: "gray" }]);
    const failed = [{ text: "Could not load this conversation. Select the session again to retry.", color: "gray" }];
    assert.equal(workflowStepLogLines(failed, { chat: [], loadState: "failed" }), failed);
    // A warning the transcript shows without a message follows the words; a log with output is left as it is.
    const warning = [{ text: "⚠ The session ended with an error.", color: "red" }];
    assert.deepEqual(workflowStepLogLines([splash, warning], { chat: [] }), [...words, warning]);
    const output = [[{ text: "Step 1: poll → changed", color: "green" }]];
    assert.equal(workflowStepLogLines(output, { chat: [{ id: "m1" }] }), output);
});
