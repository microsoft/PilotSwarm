// The recipient's later intake refusal of a delivered send (readWorkflowV2View run.outbox[].intakeOutcome and
// intakeOutcomeAt, present only when set) is shown beside the delivery and never rewrites it. Fixture shapes follow
// packages/sdk/src/workflow/v2/tools.ts (outbox rows) and store.ts listOutboxIntakeOutcomes.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowDefinition } from "../src/workflow-view.js";
import { WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { projectWorkflowV2, workflowV2IntakeOutcome } from "../src/workflow-v2-view.js";
import { RUN, startedData, row, done, readModel } from "./workflow-v2-fixtures.mjs";

const AT = "2026-11-01T20:00:00.123456Z";
const message = (extra = {}) => ({
    exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", recipientKind: "agent", contract: "Alert@1",
    state: "delivered", attempts: 2, createdAt: "2026-11-01T19:00:00.000000Z", deliveredAt: "2026-11-01T19:00:05.000000Z",
    payloadPreview: '{"k":1}', inputMessageId: "in-7", ...extra,
});
const model = (outbox, nodeExecutions = [done("notify", 1, "sent")], options = {}) => readModel({ nodeExecutions, outbox: [outbox], ...options });
const exec = (view, id = "notify") => view.nodes.find(item => item.id === id);

function panel(readModelValue) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf",
        view: { definition: workflowDefinition(startedData), readModel: readModelValue, selectedNodeId: "notify" } });
    return renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller: new PilotSwarmUiController({ store, transport: {} }) }));
}

test("a delivered message with a refused_full or refused_size annotation keeps its delivery and node meaning", () => {
    for (const [outcome, reason] of [["refused_full", "queue full"], ["refused_size", "message too large"]]) {
        const view = projectWorkflowV2({ readModel: model(message({ intakeOutcome: outcome, intakeOutcomeAt: AT })) });
        const notify = exec(view);
        assert.deepEqual(notify.current.outbox.intake, { kind: outcome, reason, at: AT });
        assert.equal(notify.current.outbox.state, "delivered");
        assert.equal(notify.current.outbox.attempts, 2);
        assert.equal(notify.current.outbox.deliveredAt, "2026-11-01T19:00:05.000000Z");
        assert.equal(notify.current.outbox.inputMessageId, "in-7");
        assert.equal(notify.current.outbox.errorPreview, undefined);
        assert.equal(notify.state, "done");
        assert.equal(notify.resultKind, "business");
        assert.equal(notify.outcome, "sent");
        assert.equal(notify.stateLabel, "Sent · queued at recipient");
        assert.ok(!notify.description.some(line => /fail|refus/i.test(line) && !/does not show/.test(line)), "the node text does not turn into a failure");
    }
});

test("the selected node panel shows a distinct recipient intake line beside an unchanged delivery", () => {
    const html = panel(model(message({ intakeOutcome: "refused_full", intakeOutcomeAt: AT })));
    assert.match(html, /Check by recipient<\/span><strong>Refused · queue full</);
    assert.match(html, /Checked at<\/span><strong>2026-11-01T20:00:00.123456Z</);
    assert.match(html, /Delivery status<\/span><strong>delivered</);
    assert.match(html, /Attempts<\/span><strong>2</);
    assert.match(html, /refused this message when it checked it\. This does not change the recorded delivery or show that the recipient read or acted on it\./);
    assert.ok(!html.includes("after it was delivered"));
    assert.match(html, /does not show that the recipient read, answered or acted on it/);
    assert.ok(!/Delivery to .* failed/.test(html));
    assert.match(panel(model(message({ intakeOutcome: "refused_size", intakeOutcomeAt: AT }))), /Refused · message too large/);
});

test("a pending or failed delivery with an annotation is shown as recorded, not as a different state", () => {
    const pending = projectWorkflowV2({ readModel: model(message({ state: "pending", attempts: 0, deliveredAt: null, inputMessageId: undefined,
        intakeOutcome: "refused_full", intakeOutcomeAt: AT }), [row("notify", 1, "pending")]) });
    assert.equal(exec(pending).stateLabel, "Delivering");
    assert.equal(exec(pending).current.outbox.state, "pending");
    assert.equal(exec(pending).current.outbox.intake.kind, "refused_full");
    const html = panel(model(message({ state: "pending", attempts: 0, deliveredAt: null, intakeOutcome: "refused_full", intakeOutcomeAt: AT }), [row("notify", 1, "pending")]));
    assert.match(html, /Delivery status<\/span><strong>pending</);
    assert.match(html, /Refused · queue full/);
    assert.match(html, /refused this message when it checked it\. This does not change the recorded delivery/);
    assert.ok(!html.includes("was delivered to the queue") && !html.includes("after it was delivered") && !html.includes("Sent · queued"),
        "a pending delivery's panel does not claim delivery");
    assert.match(html, /Delivering Alert@1 to parent-1/);
    const failedHtml = panel(model(message({ state: "failed", errorPreview: '{"code":"delivery_failed"}', intakeOutcome: "refused_size", intakeOutcomeAt: AT }),
        [done("notify", 1, "delivery_failed", { resultKind: "runtime_error" })]));
    assert.match(failedHtml, /Delivery status<\/span><strong>failed</);
    assert.match(failedHtml, /Refused · message too large/);
    assert.match(failedHtml, /Delivery to parent-1 failed/);
    assert.ok(!failedHtml.includes("was delivered to the queue") && !failedHtml.includes("after it was delivered") && !failedHtml.includes("Sent · queued"),
        "a failed delivery's panel does not claim delivery or completion");
    const failed = projectWorkflowV2({ readModel: model(message({ state: "failed", errorPreview: '{"code":"delivery_failed"}', intakeOutcome: "refused_size", intakeOutcomeAt: AT }),
        [done("notify", 1, "delivery_failed", { resultKind: "runtime_error" })]) });
    assert.equal(exec(failed).state, "failed");
    assert.equal(exec(failed).stateLabel, "Failed · delivery_failed");
    assert.equal(exec(failed).current.outbox.state, "failed");
});

