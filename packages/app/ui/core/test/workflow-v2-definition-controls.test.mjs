/**
 * Workflow v2: a person publishes and starts a workflow from the workflow
 * view (design 04 publish and start; mocks M01 and M03; R17, R18, R26;
 * INACTIVE):
 *   - no publication controls without `personCommands` (the view stays as it
 *     was), for a deleted definition, or in a workflow agent state's subtree
 *     (where the restriction says why)
 *   - a draft offers Publish only and Publish and start for the exact revision
 *     shown and its definition hash; a revision with compile errors cannot be
 *     published; a published definition offers Start live run until it has
 *     its live run, and nothing after
 *   - the commands carry the revision and hash shown (a definition command
 *     names no run); inputs and initial variables are JSON objects
 *   - a stale publish (the draft moved on, 409) is refused, reported and read
 *     again; an input its schema refuses is reported with its problems; an
 *     unanswered command is sent again with the same operation id
 *   - the review panel opens from the header (server render)
 *
 * Run: node --test test/workflow-v2-definition-controls.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowV2CommandNamesRun, workflowV2DefinitionControls, workflowV2JsonObjectDraft, workflowV2RunCommandAccepted, workflowV2RunCommandArgs,
    workflowV2PublicationEvidenceRows, workflowV2RunCommandFailure, workflowV2RunCommandNotice, workflowV2RunCommandWire,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { readModel, subtreeCommands } from "./workflow-v2-fixtures.mjs";

const SID = "wf-publication";
const EVERY = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
    "stop", "test", "test_respond", "test_advance"];
const commands = (extra = {}) => ({ operations: EVERY, restriction: null, run: null, ...extra });
const SUBTREE = subtreeCommands(null);
const HASH_2 = "a".repeat(64);
const DRAFT = { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null };
const draftModel = (revision = {}, personCommands = commands()) => ({
    ...readModel({ definition: DRAFT, revision: { revision: 2, definitionHash: HASH_2, ...revision }, noRun: true }), personCommands });
const publishedModel = ({ live = false, personCommands = commands() } = {}) => ({
    ...readModel({ noRun: !live }), ...(live ? {} : { runs: [] }), personCommands });
const operations = model => model?.controls.map(control => control.operation);

test("no publication controls without personCommands, for a deleted definition, or in an agent state's subtree", () => {
    assert.equal(workflowV2DefinitionControls(readModel()), null);
    assert.equal(workflowV2DefinitionControls({ ...readModel({ definition: { state: "deleted" } }), personCommands: commands() }), null);
    assert.equal(workflowV2DefinitionControls({ workflowId: "w", personCommands: commands() }), null);
    const subtree = workflowV2DefinitionControls(draftModel({}, SUBTREE));
    assert.deepEqual(operations(subtree), []);
    assert.equal(subtree.note, `${SUBTREE.restriction.reason} Its controlling agent is session parent-a.`);
});

test("a draft offers Publish only and Publish and start for the exact revision shown; errors block publishing", () => {
    const draft = workflowV2DefinitionControls(draftModel());
    assert.deepEqual(operations(draft), ["publish", "publish_and_start"]);
    assert.deepEqual(draft.controls.map(control => [control.label, control.enabled]), [["Publish only", true], ["Publish and start", true]]);
    assert.deepEqual({ state: draft.state, revision: draft.revision, definitionHash: draft.definitionHash, valid: draft.valid, name: draft.name, semver: draft.semver },
        { state: "draft", revision: 2, definitionHash: HASH_2, valid: true, name: "watch-v2", semver: "1.0.0" });
    assert.match(draft.controls[0].title, /no longer changes afterwards; no run starts/);

    const invalid = workflowV2DefinitionControls(draftModel({ valid: false, diagnostics: [
        { severity: "error", code: "E1", path: "states.a", message: "x" }, { severity: "error", code: "E2", path: "states.b", message: "y" },
        { severity: "warning", code: "W1", path: "states.c", message: "z" }] }));
    assert.ok(invalid.controls.every(control => !control.enabled
        && control.title === "Revision 2 has 2 errors and cannot be published; fix them first."));
    const unknown = workflowV2DefinitionControls(draftModel({ definitionHash: undefined }));
    assert.ok(unknown.controls.every(control => !control.enabled && /definition hash is not known/.test(control.title)));
});

test("a published definition offers Start live run until it has its live run, and nothing after", () => {
    const ready = workflowV2DefinitionControls(publishedModel());
    assert.deepEqual(ready.controls.map(control => [control.operation, control.label, control.enabled]), [["start", "Start live run", true]]);
    assert.deepEqual([ready.state, ready.publishedRevision, ready.publishedDefinitionHash, ready.liveRun], ["published", 1, "hash-1", false]);
    const running = workflowV2DefinitionControls(publishedModel({ live: true }));
    assert.deepEqual(operations(running), []);
    assert.equal(running.note, "This workflow has its live run; a new live run needs a new workflow.");
});

test("a viewer who may not command it, or a command in flight, disables the controls with the reason", () => {
    const denied = workflowV2DefinitionControls(draftModel({}, commands({ viewer: { allowed: false, reason: "Only the session owner (Alice) or an admin can do this." } })));
    assert.ok(denied.controls.every(control => !control.enabled && control.title === "Only the session owner (Alice) or an admin can do this."));
    const pending = workflowV2DefinitionControls(draftModel(), { operation: "publish", runId: null, phase: "pending" });
    assert.deepEqual(pending.controls.map(control => [control.label, control.enabled, control.pending]),
        [["Publishing…", false, true], ["Publish and start", false, false]]);
    const starting = workflowV2DefinitionControls(publishedModel(), { operation: "start", runId: null, phase: "pending" });
    assert.equal(starting.controls[0].label, "Starting…");
});

test("the commands carry the revision and hash shown and name no run; inputs and initial variables are JSON objects", () => {
    assert.equal(workflowV2CommandNamesRun("publish"), false);
    assert.equal(workflowV2CommandNamesRun("start"), false);
    assert.equal(workflowV2CommandNamesRun("pause"), true);
    assert.equal(workflowV2CommandNamesRun("set_vars"), true);
    assert.deepEqual(workflowV2RunCommandArgs("publish", { expectedRevision: 2, definitionHash: HASH_2, inputs: { ignored: true } }),
        { ok: true, args: { expectedRevision: 2, definitionHash: HASH_2 } });
    assert.deepEqual(workflowV2RunCommandArgs("publish_and_start", { expectedRevision: 2, definitionHash: HASH_2, inputs: { repo: "r" }, vars: { note: 1 } }),
        { ok: true, args: { expectedRevision: 2, definitionHash: HASH_2, inputs: { repo: "r" }, vars: { note: 1 } } });
    assert.deepEqual(workflowV2RunCommandArgs("start", { definitionHash: "hash-1" }), { ok: true, args: { definitionHash: "hash-1", inputs: {} } });
    for (const [operation, input] of [["publish", { expectedRevision: 2 }], ["publish", { expectedRevision: 0, definitionHash: HASH_2 }],
        ["publish_and_start", { definitionHash: HASH_2, inputs: {} }], ["publish_and_start", { expectedRevision: 2, definitionHash: HASH_2, inputs: [1] }],
        ["start", { definitionHash: "" }], ["start", { definitionHash: "h", vars: "x" }], ["publish", null]]) {
        assert.deepEqual(workflowV2RunCommandArgs(operation, input), { ok: false }, `${operation} ${JSON.stringify(input)}`);
    }
    assert.deepEqual(workflowV2RunCommandWire("publish", null, "op-1", { expectedRevision: 2, definitionHash: HASH_2 }),
        { operation: "publish", operation_id: "op-1", expected_revision: 2, definition_hash: HASH_2 });
    assert.deepEqual(workflowV2RunCommandWire("publish_and_start", null, "op-2", { expectedRevision: 2, definitionHash: HASH_2, inputs: {}, vars: { a: 1 } }),
        { operation: "publish_and_start", operation_id: "op-2", expected_revision: 2, definition_hash: HASH_2, inputs: {}, vars: { a: 1 } });
    assert.deepEqual(workflowV2RunCommandWire("start", "ignored-run", "op-3", { definitionHash: "hash-1", inputs: { repo: "r" } }),
        { operation: "start", operation_id: "op-3", definition_hash: "hash-1", inputs: { repo: "r" } });

    assert.deepEqual(workflowV2JsonObjectDraft("", { label: "Inputs" }), { ok: true, value: {} });
    assert.deepEqual(workflowV2JsonObjectDraft("  ", { label: "Initial variables", optional: true }), { ok: true, value: undefined });
    assert.deepEqual(workflowV2JsonObjectDraft("{\"repo\":\"r\"}"), { ok: true, value: { repo: "r" } });
    assert.match(workflowV2JsonObjectDraft("[1]", { label: "Inputs" }).error, /^Inputs must be a JSON object, for example/);
    assert.match(workflowV2JsonObjectDraft("{repo}", { label: "Inputs" }).error, /^Inputs must be a JSON object: /);
});

test("the status line and notices name the revision, not a run; a refused input lists its problems", () => {
    assert.equal(workflowV2RunCommandAccepted("publish", null, { publishedRevision: 2, replayed: false }, { expectedRevision: 2, definitionHash: HASH_2 }),
        "Published revision 2. It no longer changes; its live run starts only when someone starts it.");
    assert.equal(workflowV2RunCommandAccepted("publish_and_start", null, { publishedRevision: 2, run: { runId: "run-9", mode: "live", revision: 2 } }),
        "Started revision 2 (run run-9).");
    assert.equal(workflowV2RunCommandAccepted("start", null, { publishedRevision: 1, run: { runId: "run-9", mode: "live", revision: 1 }, replayed: true }),
        "Started revision 1 (run run-9). It had already been accepted.");
    assert.equal(workflowV2RunCommandNotice({ operation: "publish", runId: null, phase: "failed", message: "The draft is at revision 3, not 2." }).text,
        "Publish was refused: The draft is at revision 3, not 2.");
    assert.equal(workflowV2RunCommandNotice({ operation: "start", runId: null, phase: "unconfirmed", message: "Failed to fetch" }).text,
        "Start may not have reached the workflow: Failed to fetch. Retry sends the same command again.");
    const input = workflowV2RunCommandFailure(Object.assign(new Error("Workflow inputs do not match inputs.schema."),
        { status: 422, code: "WORKFLOW_INPUT_INVALID", details: [{ path: "/repo", message: "is required" }, { path: "", message: "has an extra key" }] }));
    assert.deepEqual(input, { phase: "failed", code: "WORKFLOW_INPUT_INVALID",
        message: "Workflow inputs do not match inputs.schema. /repo: is required; has an extra key" });
});

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

function seeded(answer) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const updates = [];
    const reads = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return draftModel(); },
        updateWorkflow: async (sessionId, command) => { updates.push([sessionId, command]); return answer(command); },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "pending", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, updates, reads, view };
}

const receiptOf = command => ({ workflowId: SID, operation: command.operation, replayed: false, state: "published", revision: 2,
    definitionHash: HASH_2, publishedRevision: 2, run: command.operation === "publish" ? null : { runId: "run-9", mode: "live", revision: 2 } });
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));

test("Publish sends the exact revision and hash shown, names no run, and reads the workflow again", async () => {
    const h = seeded(receiptOf);
    const sent = await h.controller.sendWorkflowRunCommand(SID, { operation: "publish", expectedRevision: 2, definitionHash: HASH_2 });
    assert.equal(sent.ok, true);
    const [sessionId, command] = h.updates[0];
    assert.equal(sessionId, SID);
    assert.match(command.operation_id, /^ui-publish-./);
    assert.deepEqual(without(command, "operation_id"), { operation: "publish", expected_revision: 2, definition_hash: HASH_2 });
    assert.equal(h.store.getState().ui.statusText, "Published revision 2. It no longer changes; its live run starts only when someone starts it.");
    await until(() => h.reads.length === 1, "the read model read again");
    // Start sends the published hash with its inputs and initial variables.
    await h.controller.sendWorkflowRunCommand(SID, { operation: "start", definitionHash: HASH_2, inputs: { repo: "r" }, vars: { note: "x" } });
    assert.deepEqual(without(h.updates[1][1], "operation_id"), { operation: "start", definition_hash: HASH_2, inputs: { repo: "r" }, vars: { note: "x" } });
    assert.match(h.store.getState().ui.statusText, /^Started revision 2 \(run run-9\)\./);
    // Nothing is sent for a definition command that is not one.
    assert.deepEqual(await h.controller.sendWorkflowRunCommand(SID, { operation: "publish", expectedRevision: 2 }), { ok: false, reason: "invalid" });
    assert.equal(h.updates.length, 2);
});

test("a stale publish is refused, reported and read again; an unanswered one is sent again with the same operation id", async () => {
    let fail = Object.assign(new Error("The draft is at revision 3, not 2."), { status: 409, code: "REVISION_CONFLICT", details: { currentRevision: 3 } });
    const h = seeded(command => { if (fail) throw fail; return receiptOf(command); });
    const refused = await h.controller.sendWorkflowRunCommand(SID, { operation: "publish", expectedRevision: 2, definitionHash: HASH_2 });
    assert.equal(refused.reason, "failed");
    assert.deepEqual(without(h.view().runCommand, "operationId"), { operation: "publish", runId: null, args: { expectedRevision: 2, definitionHash: HASH_2 },
        phase: "failed", message: "The draft is at revision 3, not 2.", code: "REVISION_CONFLICT" });
    assert.equal(workflowV2RunCommandNotice(h.view().runCommand).text, "Publish was refused: The draft is at revision 3, not 2.");
    await until(() => h.reads.length === 1, "the read model read again after the stale publish");
    h.controller.dismissWorkflowRunCommand(SID);

    fail = new TypeError("Failed to fetch");
    await h.controller.sendWorkflowRunCommand(SID, { operation: "publish_and_start", expectedRevision: 3, definitionHash: HASH_2, inputs: { repo: "r" } });
    assert.equal(h.view().runCommand.phase, "unconfirmed");
    const first = h.updates.at(-1)[1];
    assert.equal(Object.hasOwn(first, "run_id"), false);
    fail = null;
    assert.equal((await h.controller.retryWorkflowRunCommand(SID)).ok, true);
    assert.deepEqual(h.updates.at(-1)[1], first, "the same command, with the same operation id");
    assert.match(h.store.getState().ui.statusText, /^Started revision 2 \(run run-9\)\./);
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}
// Batch 6 (r-3): the header's buttons are in the main pane, and the panel they choose shows in the side pane.
const main = controller => renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(WorkflowMainPane, { controller, icon: null }), React.createElement(WorkflowNodePane, { controller })));

test("the review panel opens from the header: the exact revision and hash with Publish only and Publish and start, or Start for a published workflow", () => {
    const plain = main(mount({ readModel: readModel({ definition: DRAFT, noRun: true }), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(!plain.includes("Publish…") && !plain.includes("Publish review"), "no controls without personCommands");

    const closed = main(mount({ readModel: draftModel(), readModelRunId: null }));
    assert.ok(closed.includes("aria-label=\"Publish…\""), "an icon button named by its old text (of-04)");
    assert.ok(closed.includes("data-definition-state=\"draft\""));
    assert.ok(!closed.includes("Publish review"));

    const open = main(mount({ readModel: draftModel(), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(open.includes("aria-label=\"Publish review\""));
    // flow-08: one line for the definition, its revision and validity, and the hash by its start; the whole hash on hover.
    assert.ok(open.includes(` title="${HASH_2}" data-hash="${HASH_2}">${HASH_2.slice(0, 12)}…</code>`), "the short hash, whole on hover");
    assert.match(open, /<span>Definition<\/span><strong>[^<]* · revision 2 · valid · <code/);
    assert.deepEqual([...open.matchAll(/data-operation="([a-z_]+)"/g)].map(match => match[1]), ["publish", "publish_and_start"]);
    assert.ok(open.includes("data-field=\"inputs\"") && open.includes("data-field=\"vars\""));
    // of-07: the review's JSON boxes take the shared theme style in monospace, each named by its own label.
    for (const field of ["inputs", "vars"]) {
        const [, id] = open.match(new RegExp(`<textarea id="([^"]+)" class="ps-workflow-input is-code"[^>]*data-field="${field}"`)) ?? [];
        assert.ok(id, `the ${field} box has the shared JSON style`);
        assert.ok(open.includes(`<label for="${id}">`), `the ${field} label names its box`);
    }
    assert.ok(open.includes("Publishing freezes this exact revision"));

    const start = main(mount({ readModel: publishedModel(), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(start.includes("aria-label=\"Start…\""));
    assert.ok(start.includes("aria-label=\"Start the live run\""));
    assert.deepEqual([...start.matchAll(/data-operation="([a-z_]+)"/g)].map(match => match[1]), ["start"]);

    const live = main(mount({ readModel: publishedModel({ live: true }), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(!live.includes("Start…") && !live.includes("Start the live run"), "no start once the live run exists");
    const subtree = main(mount({ readModel: draftModel({}, SUBTREE), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(!subtree.includes("Publish…") && !subtree.includes("Publish review"), "nothing to publish in an agent state's subtree");
});

// Mock M03 (R18, R28): the review names each named agent as written and, once published, what publication pinned; and it
// lists the tests of exactly the revision reviewed, as information (publishing requires none). Nothing is resolved here.
const AGENT_STATES = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0", interface: "ReviewResult@1" },
        timeoutSeconds: 600, outcomes: ["accepted"], next: { accepted: "done", timed_out: "failed" } },
    { id: "summarize", type: "agent", invoke: { source: "prompt" }, outcomes: ["done"], next: { done: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const REVISION_PIN = "b".repeat(64);
const DIGEST = "c".repeat(64);

test("the review names each named agent and what is pinned for it, and the tests of exactly this revision, as information", () => {
    const testRuns = [
        { runId: "test-run-0001", mode: "test", status: "completed", revision: 2, outcome: "succeeded" },
        { runId: "test-run-0002", mode: "test", status: "running", revision: 2, outcome: null },
        { runId: "test-run-0003", mode: "test", status: "completed", revision: 1, outcome: "failed" },
    ];
    const draft = workflowV2DefinitionControls({ ...draftModel(), graph: { revision: 2, initial: "review", states: AGENT_STATES }, runs: testRuns });
    assert.deepEqual(draft.agents, [{ stateId: "review", task: "code-reviewer · review-kit 1.2.0", rows: [["Interface", "ReviewResult@1"]] }],
        "an inline prompt names no agent");
    assert.deepEqual(draft.tests, [{ runId: "test-run-0001", status: "completed", outcome: "succeeded" }, { runId: "test-run-0002", status: "running", outcome: null }],
        "a test of another revision is not this revision's evidence");
    assert.deepEqual(workflowV2PublicationEvidenceRows(draft), [
        ["Agent in 'review'", "code-reviewer · review-kit 1.2.0 · its exact package revision is locked when this revision starts"],
        ["  Interface", "ReviewResult@1"],
        ["Tests of this revision", "test-r…0001 completed · succeeded; test-r…0002 running"],
    ]);

    const pins = { review: { name: "code-reviewer", package: "review-kit", version: "1.2.0", revision: REVISION_PIN,
        interface: { name: "ReviewResult", version: "1", digest: DIGEST } } };
    const published = workflowV2DefinitionControls({ ...publishedModel(), definition: { ...publishedModel().definition, publishedAgentPins: pins },
        graph: { revision: 1, initial: "review", states: AGENT_STATES }, runs: [] });
    assert.deepEqual(workflowV2PublicationEvidenceRows(published), [
        ["Agent in 'review'", "code-reviewer · review-kit 1.2.0 · locked: review-kit 1.2.0 · revision bbbbbbbbbbbb…"],
        ["  Interface", "ReviewResult@1"],
        ["  Interface fingerprint", "ReviewResult@1 · cccccccccccc…"],
    ], "no test row without a test run (test mode is hidden)");
    // Without a graph, nothing is said about agents; a revision with no named agent says so.
    assert.deepEqual(workflowV2PublicationEvidenceRows(workflowV2DefinitionControls({ ...draftModel(), graph: null, runs: [] }))[0],
        ["Agents", "Not known: the revision has no graph to read"]);
    assert.deepEqual(workflowV2PublicationEvidenceRows(workflowV2DefinitionControls({ ...draftModel(), runs: [] }))[0], ["Agents", "None: no step runs a named agent"]);
    // The portal's review shows the same rows.
    const open = main(mount({ readModel: { ...draftModel(), graph: { revision: 2, initial: "review", states: AGENT_STATES }, runs: testRuns },
        readModelRunId: null, sidePanel: "definition" }));
    assert.ok(open.includes("data-evidence=\"Agent in &#x27;review&#x27;\""), open);
    assert.ok(open.includes("its exact package revision is locked when this revision starts"));
    assert.ok(open.includes("test-r…0001 completed · succeeded; test-r…0002 running"));
    // Mock M03 "Back to draft" (accounting row 13): the review has its Close. Mock M28 "Fit" (row 91): the graph opens fitted,
    // by React Flow in the browser (workflow-session.spec.mjs, batch 5); the server's plain picture has no zoom buttons of its own.
    const fitted = main(mount({ readModel: draftModel(), readModelRunId: null, sidePanel: "definition" }));
    assert.ok(fitted.includes(">Close</button>"));
    assert.ok(fitted.includes("data-renderer=\"static\""));
    assert.ok(!fitted.includes(">Fit</button>") && !fitted.includes(">100%</button>") && !fitted.includes("Full graph"));
});

// Owner decision q1: before publishing, the review shows the version publishing would lock now (the agent-versions read
// for exactly the revision and hash reviewed), or what would refuse the publication; a read of another revision or hash
// says nothing, and so does no read.
test("the draft review shows the agent versions publishing would lock now, or what would refuse it", () => {
    const draft = workflowV2DefinitionControls({ ...draftModel(), graph: { revision: 2, initial: "review", states: AGENT_STATES }, runs: [] });
    const read = value => ({ revision: 2, phase: "loaded", error: null,
        value: { workflowId: SID, revision: 2, definitionHash: HASH_2, resolves: true, locked: false, agents: [], problem: null, ...value } });
    const agentLine = versions => workflowV2PublicationEvidenceRows(draft, versions).find(([label]) => label === "Agent in 'review'")[1];
    assert.equal(agentLine(read({ agents: [{ stateId: "review", name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "p",
        revision: REVISION_PIN, interface: { name: "ReviewResult", version: "1", digest: DIGEST } }] })),
    "code-reviewer · review-kit 1.2.0 · version now: review-kit 1.2.0 (revision bbbbbbbbbbbb) · interface ReviewResult@1; Start locks it");
    assert.equal(agentLine({ revision: 2, phase: "loading", value: null, error: null }),
        "code-reviewer · review-kit 1.2.0 · reading the version Start would lock…");
    assert.equal(agentLine({ revision: 2, phase: "failed", value: null, error: "Gateway timeout" }),
        "code-reviewer · review-kit 1.2.0 · the version now could not be read: Gateway timeout");
    const message = "Agent \"code-reviewer\" of state 'review' is not available at version 1.2.0 (it is at 1.3.0).";
    assert.deepEqual(workflowV2PublicationEvidenceRows(draft, read({ problem: { code: "AGENT_UNAVAILABLE", message, details: {} } })).slice(0, 2),
        [["Start would be refused", message], ["Agent in 'review'", "code-reviewer · review-kit 1.2.0"]]);
    assert.deepEqual(workflowV2PublicationEvidenceRows(draft, read({ resolves: false }))[0],
        ["Agent versions", "This deployment locks no agent versions at Start: each agent step uses the version current when it starts."]);
    const plain = "code-reviewer · review-kit 1.2.0 · its exact package revision is locked when this revision starts";
    assert.equal(agentLine(null), plain);
    assert.equal(agentLine({ ...read({}), revision: 3 }), plain, "a read of another revision");
    assert.equal(agentLine(read({ definitionHash: "d".repeat(64) })), plain, "a read of another definition hash");
});

test("the controller reads the agent versions for the review once per revision, again after a failure, and records the answer", async () => {
    const calls = [];
    let fail = true;
    const answer = { workflowId: SID, revision: 2, definitionHash: HASH_2, resolves: true, locked: false, agents: [], problem: null };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport: { readWorkflow: async (sessionId, options) => {
        calls.push([sessionId, options]);
        if (fail) throw new Error("Gateway timeout");
        return answer;
    } } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow", status: "idle", sessionKind: "workflow" }] });
    const versions = () => store.getState().ui.workflowViews[SID].agentVersions;
    assert.deepEqual(await controller.loadWorkflowAgentVersions(SID, { revision: 2 }), { revision: 2, phase: "failed", value: null, error: "Gateway timeout" });
    assert.deepEqual(versions(), { revision: 2, phase: "failed", value: null, error: "Gateway timeout" });
    fail = false;
    assert.deepEqual(await controller.loadWorkflowAgentVersions(SID, { revision: 2 }), { revision: 2, phase: "loaded", value: answer, error: null });
    await controller.loadWorkflowAgentVersions(SID, { revision: 2 });
    assert.deepEqual(calls, [[SID, { agentVersions: true }], [SID, { agentVersions: true }]], "loaded once for the revision; the failure was asked again");
    await controller.loadWorkflowAgentVersions(SID, { revision: 3 });
    assert.equal(calls.length, 3, "another revision is read again");
    assert.equal(await controller.loadWorkflowAgentVersions("not-a-workflow", { revision: 2 }), null);
});
