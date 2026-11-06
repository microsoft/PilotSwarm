/**
 * Workflow Simplified, owner feedback 2026-11-06T13:43Z: the Workflow tab's header and toolbar buttons are icons whose
 * tooltip reads "name — explanation" (F1), and the count of a definition's Workflows is in the Workflow picker, not
 * beside the definition (F2): one group labelled with the count, newest first, each option "#7 · Running · 05:38:01",
 * and the closed picker "#7 of 7".
 *
 * Run: node --test ui/core/test/workflow-simplified-icons-picker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    workflowElapsedText, workflowPickerFace, workflowPickerGroupLabel, workflowPickerOptionLabel, workflowRunTimes, workflowTabButtonTip,
} from "../src/workflow-owner.js";

test("the Workflow picker's group says the count, each option its number, state and start, and the closed picker '#n of count'", () => {
    assert.equal(workflowPickerGroupLabel(7), "7 Workflows");
    assert.equal(workflowPickerGroupLabel(1), "1 Workflow");
    assert.equal(workflowPickerGroupLabel(undefined), "0 Workflows");
    assert.equal(workflowPickerOptionLabel({ number: 7, state: "Running", started: "05:38:01" }), "#7 · Running · 05:38:01");
    // A part not known yet is left out, never shown as a placeholder.
    assert.equal(workflowPickerOptionLabel({ number: 3, state: "Completed" }), "#3 · Completed");
    assert.equal(workflowPickerOptionLabel({ number: 2, state: null, started: "" }), "#2");
    assert.equal(workflowPickerFace(7, 7), "#7 of 7");
    assert.equal(workflowPickerFace(2, 7), "#2 of 7");
    assert.equal(workflowPickerFace(1, 0), "#1");
});

test("a Workflow's start and elapsed time come from its live run's own events; a test run's are left out", () => {
    const at = seconds => new Date(Date.UTC(2026, 10, 6, 13, 38, seconds)).toISOString();
    const events = [
        { eventType: "workflow.started", createdAt: at(1), data: { runId: "run-test", mode: "test" } },
        { eventType: "workflow.started", createdAt: at(2), data: { runId: "run-1" } },
        { eventType: "workflow.completed", createdAt: at(50), data: { runId: "run-test", mode: "test" } },
    ];
    const running = workflowRunTimes(events, "run-1", Date.parse(at(2)) + 165_000);
    assert.equal(running.started, Date.parse(at(2)));
    assert.equal(workflowElapsedText(running.took), "2:45", "still running: up to now");
    const ended = workflowRunTimes([...events, { eventType: "workflow.failed", createdAt: at(32), data: { runId: "run-1" } }], "run-1");
    assert.equal(workflowElapsedText(ended.took), "0:30");
    assert.deepEqual(workflowRunTimes([], null), { started: null, took: null });
    assert.equal(workflowElapsedText(3_725_000), "1:02:05");
    assert.equal(workflowElapsedText(null), null);
});

test("each icon button of the Workflow tab has its explanation, for a tooltip that reads 'name — explanation'", () => {
    assert.equal(workflowTabButtonTip("pause"), "no new step starts; running steps finish");
    assert.equal(workflowTabButtonTip("start", { number: 8 }), "start Workflow #8 from this definition");
    assert.equal(workflowTabButtonTip("start-another", { name: "watch-v2", number: 3 }), "ask the chat to start watch-v2 #3 from this definition");
    assert.equal(workflowTabButtonTip("save", { revision: 4 }), "save as a new revision after revision 4");
    for (const kind of ["definition", "workflows", "start", "start-another", "yaml", "compare", "pause", "resume", "stop", "save", "discard"]) {
        const tip = workflowTabButtonTip(kind);
        assert.ok(typeof tip === "string" && tip.length > 0 && tip.length <= 80, `${kind}: a short explanation`);
        assert.equal(tip[0], tip[0].toLowerCase(), `${kind}: it follows "name — "`);
    }
    assert.equal(workflowTabButtonTip("nothing"), null);
});

// The Workflow tab as rendered: a session with two Workflows of watch-v2, #1 running (its person may pause and stop it)
// and #2 failed; the tab shows #1.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";

const STATES = [{ id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["changed"], next: { changed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" }];
const modelOf = (workflowId, runId, status, extra = {}) => ({
    workflowId, definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1 },
    revision: { revision: 1, definitionHash: "h1", valid: true, name: "watch-v2", diagnostics: [] },
    graph: { revision: 1, initial: "poll", states: STATES },
    runs: [{ runId, mode: "live", status, revision: 1, outcome: null }],
    run: { runId, mode: "live", status, outcome: null, nodeExecutions: [], inbox: [], outbox: [], kv: "{}", kvRevision: 1 },
    ...extra,
});
function mountTab() {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const at = Date.now();
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "owner", title: "Release triage agent", createdAt: at - 60_000, updatedAt: at },
        { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: watch-v2", status: "running", parentSessionId: "owner", createdAt: at - 50_000, updatedAt: at },
        { sessionId: "wf-2", sessionKind: "workflow", title: "Workflow: watch-v2", status: "failed", parentSessionId: "owner", createdAt: at - 40_000, updatedAt: at },
    ] });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: modelOf("wf-1", "run-1", "running", {
        personCommands: { operations: ["pause", "resume", "stop", "cancel"], viewer: { allowed: true }, run: { runId: "run-1", stop: true } } }),
        readModelRunId: null } });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf-2", view: { readModel: modelOf("wf-2", "run-2", "failed"), readModelRunId: null } });
    store.dispatch({ type: "sessions/selected", sessionId: "owner", workflowRowId: "wf-1" });
    return new PilotSwarmUiController({ store, transport: {} });
}
const buttonsOf = (html, from, to) => {
    const part = html.slice(html.indexOf(from), to ? html.indexOf(to, html.indexOf(from)) : undefined);
    return [...part.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, inner]) => ({
        name: /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? null, pressed: /aria-pressed="([^"]*)"/.exec(attributes)?.[1] ?? null,
        tip: /data-title="([^"]*)"/.exec(attributes)?.[1] ?? null, words: inner.replace(/<[^>]*>/g, "").trim() }));
};

test("the Workflow tab's header and toolbar buttons are named icons with tooltips, and the Workflow picker holds the count", () => {
    const html = renderToStaticMarkup(React.createElement(WorkflowTab, { controller: mountTab(), mobile: false }));
    const head = buttonsOf(html, "<header class=\"ps-wf-tab-head\"", "</header>");
    assert.deepEqual(head.map(button => [button.name, button.pressed, button.words]),
        [["Definition", "false", ""], ["Workflows", "true", ""]], "two icon toggles, no count beside the definition");
    assert.deepEqual(head.map(button => button.tip), ["the definition&#x27;s graph", "every Workflow started from this definition"]);
    const bar = buttonsOf(html, "<div class=\"ps-wf-bar is-run\"", "<div class=\"ps-wf-main\"");
    assert.deepEqual(bar.map(button => [button.name, button.words, button.tip]), [
        ["Pause", "", "no new step starts; running steps finish"],
        ["Stop…", "", "choose: let started steps finish, or cancel now"],
    ]);
    // The definition picker: the definition and its revision, no count.
    assert.match(html, /<option value="watch-v2" selected="">watch-v2 · revision 1<\/option>/);
    // The Workflow picker: one group that says how many, newest first; closed, "#1 of 2".
    assert.match(html, /<span class="ps-workflow-input ps-wf-picker-face" aria-hidden="true">#1 of 2<\/span>/);
    assert.match(html, /<optgroup label="2 Workflows"><option value="wf-2">#2 · Failed<\/option><option value="wf-1"[^>]*>#1 · Running<\/option><\/optgroup><option value="__all__">All Workflows<\/option>/);
    // Desktop keeps its meta line.
    assert.match(html, /<span class="ps-wf-bar-text">revision 1<\/span>/);
});

test("on a phone the Workflow tab has no meta line: the state carries the time taken, its tooltip the start and revision", () => {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const before = globalThis.window;
    // The portal's phone query (600 px or less) matches.
    globalThis.window = { matchMedia: query => ({ matches: query === "(max-width: 600px)", addEventListener() {}, removeEventListener() {} }) };
    try {
        const phone = renderToStaticMarkup(React.createElement(WorkflowTab, { controller: mountTab(), mobile: true }));
        assert.match(phone, /^<section class="ps-wf-tab is-mobile is-phone"/);
        assert.ok(!phone.includes("ps-wf-bar-text"), "no meta line");
        // No events read here: no time taken yet, and the revision is in the state's tooltip.
        assert.match(phone, /<span class="ps-wf-state is-running" data-state="running" title="revision 1">Running<\/span>/);
        // A wide window in the mobile layout (601 to 920 px) is not a phone: it keeps the meta line.
        globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
        const tablet = renderToStaticMarkup(React.createElement(WorkflowTab, { controller: mountTab(), mobile: true }));
        assert.match(tablet, /^<section class="ps-wf-tab is-mobile"/);
        assert.match(tablet, /<span class="ps-wf-bar-text">revision 1<\/span>/);
    } finally {
        if (hadWindow) globalThis.window = before; else delete globalThis.window;
    }
});