test("without the optional fields nothing changes: no intake data and no intake line", () => {
    for (const extra of [{}, { intakeOutcome: null, intakeOutcomeAt: null }, { intakeOutcome: undefined }]) {
        const view = projectWorkflowV2({ readModel: model(message(extra)) });
        assert.equal(exec(view).current.outbox.intake, undefined);
        assert.ok(!("intake" in exec(view).current.outbox));
    }
    const html = panel(model(message()));
    assert.ok(!html.includes("Check by recipient"));
    assert.ok(!html.includes("Checked at"));
    assert.match(html, /Delivery status<\/span><strong>delivered</);
    assert.equal(workflowV2IntakeOutcome(undefined), null);
    assert.equal(workflowV2IntakeOutcome({}), null);
});

test("an annotation on a run of another revision, or on a run that is not selected, is not shown", () => {
    const annotated = message({ intakeOutcome: "refused_full", intakeOutcomeAt: AT });
    const mismatched = projectWorkflowV2({ readModel: model(annotated, undefined,
        { runs: [{ runId: RUN, mode: "live", status: "running", revision: 2, outcome: null }] }) });
    assert.equal(mismatched.bound, false);
    assert.ok(mismatched.nodes.every(item => !item.current));
    assert.deepEqual(mismatched.outbox, []);
    assert.ok(!panel(model(annotated, undefined, { runs: [{ runId: RUN, mode: "live", status: "running", revision: 2, outcome: null }] })).includes("Check by recipient"));
    const noRun = projectWorkflowV2({ readModel: readModel({ noRun: true }) });
    assert.ok(noRun.nodes.every(item => !item.current));
    assert.ok(panel(model(annotated)).includes("Check by recipient"), "the bound control still shows it");
});

test("a missing time, an unknown outcome or a time alone are explicit, never read as success or refusal", () => {
    assert.deepEqual(workflowV2IntakeOutcome({ intakeOutcome: "refused_full" }), { kind: "refused_full", reason: "queue full", at: null });
    assert.match(panel(model(message({ intakeOutcome: "refused_full" }))), /Checked at<\/span><strong>Time not recorded</);
    const unknown = panel(model(message({ intakeOutcome: "accepted", intakeOutcomeAt: AT })));
    assert.match(unknown, /Check by recipient<\/span><strong>Unrecognized result · accepted</);
    assert.ok(!unknown.includes("Refused ·"));
    assert.ok(!unknown.includes("Received") && !unknown.includes("Executed"));
    assert.match(unknown, /not shown as a result/);
    assert.deepEqual(workflowV2IntakeOutcome({ intakeOutcomeAt: AT }), { kind: "unknown", reason: null, raw: null, at: AT });
    assert.match(panel(model(message({ intakeOutcomeAt: AT }))), /Unrecognized result<\/strong>/);
    assert.equal(workflowV2IntakeOutcome({ intakeOutcome: 42, intakeOutcomeAt: 7 }).raw, null);
    assert.equal(workflowV2IntakeOutcome({ intakeOutcome: 42, intakeOutcomeAt: 7 }).at, null);
    assert.equal(workflowV2IntakeOutcome({ intakeOutcome: "", intakeOutcomeAt: "" }).kind, "unknown");
});

test("untrusted outcome, time and payload text render escaped and long text is cut", () => {
    const hostile = `<b>x</b>${"y".repeat(200)}`;
    const html = panel(model(message({ intakeOutcome: hostile, intakeOutcomeAt: "<i>now</i>", payloadPreview: "<img src=x onerror=alert(1)>" })));
    assert.ok(!html.includes("<b>x"));
    assert.ok(!html.includes("<i>now"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
    assert.ok(html.includes("&lt;i&gt;now&lt;/i&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!html.includes("y".repeat(60)), "the raw outcome is cut to 60 characters");
    assert.ok(workflowV2IntakeOutcome({ intakeOutcome: hostile }).raw.endsWith("…"));
});

test("history rows and other tabs keep their meaning when an intake annotation is present", () => {
    const view = projectWorkflowV2({ readModel: model(message({ intakeOutcome: "refused_full", intakeOutcomeAt: AT })) });
    const plain = projectWorkflowV2({ readModel: model(message()) });
    const summary = item => ({ state: item.state, phase: item.phase, stateLabel: item.stateLabel, outcome: item.outcome, resultKind: item.resultKind,
        runs: item.runs, partial: item.partial, description: item.description });
    assert.deepEqual(summary(exec(view)), summary(exec(plain)));
    assert.deepEqual({ ...exec(view).current.outbox, intake: undefined }, { ...exec(plain).current.outbox, intake: undefined });
    assert.equal(view.status.label, plain.status.label);
});
