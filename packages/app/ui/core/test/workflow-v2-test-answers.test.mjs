/**
 * Workflow v2: a person answers a test run's held calls and moves
 * its virtual clock from the workflow view (design 05 test_respond and
 * test_advance; mocks M18 and M19; R19, R20, R26; INACTIVE):
 *   - nothing without `personCommands` listing test_respond or test_advance
 *     (a host without controller 1.9.0, or a workflow agent state's subtree)
 *     or unless the view shows a test run; a run that ended, or a viewer who
 *     may not command the workflow, can answer and advance nothing
 *   - only interceptions that wait for an answer are answerable, each with
 *     what it reached, what the answer must match and, for an agent state,
 *     its outcomes
 *   - an answer is success with a JSON value, error with { code, message }
 *     or cancel; seconds to advance are a whole number from 1 to 30 days
 *   - the commands name the test run; the answer names its interception;
 *     a refused answer shows the fields its contract refuses
 *   - the answer buttons, the form and the clock render only where allowed
 *
 * Run: node --test test/workflow-v2-test-answers.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowV2AdvanceDraft, workflowV2CommandNamesRun, workflowV2RunCommandAccepted, workflowV2RunCommandArgs, workflowV2RunCommandFailure,
    workflowV2RunCommandNotice, workflowV2RunCommandWire, workflowV2TestAnswerTemplate, workflowV2TestResponder, workflowV2TestResponseDraft,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { RUN, readModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-test-answers";
const MILESTONE = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
    "stop", "test", "test_respond", "test_advance"];
const states = [
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["accepted", "rejected"],
        next: { accepted: "done", rejected: "failed", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
const AGENT = "nx-review-1/agent";
const testView = (extra = {}) => ({
    notice: "TEST — scripts run normally; workflow tools are mocked.", agentMode: "mocked", scenario: null, testedRevision: 1, stale: false,
    virtualClock: { now: "9000-01-01T01:00:00.000Z", elapsedSeconds: 3600 },
    interceptions: [
        { interceptionId: "nx-fetch-1/call-1", operation: "tool.call", tool: "read_build", stateId: "fetch", state: "responded",
            arguments: "{\"buildId\":7}", responseSchema: { type: "object" }, response: { kind: "success", disposition: "fixture" } },
        { interceptionId: AGENT, operation: "agent", tool: null, stateId: "review", state: "awaiting_parent", arguments: "{\"input\":null}",
            responseSchema: { type: "object", required: ["outcome"] }, virtualAt: "9000-01-01T00:00:00.000Z", response: null },
    ],
    coverage: { unanswered: [AGENT] },
    ...extra,
});
const testModel = ({ status = "running", operations = MILESTONE, viewer, test: extra = {}, mode = "test" } = {}) => ({
    ...readModel({ graph, definition: { state: "draft", currentRevision: 1, publishedRevision: null },
        run: { mode, status, ...(mode === "test" ? { test: testView(extra) } : {}) }, runs: [{ runId: RUN, mode, status, revision: 1 }] }),
    personCommands: { operations, restriction: null, run: null, ...(viewer ? { viewer } : {}) } });

test("nothing without test_respond or test_advance, or unless the view shows a test run; an ended run or a viewer who may not command answers nothing", () => {
    assert.equal(workflowV2TestResponder(readModel()), null);
    assert.equal(workflowV2TestResponder(testModel({ operations: MILESTONE.slice(0, 10) })), null, "a host without the test operations");
    assert.equal(workflowV2TestResponder(testModel({ operations: ["pause", "stop", "cancel"] })), null, "an agent state's subtree");
    assert.equal(workflowV2TestResponder(testModel({ mode: "live" })), null, "a live run");
    assert.equal(workflowV2TestResponder({ ...readModel({ noRun: true }), personCommands: { operations: MILESTONE } }), null, "no run");

    const responder = workflowV2TestResponder(testModel());
    assert.deepEqual({ runId: responder.runId, respond: responder.respond, advance: responder.advance, reason: responder.reason, busy: responder.busy,
        pending: responder.pending, elapsedSeconds: responder.elapsedSeconds },
    { runId: RUN, respond: true, advance: true, reason: null, busy: false, pending: null, elapsedSeconds: 3600 });
    assert.deepEqual(responder.waiting, [{ interceptionId: AGENT, operation: "agent", tool: null, stateId: "review", arguments: "{\"input\":null}",
        responseSchema: { type: "object", required: ["outcome"] }, virtualAt: "9000-01-01T00:00:00.000Z", outcomes: ["accepted", "rejected"] }]);

    const ended = workflowV2TestResponder(testModel({ status: "completed" }));
    assert.deepEqual([ended.respond, ended.advance], [false, false]);
    assert.equal(ended.reason, "Test run run-1 has ended (completed); its held calls stay unanswered.");
    const denied = workflowV2TestResponder(testModel({ viewer: { allowed: false, reason: "Only the session owner (Alice) or an admin can do this." } }));
    assert.deepEqual([denied.respond, denied.advance, denied.reason], [false, false, "Only the session owner (Alice) or an admin can do this."]);
    const pending = workflowV2TestResponder(testModel(), { operation: "test_advance", runId: RUN, phase: "pending" });
    assert.deepEqual([pending.busy, pending.pending], [true, "test_advance"]);
});

test("an answer is success with JSON, error with { code, message } or cancel; seconds to advance are 1 to 30 days", () => {
    assert.equal(workflowV2TestAnswerTemplate({ operation: "agent", outcomes: ["accepted", "rejected"] }), "{\"outcome\":\"accepted\",\"output\":null}");
    assert.equal(workflowV2TestAnswerTemplate({ operation: "request" }), "{\"response\":null}");
    assert.equal(workflowV2TestAnswerTemplate({ operation: "tool.call" }), "null");

    assert.deepEqual(workflowV2TestResponseDraft("success", "null"), { ok: true, response: { kind: "success", value: null } });
    assert.deepEqual(workflowV2TestResponseDraft("success", "{\"outcome\":\"accepted\",\"output\":{\"verdict\":\"ok\"}}"),
        { ok: true, response: { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } } });
    assert.match(workflowV2TestResponseDraft("success", "{outcome}").error, /^The answer must be JSON: /);
    assert.match(workflowV2TestResponseDraft("success", "  ").error, /^Give the answer as JSON/);
    assert.deepEqual(workflowV2TestResponseDraft("error", "{\"code\":\"execution_failed\",\"message\":\"broke\"}"),
        { ok: true, response: { kind: "error", value: { code: "execution_failed", message: "broke" } } });
    assert.match(workflowV2TestResponseDraft("error", "{\"code\":\"execution_failed\"}").error, /^An error answer is/);
    assert.deepEqual(workflowV2TestResponseDraft("cancel", "ignored"), { ok: true, response: { kind: "cancel" } });
    assert.match(workflowV2TestResponseDraft("maybe", "null").error, /^Choose success, error or cancel\./);

    assert.deepEqual(workflowV2AdvanceDraft("60"), { ok: true, seconds: 60 });
    assert.deepEqual(workflowV2AdvanceDraft(2_592_000), { ok: true, seconds: 2_592_000 });
    for (const source of ["0", "1.5", "2592001", "", "soon"]) assert.equal(workflowV2AdvanceDraft(source).ok, false, source);
});

test("the commands name the test run; the answer names its interception; a refused answer shows the fields its contract refuses", () => {
    assert.equal(workflowV2CommandNamesRun("test_respond"), true);
    assert.equal(workflowV2CommandNamesRun("test_advance"), true);
    const response = { kind: "success", value: { outcome: "accepted", output: null } };
    assert.deepEqual(workflowV2RunCommandArgs("test_respond", { interceptionId: AGENT, response }), { ok: true, args: { interceptionId: AGENT, response } });
    for (const input of [{ response }, { interceptionId: AGENT }, { interceptionId: AGENT, response: { kind: "maybe" } },
        { interceptionId: AGENT, response: { kind: "cancel", value: 1 } }, { interceptionId: AGENT, response: { kind: "success", value: 1, extra: true } }, null]) {
        assert.deepEqual(workflowV2RunCommandArgs("test_respond", input), { ok: false }, JSON.stringify(input));
    }
    assert.deepEqual(workflowV2RunCommandArgs("test_advance", { seconds: 300 }), { ok: true, args: { seconds: 300 } });
    for (const seconds of [0, 2_592_001, "300", 1.5]) assert.deepEqual(workflowV2RunCommandArgs("test_advance", { seconds }), { ok: false }, String(seconds));
    assert.deepEqual(workflowV2RunCommandWire("test_respond", RUN, "op-1", { interceptionId: AGENT, response }),
        { operation: "test_respond", operation_id: "op-1", run_id: RUN, interception_id: AGENT, response });
    assert.deepEqual(workflowV2RunCommandWire("test_advance", RUN, "op-2", { seconds: 300 }),
        { operation: "test_advance", operation_id: "op-2", run_id: RUN, seconds: 300 });

    assert.equal(workflowV2RunCommandAccepted("test_respond", RUN, { replayed: false, runId: RUN, interceptionId: AGENT,
        node: { stateId: "review", state: "completed", outcome: "accepted" } }, { interceptionId: AGENT, response }),
    "Answered held call nx-rev…gent of test run run-1. State 'review' ended 'accepted'.");
    assert.equal(workflowV2RunCommandAccepted("test_advance", RUN, { seconds: 300, decided: [{ nodeExecutionId: "nx-1" }] }, { seconds: 300 }),
        "Advanced the virtual clock of test run run-1 by 300 seconds: 1 deadline came due. Script clocks are real.");
    const invalid = workflowV2RunCommandFailure(Object.assign(new Error("The output does not match ReviewResult."),
        { status: 422, code: "TEST_RESPONSE_INVALID", details: { problems: [{ path: "/verdict", message: "must be string" }] } }));
    assert.deepEqual(invalid, { phase: "failed", code: "TEST_RESPONSE_INVALID", message: "The output does not match ReviewResult. /verdict: must be string" });
    assert.equal(workflowV2RunCommandFailure(Object.assign(new Error("Outcome 'maybe' is not one of the state's outcomes."),
        { status: 422, code: "TEST_RESPONSE_INVALID", details: { outcomes: ["accepted", "rejected"] } })).message,
    "Outcome 'maybe' is not one of the state's outcomes. Its outcomes are accepted, rejected");
    assert.equal(workflowV2RunCommandNotice({ operation: "test_respond", runId: RUN, phase: "failed", message: "Test run run-1 ended (completed)." }).text,
        "The test answer was refused for run run-1: Test run run-1 ended (completed).");
});

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

test("an answer and an advance are sent for the shown test run, and the workflow is read again", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const updates = [];
    const reads = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return testModel(); },
        updateWorkflow: async (sessionId, command) => {
            updates.push([sessionId, command]);
            return command.operation === "test_respond"
                ? { workflowId: SID, operation: "test_respond", replayed: false, runId: RUN, interceptionId: AGENT,
                    interception: { operation: "agent", state: "responded" }, node: { nodeExecutionId: "nx-review-1", stateId: "review", state: "completed", outcome: "accepted" } }
                : { workflowId: SID, operation: "test_advance", replayed: false, runId: RUN, seconds: command.seconds, decided: [] };
        },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "running", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const response = { kind: "success", value: { outcome: "accepted", output: null } };
    assert.equal((await controller.sendWorkflowRunCommand(SID, { operation: "test_respond", runId: RUN, interceptionId: AGENT, response })).ok, true);
    const [, answer] = updates[0];
    assert.match(answer.operation_id, /^ui-test_respond-./);
    assert.deepEqual(Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "operation_id")),
        { operation: "test_respond", run_id: RUN, interception_id: AGENT, response });
    assert.equal(store.getState().ui.statusText, "Answered held call nx-rev…gent of test run run-1. State 'review' ended 'accepted'.");
    await until(() => reads.length === 1, "the read model read again");
    assert.equal((await controller.sendWorkflowRunCommand(SID, { operation: "test_advance", runId: RUN, seconds: 300 })).ok, true);
    assert.deepEqual(Object.fromEntries(Object.entries(updates[1][1]).filter(([key]) => key !== "operation_id")),
        { operation: "test_advance", run_id: RUN, seconds: 300 });
    assert.equal((await controller.sendWorkflowRunCommand(SID, { operation: "test_advance", seconds: 300 })).reason, "invalid", "a test command names its run");
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: RUN, readModelRunId: RUN, ...view } });
    return new PilotSwarmUiController({ store, transport: {} });
}
const main = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, log: null, icon: null }));

test("a waiting interception has an Answer button that opens its form; the clock advances; neither shows where it is not allowed", () => {
    const html = main(mount({ readModel: testModel() }));
    assert.ok(html.includes("Held calls (2)"));
    assert.equal([...html.matchAll(/data-action="answer"/g)].length, 1, "only the waiting interception can be answered");
    assert.ok(html.includes("aria-label=\"Virtual clock\""));
    assert.ok(html.includes("Virtual clock: 1 h after the test began"));
    assert.ok(html.includes("data-operation=\"test_advance\""));
    assert.ok(!html.includes("Answer a held call"));

    const open = main(mount({ readModel: testModel(), answeringInterceptionId: AGENT }));
    assert.ok(open.includes("aria-label=\"Answer a held call\""));
    assert.ok(open.includes("Answer agent in &#x27;review&#x27;"));
    assert.ok(open.includes("{&quot;outcome&quot;:&quot;accepted&quot;,&quot;output&quot;:null}</textarea>"), "the agent's first outcome is the template");
    // The selection, read from each radio input whatever the order of its attributes.
    const radios = [...open.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).filter(input => input.includes('type="radio"'));
    assert.match(radios.find(input => input.includes('value="success"')), /checked=""/, "an answer starts as a success");
    for (const kind of ["error", "cancel"]) assert.doesNotMatch(radios.find(input => input.includes(`value="${kind}"`)), /checked=""/, kind);
    assert.match(open, /data-operation="test_respond" title="Send this answer to the test run\.">Send answer</);

    for (const [label, model] of [["ended", testModel({ status: "completed" })], ["no test operations", testModel({ operations: MILESTONE.slice(0, 10) })],
        ["viewer", testModel({ viewer: { allowed: false, reason: "no" } })]]) {
        const page = main(mount({ readModel: model, answeringInterceptionId: AGENT }));
        assert.ok(page.includes("Held calls (2)"), `${label}: the interceptions stay readable`);
        assert.ok(!page.includes("data-action=\"answer\"") && !page.includes("Answer a held call") && !page.includes("aria-label=\"Virtual clock\""), label);
    }
});
