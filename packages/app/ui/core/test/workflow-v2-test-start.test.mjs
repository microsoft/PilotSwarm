/**
 * Workflow v2: a person starts a test of the exact current revision from the
 * workflow view (design 05; mocks M18 to M20; R19, R20, R26, R28; INACTIVE):
 *   - no test review without `personCommands`, when the workflow takes no
 *     test from people (a host without controller 1.9.0, or a workflow agent
 *     state's subtree), or for a deleted definition
 *   - only a draft offers Start test for its current revision and definition
 *     hash (of-06: a published workflow is not tested); compile errors, a
 *     viewer who may not command it, an unknown hash or a command in flight
 *     disable it
 *   - the command names no run (the test makes its own) and carries the
 *     revision, the hash, the inputs, optional initial variables, the agent
 *     mode (mocked by default; real agents spend model tokens) and an
 *     optional scenario name
 *   - the review shows the test notice (not a sandbox, not live-safety
 *     evidence) and, for real agents, their cost notice before the test
 *     starts (server render)
 *
 * Run: node --test test/workflow-v2-test-start.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    WORKFLOW_V2_TEST_NOTICE_TEXT, workflowV2CommandNamesRun, workflowV2RunCommandAccepted, workflowV2RunCommandArgs, workflowV2RunCommandNotice,
    workflowV2RunCommandWire, workflowV2ScenarioDraft, workflowV2TestControls,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-test-start";
const MILESTONE = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
    "stop", "test", "test_respond", "test_advance"];
const HASH = "b".repeat(64);
const DRAFT = { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null };
const SUBTREE = { operations: ["pause", "stop", "cancel"], restriction: { reason: "This workflow was started by an agent step of another workflow.",
    workflowSessionId: "wf-container", controllingSessionId: "parent-agent" }, run: null };
const modelOf = ({ definition = DRAFT, revision = {}, personCommands = { operations: MILESTONE, restriction: null, run: null } } = {}) => ({
    ...readModel({ definition, revision: { revision: definition.currentRevision ?? 1, definitionHash: HASH, ...revision }, noRun: true }), personCommands });

test("no test review without personCommands, without the test operation (1.8.0 host or an agent subtree), or for a deleted definition", () => {
    assert.equal(workflowV2TestControls(readModel({ definition: DRAFT, noRun: true })), null);
    assert.equal(workflowV2TestControls(modelOf({ personCommands: { operations: MILESTONE.slice(0, 8), restriction: null, run: null } })), null);
    assert.equal(workflowV2TestControls(modelOf({ personCommands: SUBTREE })), null);
    assert.equal(workflowV2TestControls(modelOf({ definition: { state: "deleted", currentRevision: 2 } })), null);
});

test("only a draft offers Start test of its current revision (of-06); errors, a viewer who may not command, an unknown hash or a command in flight disable it", () => {
    const draft = workflowV2TestControls(modelOf());
    assert.deepEqual({ state: draft.state, revision: draft.revision, definitionHash: draft.definitionHash, valid: draft.valid, name: draft.name, semver: draft.semver },
        { state: "draft", revision: 2, definitionHash: HASH, valid: true, name: "watch-v2", semver: "1.0.0" });
    assert.deepEqual(draft.control, { operation: "test", label: "Start test", enabled: true, pending: false,
        title: "Test draft revision 2." });
    // A published workflow is not tested, even when an older server still lists the test operation.
    assert.equal(workflowV2TestControls(modelOf({ definition: { state: "published", currentRevision: 1 } })), null);

    const invalid = workflowV2TestControls(modelOf({ revision: { valid: false, diagnostics: [{ severity: "error", code: "E1" }] } }));
    assert.deepEqual([invalid.control.enabled, invalid.control.title], [false, "Revision 2 has 1 error and cannot be tested; fix them first."]);
    const denied = workflowV2TestControls(modelOf({ personCommands: { operations: MILESTONE, restriction: null, run: null,
        viewer: { allowed: false, reason: "Only the session owner (Alice) or an admin can do this." } } }));
    assert.deepEqual([denied.control.enabled, denied.control.title], [false, "Only the session owner (Alice) or an admin can do this."]);
    assert.match(workflowV2TestControls(modelOf({ revision: { definitionHash: undefined } })).control.title, /definition hash is not known/);
    const pending = workflowV2TestControls(modelOf(), { operation: "test", runId: null, phase: "pending" });
    assert.deepEqual([pending.control.label, pending.control.enabled, pending.busy], ["Starting test…", false, true]);
});

test("the test command names no run and carries the revision, hash, inputs, agent mode and optional variables and scenario", () => {
    assert.equal(workflowV2CommandNamesRun("test"), false);
    assert.deepEqual(workflowV2RunCommandArgs("test", { expectedRevision: 2, definitionHash: HASH }),
        { ok: true, args: { expectedRevision: 2, definitionHash: HASH, inputs: {}, agentMode: "mocked" } });
    assert.deepEqual(workflowV2RunCommandArgs("test", { expectedRevision: 2, definitionHash: HASH, inputs: { repo: "r" }, vars: { note: 1 },
        agentMode: "real", scenario: "smoke" }),
    { ok: true, args: { expectedRevision: 2, definitionHash: HASH, inputs: { repo: "r" }, vars: { note: 1 }, agentMode: "real", scenario: "smoke" } });
    for (const input of [{ definitionHash: HASH }, { expectedRevision: 2 }, { expectedRevision: 2, definitionHash: HASH, agentMode: "live" },
        { expectedRevision: 2, definitionHash: HASH, scenario: "  " }, { expectedRevision: 2, definitionHash: HASH, scenario: "s".repeat(129) },
        { expectedRevision: 2, definitionHash: HASH, inputs: [1] }]) {
        assert.deepEqual(workflowV2RunCommandArgs("test", input), { ok: false }, JSON.stringify(input));
    }
    assert.deepEqual(workflowV2RunCommandWire("test", "ignored", "op-1", { expectedRevision: 2, definitionHash: HASH, inputs: {}, agentMode: "mocked" }),
        { operation: "test", operation_id: "op-1", expected_revision: 2, definition_hash: HASH, inputs: {}, agent_mode: "mocked" });
    assert.deepEqual(workflowV2RunCommandWire("test", null, "op-2", { expectedRevision: 2, definitionHash: HASH, inputs: { repo: "r" }, vars: { a: 1 },
        agentMode: "real", scenario: "smoke" }),
    { operation: "test", operation_id: "op-2", expected_revision: 2, definition_hash: HASH, inputs: { repo: "r" }, vars: { a: 1 }, agent_mode: "real",
        scenario: "smoke" });
    assert.deepEqual(workflowV2ScenarioDraft(""), { ok: true, value: undefined });
    assert.deepEqual(workflowV2ScenarioDraft("smoke run"), { ok: true, value: "smoke run" });
    assert.match(workflowV2ScenarioDraft("s".repeat(129)).error, /^A scenario name is at most 128 characters\./);

    const receipt = { operation: "test", revision: 2, run: { runId: "run-7", mode: "test", revision: 2 }, replayed: false };
    assert.equal(workflowV2RunCommandAccepted("test", null, receipt, { agentMode: "mocked" }),
        "Test started · revision 2 · mocked agents. A test result is not evidence that the definition is safe to run live.");
    assert.equal(workflowV2RunCommandAccepted("test", null, receipt, { agentMode: "real" }),
        "Test started · revision 2 · real agents, which spend model tokens. A test result is not evidence that the definition is safe to run live.");
    assert.equal(workflowV2RunCommandNotice({ operation: "test", runId: null, phase: "failed", message: "The definition is at revision 3, not 2." }).text,
        "Test not started: The definition is at revision 3, not 2.");
});

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

test("a test start is sent as one updateWorkflow command and the workflow is read again; a stale revision is refused and read again", async () => {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "web" }));
    const updates = [];
    const reads = [];
    let fail = null;
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return modelOf(); },
        updateWorkflow: async (sessionId, command) => {
            updates.push([sessionId, command]);
            if (fail) throw fail;
            return { workflowId: SID, operation: "test", replayed: false, state: "draft", revision: 2, run: { runId: "run-7", mode: "test", revision: 2 } };
        },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "pending", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const sent = await controller.sendWorkflowRunCommand(SID, { operation: "test", expectedRevision: 2, definitionHash: HASH, inputs: { repo: "r" },
        agentMode: "real", scenario: "smoke" });
    assert.equal(sent.ok, true);
    assert.equal(sent.receipt.run.runId, "run-7");
    const command = updates[0][1];
    assert.match(command.operation_id, /^ui-test-./);
    assert.deepEqual(Object.fromEntries(Object.entries(command).filter(([key]) => key !== "operation_id")),
        { operation: "test", expected_revision: 2, definition_hash: HASH, inputs: { repo: "r" }, agent_mode: "real", scenario: "smoke" });
    assert.match(store.getState().ui.statusText, /^Test started · revision 2 · real agents, which spend model tokens\./);
    await until(() => reads.length === 1, "the read model read again");

    fail = Object.assign(new Error("The definition is at revision 3, not 2."), { status: 409, code: "REVISION_CONFLICT", details: { currentRevision: 3 } });
    assert.equal((await controller.sendWorkflowRunCommand(SID, { operation: "test", expectedRevision: 2, definitionHash: HASH })).reason, "failed");
    assert.equal(workflowV2RunCommandNotice(store.getState().ui.workflowViews[SID].runCommand).text,
        "Test not started: The definition is at revision 3, not 2.");
    await until(() => reads.length === 2, "the read model read again after the stale revision");
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}
// Batch 6 (r-3): the header's buttons are in the main pane, and the panel they choose shows in the side pane.
const main = controller => renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(WorkflowMainPane, { controller, icon: null }), React.createElement(WorkflowNodePane, { controller })));

test("the test review opens from the header with the test notice, the exact revision and hash, and mocked agents by default", () => {
    const closed = main(mount({ readModel: modelOf(), readModelRunId: null }));
    assert.ok(closed.includes("aria-label=\"Test…\""), "an icon button named by its old text (of-04)");
    assert.ok(!closed.includes("Test review"));

    const open = main(mount({ readModel: modelOf(), readModelRunId: null, sidePanel: "test" }));
    assert.ok(open.includes("aria-label=\"Test review\""));
    assert.ok(open.includes(">Test review</h3>"));
    assert.ok(open.includes(WORKFLOW_V2_TEST_NOTICE_TEXT), "the test notice is shown before the test starts");
    assert.ok(open.includes(` title="${HASH}" data-hash="${HASH}">${HASH.length > 12 ? `${HASH.slice(0, 12)}…` : HASH}</code>`), "the short hash, whole on hover (flow-08)");
    // The selection, read from each radio input whatever the order of its attributes.
    const radios = [...open.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).filter(input => input.includes('type="radio"'));
    assert.match(radios.find(input => input.includes('value="mocked"')), /checked=""/, "agents are mocked by default");
    assert.doesNotMatch(radios.find(input => input.includes('value="real"')), /checked=""/);
    assert.ok(!open.includes("their results vary"), "the real-agent cost notice shows only once real agents are chosen");
    assert.ok(open.includes("data-field=\"inputs\"") && open.includes("data-field=\"scenario\""));
    // of-07: the review's boxes take the shared theme style (JSON in monospace) and each label is tied to its box.
    for (const field of ["inputs", "vars"]) {
        const [, id] = open.match(new RegExp(`<textarea id="([^"]+)" class="ps-workflow-input is-code"[^>]*data-field="${field}"`)) ?? [];
        assert.ok(id, `the ${field} box has the shared JSON style`);
        assert.ok(open.includes(`<label for="${id}">`), `the ${field} label names its box`);
    }
    assert.match(open, /<input type="text" class="ps-workflow-input"[^>]*data-field="scenario"/);
    assert.match(open, /data-operation="test" title="Test draft revision 2\.">Start test</);

    for (const [label, model] of [["1.8.0 host", modelOf({ personCommands: { operations: MILESTONE.slice(0, 8), restriction: null, run: null } })],
        ["subtree", modelOf({ personCommands: SUBTREE })], ["no personCommands", readModel({ definition: DRAFT, noRun: true })],
        ["published (of-06)", modelOf({ definition: { state: "published", currentRevision: 2 } })]]) {
        const html = main(mount({ readModel: model, readModelRunId: null, sidePanel: "test" }));
        assert.ok(!html.includes("aria-label=\"Test…\"") && !html.includes("Test review"), label);
    }
});
