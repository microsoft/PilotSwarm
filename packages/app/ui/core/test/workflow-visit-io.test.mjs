/**
 * A node's details show the visit's input and output, and follow the timeline (owner 2026-11-20: "For node details in a
 * running graph when I click on node details I want to see the inputs and outputs for that iteration. These need to change
 * as I time travel back and forth too."). A read row's inputPreview reaches the visit; the visit a node's details show is
 * the replayed visit on its own node, else the node's latest visit by the moment shown, else (live) its current visit; its
 * output is shown as recorded, labelled when it was recorded after the moment shown, and never an earlier visit's in its
 * place. A Decision visit's moment says no result before it ended, and its semantic summary reads whole after its row is
 * normalized. The TUI's [ ] show each visit's input beside its output, in the same words; f reads a cut input whole.
 * The mounted cases are the browser specs "visit input and output" (workflow-tab.spec.mjs) and decision-node.spec.mjs.
 *
 * Run: node --test packages/app/ui/core/test/workflow-visit-io.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflow, workflowExecutionOfRow, workflowExecutionsAt, workflowReplayFrames } from "../src/workflow-view.js";
import { workflowDecisionOutputSummary, workflowDecisionSummary } from "../src/workflow-decision.js";
import {
    WORKFLOW_VISIT_WORDS, workflowDetailsVisit, workflowRecordedVisit, workflowVisitIo, workflowVisitValueText, workflowWholeInput,
} from "../src/workflow-visit-io.js";
import { RunNodePanel } from "../../react/src/workflow-tab.js";
import { RUN, done, readModel, row } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";
const BASE = Date.parse("2026-11-07T15:00:00.000Z");
const T = seconds => new Date(BASE + seconds * 1000).toISOString();
const NOW = BASE + 3_600_000;
const q = text => text.replaceAll("\"", "&quot;");

// poll 1 (input n 1) -> pause 1 -> poll 2 (input n 2) -> done: each visit with its own input and output.
const LOOP = readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" }, nodeExecutions: [
    done("poll", 1, "unchanged", { enteredAt: T(0), endedAt: T(10), inputPreview: "{\"n\":1}", outputPreview: "{\"seen\":1}" }),
    done("pause", 1, "elapsed", { enteredAt: T(10), endedAt: T(40), inputPreview: "{\"seen\":1}", outputPreview: "null" }),
    done("poll", 2, "changed", { enteredAt: T(40), endedAt: T(50), inputPreview: "{\"n\":2}", outputPreview: "{\"seen\":2}" }),
    done("done", 1, "succeeded", { enteredAt: T(50), endedAt: T(50), inputPreview: "{\"seen\":2}" }),
] });
const controller = { dispatch() {}, loadSession: async () => {}, selectWorkflowExecution() {}, loadWorkflowExecutionValue: async () => {} };

test("a read row's inputPreview reaches its visit, live and in a replay's moment (where its result does not)", () => {
    assert.equal(workflowExecutionOfRow(row("poll", 1, "pending", { inputPreview: "{\"a\":1}" })).inputPreview, "{\"a\":1}");
    assert.equal(workflowExecutionOfRow(row("poll", 1, "pending", { inputPreview: { a: 1 } })).inputPreview, undefined);
    assert.equal(workflowExecutionOfRow(row("poll", 1, "pending")).inputPreview, undefined);
    const live = projectWorkflow({ readModel: LOOP });
    assert.deepEqual(live.allExecutions.map(item => item.inputPreview), ["{\"n\":1}", "{\"seen\":1}", "{\"n\":2}", "{\"seen\":2}"]);
    const [first] = workflowExecutionsAt(live.allExecutions, BASE);
    assert.deepEqual([first.status, first.inputPreview, first.outputPreview], ["pending", "{\"n\":1}", undefined]);
});

test("the visit shown follows the timeline: the replayed visit on its node, else the latest by then; its input and output change with it", () => {
    const live = projectWorkflow({ readModel: LOOP });
    const frames = workflowReplayFrames(live.allExecutions);
    assert.deepEqual(frames.map(frame => frame.nodeExecutionId), ["nx-poll-1", "nx-pause-1", "nx-poll-2", "nx-done-1"]);
    const shown = (index, nodeId = "poll") => {
        const frame = index === null ? null : frames[index];
        const projection = frame ? projectWorkflow({ readModel: LOOP, asOf: frame.atMs }) : live;
        const node = projection.nodes.find(item => item.id === nodeId);
        const visit = workflowDetailsVisit(node, { frame });
        return workflowVisitIo(node, visit, { recorded: workflowRecordedVisit(live.allExecutions, visit), atMs: frame?.atMs ?? null, now: NOW });
    };
    // Poll's first visit, at its own moment: running then; its input, and its output as it was recorded later, said so.
    const one = shown(0);
    assert.equal(one.id, "nx-poll-1");
    assert.equal(one.header, "Visit 1 of 1 · entered 15:00:00 · running");
    assert.deepEqual(one.input, { text: "{\n  \"n\": 1\n}", truncated: false });
    assert.equal(one.output.kind, "output");
    assert.equal(one.output.text, "{\n  \"seen\": 1\n}");
    assert.equal(one.output.recordedAfter, "Recorded 2026-11-07 15:00:10 UTC, after this point");
    // Step on: pause's moment; poll (another node) shows its latest visit by then, which had ended.
    const later = shown(1);
    assert.equal(later.id, "nx-poll-1");
    assert.equal(later.header, "Visit 1 of 1 · entered 15:00:00 · ended 15:00:10");
    assert.equal(later.output.recordedAfter, null);
    // Pause, the replayed node: its own visit.
    assert.equal(shown(1, "pause").id, "nx-pause-1");
    assert.equal(shown(1, "pause").output.text, WORKFLOW_VISIT_WORDS.noOutput);
    // Step on: poll's second visit, its own input and output, never the first visit's.
    const two = shown(2);
    assert.equal(two.header, "Visit 2 of 2 · entered 15:00:40 · running");
    assert.equal(two.input.text, "{\n  \"n\": 2\n}");
    assert.equal(two.output.text, "{\n  \"seen\": 2\n}");
    assert.equal(two.output.recordedAfter, "Recorded 2026-11-07 15:00:50 UTC, after this point");
    // Step back: the first visit again.
    assert.equal(shown(1).input.text, "{\n  \"n\": 1\n}");
    // Live: the current visit, ended, with nothing recorded after the moment shown.
    const now = shown(null);
    assert.equal(now.header, "Visit 2 of 2 · entered 15:00:40 · ended 15:00:50");
    assert.equal(now.output.recordedAfter, null);
    // A node not reached by the moment shown has no visit.
    assert.equal(shown(0, "done"), null);
});

test("the Node panel shows the replayed visit's Input and Output, not the previous visit's result, and follows the step", () => {
    const live = projectWorkflow({ readModel: LOOP });
    const frames = workflowReplayFrames(live.allExecutions);
    const render = (frame, nodeId = "poll") => {
        const projection = frame ? projectWorkflow({ readModel: LOOP, asOf: frame.atMs }) : live;
        const selected = projection.nodes.find(node => node.id === nodeId);
        return renderToStaticMarkup(React.createElement(RunNodePanel, { controller, selected, replayFrame: frame, visits: live.allExecutions,
            child: { sessionId: "wf-1", view: {}, projection: live, nodes: projection.nodes } }));
    };
    const two = render(frames[2]);
    assert.match(two, /aria-label="Visit" data-visit="nx-poll-2"/);
    assert.ok(two.includes("Visit 2 of 2 · entered "), two);
    assert.ok(two.includes(q("\"n\": 2")) && two.includes(q("\"seen\": 2")), two);
    assert.ok(two.includes("Recorded 2026-11-07 15:00:50 UTC, after this point"), two);
    // The first visit's result is not shown at the second visit's own moment (it was, as "Result", before).
    assert.ok(!two.includes(q("\"seen\": 1")) && !two.includes(q("\"n\": 1")), two);
    assert.ok(!two.includes("Result · visit"), two);
    assert.match(two, /data-field="visit-output" data-output="output" data-fact="result"/);
    // Stepping back to the first visit's moment: its own input and output.
    const one = render(frames[0]);
    assert.ok(one.includes(q("\"n\": 1")) && one.includes(q("\"seen\": 1")) && !one.includes(q("\"n\": 2")), one);
    // Live: the latest visit, ended; no recorded-after label, and no result shown twice.
    const now = render(null);
    assert.ok(now.includes(q("\"n\": 2")) && !now.includes("after this point"), now);
    assert.equal([...now.matchAll(/data-fact="result"/g)].length, 1);
});

test("live, a visit chosen for exactly this run and node is the one the Node panel shows, with its own input and output", () => {
    const live = projectWorkflow({ readModel: LOOP });
    const poll = live.nodes.find(node => node.id === "poll");
    const render = selectedExecution => renderToStaticMarkup(React.createElement(RunNodePanel, { controller, selected: poll,
        child: { sessionId: "wf-1", view: { selectedExecution }, projection: live, nodes: live.nodes } }));
    const chosen = render({ runId: live.runId, stateId: "poll", executionId: "nx-poll-1" });
    assert.match(chosen, /aria-label="Visit" data-visit="nx-poll-1"/);
    assert.ok(chosen.includes("Visit 1 of 2 · entered ") && chosen.includes(q("\"n\": 1")) && chosen.includes(q("\"seen\": 1")), chosen);
    assert.ok(!chosen.includes(q("\"n\": 2")) && !chosen.includes(q("\"seen\": 2")), chosen);
    // An ended visit's output is the node's result there: no other result is shown apart.
    assert.equal([...chosen.matchAll(/data-fact="result"/g)].length, 1);
    assert.ok(!chosen.includes("Result · visit"), chosen);
    // Another run's or another node's choice is not this one's: the latest visit.
    assert.match(render({ runId: "run-other", stateId: "poll", executionId: "nx-poll-1" }), /data-visit="nx-poll-2"/);
    assert.match(render({ runId: live.runId, stateId: "pause", executionId: "nx-poll-1" }), /data-visit="nx-poll-2"/);
    assert.match(render(null), /data-visit="nx-poll-2"/);
});

test("live, a visit still running shows its input and no result yet; the latest result stays apart, said as its visit's", () => {
    const running = readModel({ nodeExecutions: [
        done("poll", 1, "unchanged", { enteredAt: T(0), endedAt: T(10), inputPreview: "{\"n\":1}", outputPreview: "{\"seen\":1}" }),
        row("poll", 2, "pending", { enteredAt: T(40), inputPreview: `{"text":"${"x".repeat(495)}…` }),
    ] });
    const projection = projectWorkflow({ readModel: running });
    const poll = projection.nodes.find(node => node.id === "poll");
    const io = workflowVisitIo(poll, workflowDetailsVisit(poll), { now: NOW });
    assert.equal(io.header, "Visit 2 of 2 · entered 15:00:40 · running");
    assert.equal(io.input.truncated, true);
    assert.deepEqual([io.output.kind, io.output.text], ["pending", WORKFLOW_VISIT_WORDS.running]);
    const reads = [];
    const render = executionValues => renderToStaticMarkup(React.createElement(RunNodePanel, { selected: poll,
        controller: { ...controller, loadWorkflowExecutionValue: async (...args) => { reads.push(args); } },
        child: { sessionId: "wf-1", view: { executionValues }, projection, nodes: projection.nodes } }));
    const html = render(null);
    assert.ok(html.includes(WORKFLOW_VISIT_WORDS.running), html);
    assert.ok(html.includes("Start only.") && html.includes(">Show all input</button>"), html);
    assert.match(html, /data-action="whole-input" data-execution="nx-poll-2"/);
    // The latest result (visit 1) apart, said as visit 1's; it is the node's result.
    assert.ok(html.includes("Result · visit 1"), html);
    assert.equal([...html.matchAll(/data-fact="result"/g)].length, 1);
    // The whole input, once read (the same read as the whole output).
    const key = JSON.stringify([RUN, "nx-poll-2"]);
    const loaded = render({ [key]: { runId: RUN, executionId: "nx-poll-2", phase: "loaded", result: null, error: null,
        input: { bytes: 512, whole: true, value: { text: "x".repeat(500) } } } });
    assert.match(loaded, /data-whole-input="value"/);
    assert.ok(loaded.includes("Input · 512 bytes") && loaded.includes(">Show all input again</button>"), loaded);
    assert.deepEqual(workflowWholeInput({ phase: "loaded", input: { bytes: 9, whole: false, limitBytes: 4, preview: "{\"a\"…" } }),
        { kind: "preview", label: "Input", bytes: 9, limitBytes: 4, text: "{\"a\"…" });
    assert.deepEqual(workflowWholeInput({ phase: "loaded", result: null }), { kind: "none" });
    assert.deepEqual(workflowVisitValueText("\"words\""), { text: "\"words\"", truncated: false });
    assert.equal(workflowVisitValueText(undefined), null);
});

const SCORE = { id: "score_ticket", type: "decision", input: "${input}",
    question: { type: "score", instructions: "How severe is this incident?", levels: ["Minor", "Major"] }, next: { scored: "done", failure: "done" } };
const CHOICE = { id: "route_ticket", type: "decision", input: "${input}",
    question: { type: "choice", instructions: "Which team?", criteria: { engineering: "Bugs", billing: "Payments", support: "Access" } },
    confidence: { minimumProbability: 0.8 }, next: { engineering: "done", billing: "done", support: "done", uncertain: "done", failure: "done" } };
const DONE = { id: "done", type: "terminal", outcome: "succeeded" };

test("a Decision visit's own moment says no result yet: its later summary, evidence and attempts are not shown as then", () => {
    const summary = { questionType: "score", outcome: "scored", selection: null, confidence: null, score: 2.37, probabilities: [],
        levels: [{ label: "Minor", probability: 0.4 }, { label: "Major", probability: 0.6 }], policy: null, model: "decision:review", truncated: false };
    const model = readModel({ graph: { revision: 1, initial: "score_ticket", states: [SCORE, DONE] }, nodeExecutions: [
        done("score_ticket", 1, "scored", { winner: "effect", attempts: 2, enteredAt: T(0), endedAt: T(5), inputPreview: "{\"ticket\":\"down\"}",
            outputPreview: JSON.stringify({ ...summary, model: { qualified: "decision:review" } }), decisionSummary: summary,
            decisionInference: [{ nodeExecutionId: "nx-score_ticket-1", attempt: 2, usageKnown: true, usageState: "known" }] }),
    ] });
    const live = projectWorkflow({ readModel: model });
    const frame = workflowReplayFrames(live.allExecutions)[0];
    const then = projectWorkflow({ readModel: model, asOf: frame.atMs }).nodes.find(node => node.id === "score_ticket");
    assert.equal(then.current.status, "pending");
    for (const field of ["decisionSummary", "decisionInference", "attempts", "outputPreview"]) assert.equal(then.current[field], undefined, field);
    const words = workflowDecisionSummary(then, then.current);
    assert.deepEqual([words.outcome, words.score, words.warning, words.text], ["Not run", null, null, "No Decision result yet."]);
    // Live, the same visit says its result and its second provider call.
    const now = live.nodes.find(node => node.id === "score_ticket");
    assert.match(workflowDecisionSummary(now, now.current).text, /^Scored · score 2\.37/);
    assert.equal(workflowDecisionSummary(now, now.current).warning, "A second provider call was used.");
    // The panel at that moment: Running, no score fact; the visit's Output is its semantic result, recorded after this point.
    const html = renderToStaticMarkup(React.createElement(RunNodePanel, { controller, selected: then, replayFrame: frame, visits: live.allExecutions,
        child: { sessionId: "wf-1", view: {}, projection: live, nodes: [then] } }));
    assert.ok(html.includes("Running"), html);
    assert.ok(!html.includes("data-fact=\"decision-score\""), html);
    assert.ok(!html.includes("A second provider call was used."), html);
    assert.ok(html.includes("Decision result") && html.includes("Scored · score 2.37 · Minor 40% · Major 60%"), html);
    assert.ok(html.includes("Recorded 2026-11-07 15:00:05 UTC, after this point"), html);
    assert.ok(html.includes(q("\"ticket\": \"down\"")), html);
    assert.ok(!html.includes("questionType") && !html.includes("policy"), "the raw output is never shown");
});

test("a Decision summary normalized from its read row reads whole again: choice and yes/no keep their result when the preview is cut", () => {
    const server = { questionType: "choice", outcome: "uncertain", selection: "engineering", confidence: 0.75,
        probabilities: [{ label: "engineering", probability: 0.75 }, { label: "billing", probability: 0.125 }, { label: "support", probability: 0.125 }],
        levels: [], score: null, policy: { minimumProbability: 0.8, uncertain: true }, model: "decision:default", truncated: false };
    const once = workflowDecisionOutputSummary(server);
    assert.deepEqual(workflowDecisionOutputSummary(once), once, "its own shape is taken as it is");
    const execution = workflowExecutionOfRow(done("route_ticket", 1, "uncertain", { decisionSummary: server, outputPreview: `{"questionType":"choice","x":"${"y".repeat(480)}…` }));
    const node = projectWorkflow({ readModel: readModel({ graph: { revision: 1, initial: "route_ticket", states: [CHOICE, DONE] },
        nodeExecutions: [done("route_ticket", 1, "uncertain", { decisionSummary: server })] }) }).nodes.find(item => item.id === "route_ticket");
    const words = workflowDecisionSummary(node, execution);
    assert.equal(words.text, "Uncertain · selected engineering · 75% confidence · threshold 80% · engineering 75% · billing 12.5% · support 12.5%");
    assert.equal(words.needsWholeValue, false);
    const noul = { ...server, questionType: "noul", outcome: "yes", selection: "yes", confidence: 0.9,
        probabilities: [{ label: "yes", probability: 0.9 }, { label: "no", probability: 0.1 }], policy: { minimumProbability: null, uncertain: false } };
    const twice = workflowDecisionOutputSummary(workflowDecisionOutputSummary(noul));
    assert.deepEqual([twice.selection, twice.threshold, twice.uncertain], ["yes", null, false]);
    // A bounded summary that kept none of its probabilities still says its selection; the whole value is offered.
    const cut = workflowDecisionSummary(node, workflowExecutionOfRow(done("route_ticket", 1, "uncertain",
        { decisionSummary: { ...server, probabilities: [], truncated: true } })));
    assert.equal(cut.text, "Uncertain · selected engineering · 75% confidence · threshold 80%");
    assert.equal(cut.needsWholeValue, true);
});

/** The workflow session wf on the TUI with `initial` loaded; readWorkflow answers with `read`. */
function harness(initial, read = async () => initial) {
    const calls = [];
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async (...args) => { calls.push(args); return read(...args); } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const ui = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: null, readModel: initial, readModelRunId: null } });
    return { controller: ui, store, calls };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);

test("the TUI's [ ] show each visit's input beside its output, in the portal's words; f reads a running visit's cut input whole", async () => {
    const cut = `{"text":"${"word ".repeat(98)}…`;
    const model = readModel({ nodeExecutions: [
        done("poll", 1, "unchanged", { inputPreview: "{\"n\":1}", outputPreview: "{\"seen\":1}" }),
        done("pause", 2, "elapsed", { inputPreview: "{\"seen\":1}" }),
        done("poll", 3, "changed", { inputPreview: "{\"n\":2}", outputPreview: "{\"seen\":2}" }),
        row("poll", 5, "pending", { inputPreview: cut }),
    ] });
    const h = harness(model, async (_id, options) => (options?.executionId ? { workflowId: "wf-1", runId: RUN,
        execution: { nodeExecutionId: options.executionId, result: null, input: { bytes: 511, whole: true, value: { text: "x".repeat(500) } } } } : model));
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    h.store.dispatch({ type: "ui/modal", modal: { ...h.store.getState().ui.modal, selectedNodeId: "poll" } });
    let lines = details(h.store);
    // The latest result's visit, its input beside its output.
    assert.ok(lines.includes("Result of visit 3 · latest · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.includes("  Input: {\"n\":2}") && lines.includes("  Output: {\"seen\":2}"), lines.join("\n"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_OLDER_EXECUTION);
    lines = details(h.store);
    assert.ok(lines.includes("  Input: {\"n\":1}") && lines.includes("  Output: {\"seen\":1}"), lines.join("\n"));
    assert.ok(!lines.includes("  Input: {\"n\":2}"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEWER_EXECUTION);
    lines = details(h.store);
    assert.ok(lines.includes("  Input: {\"n\":2}") && !lines.includes("  Input: {\"n\":1}"), lines.join("\n"));
    // The visit still running: its input, cut short, and no result yet.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEWER_EXECUTION);
    lines = details(h.store);
    assert.ok(lines.includes("Result of visit 5 · chosen · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith(`  ${WORKFLOW_VISIT_WORDS.input}: {"text":"word word`)), lines.join("\n"));
    assert.ok(lines.includes("  Input: only the start is shown · f reads all"), lines.join("\n"));
    // f reads its whole input, shown below its line.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_WHOLE_VALUE);
    await settle();
    assert.deepEqual(h.calls.at(-1)[1], { runId: RUN, executionId: "nx-poll-5" });
    lines = details(h.store);
    assert.ok(lines.includes("  Input · 511 bytes:"), lines.join("\n"));
    assert.ok(!lines.includes("  Input: only the start is shown · f reads all"), lines.join("\n"));
    assert.ok(!lines.some(line => line.includes("No value yet")), lines.join("\n"));
});
