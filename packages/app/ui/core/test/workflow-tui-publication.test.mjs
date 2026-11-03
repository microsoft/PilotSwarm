// The definition's publication in the TUI's workflow view (design 04 publish, publish_and_start, start; mocks M01 and
// M03; R17, R18, R26, R28; INACTIVE: only where the portal's publication panel offers a person a command): P opens a
// review of exactly the revision and definition hash the view shows (the portal's workflowV2DefinitionControls): publish
// only (ctrl-p), publish and start its live run (ctrl-r), or start a published definition's live run (ctrl-r), with the
// run's inputs and initial variables as JSON objects. Each asks first in a confirm dialog that names the revision, the
// hash and the inputs, and returns to the review; confirmed, the command is sent as the portal sends it (the shared
// controller's sendWorkflowRunCommand). Nothing is sent for a review whose workflow changed meanwhile (ctrl-l reviews it
// again), for an action not offered or not available now, or for inputs that are not JSON objects; a refusal and an
// answer that never came keep what was typed, and the same key resends the same command once confirmed. The review is
// not offered in an agent state's subtree, for a workflow with its live run or without person commands.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-publication.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowPublicationModal,
    selectWorkflowViewModal, workflowPublicationChange, workflowPublicationConfirm, workflowPublicationPin,
} from "../src/index.js";
import { SUBTREE_REASON as SUBTREE, readModel, states } from "./workflow-v2-fixtures.mjs";

/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
/** A revision's definition hash, 64 characters as the store's SHA-256 hex. */
const hashOf = revision => `sha${revision}`.padEnd(64, "0");
const LIVE = "run-live-0001";

/**
 * The workflow wf with its definition `state` at `revision` (valid or with `diagnostics`), its live run when `liveRun`,
 * and what it takes from people (`commands` false: nothing; `viewer` the portal's decision for the caller).
 */
function workflow({ state = "draft", revision = 2, valid = true, diagnostics = [], operations = ALL, restriction = null, viewer = null,
    commands = true, liveRun = false } = {}) {
    const published = state === "published";
    const base = readModel({
        noRun: !liveRun,
        ...(liveRun ? { run: { runId: LIVE, status: "running" }, runs: [{ runId: LIVE, mode: "live", status: "running", revision, outcome: null }] } : {}),
        graph: valid ? { revision, initial: "poll", states } : null,
        definition: { state, semver: "1.0.0", currentRevision: revision, publishedRevision: published ? revision : null,
            publishedDefinitionHash: published ? hashOf(revision) : null },
        revision: { revision, definitionHash: hashOf(revision), valid, diagnostics, name: "watch-v2" },
    });
    if (!commands) return base;
    return { ...base, personCommands: { operations, restriction, run: null, ...(viewer ? { viewer } : {}) } };
}

/** The server's receipt for an accepted publication command; it now serves the published revision (with its live run). */
const accepted = (operation, revision, runId = null) => (command, serve) => {
    serve(workflow({ state: "published", revision, liveRun: Boolean(runId) }));
    return { workflowSessionId: "wf", operation, state: "published", revision, yamlSha256: hashOf(revision), valid: true, irSha256: `ir-${revision}`,
        diagnostics: [], publishedRevision: revision, replayed: false,
        run: runId ? { runId, mode: "live", controllerInstanceId: "controller-1", revision, irSha256: `ir-${revision}` } : null };
};
const refused = (status, code, message, details) => async () => {
    throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};

/** The workflow session wf with `initial` loaded; updateWorkflow answers with the next of `answers`. */
function harness(initial, answers = []) {
    let current = initial;
    const calls = [];
    const serve = next => { current = next; };
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return current; },
        updateWorkflow: async (sessionId, command) => {
            calls.push(["updateWorkflow", sessionId, command]);
            const answer = answers.shift();
            assert.ok(answer, `an answer for ${JSON.stringify(command)}`);
            return answer(command, serve);
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return { controller, store, calls, serve, sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]) };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const review = store => selectWorkflowPublicationModal(store.getState(), 110, 40);
const texts = lines => lines.map(line => line.text);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const type = (h, text) => h.controller.editWorkflowPublicationField({ type: "insert", text });
/** Empty the focused field of the review. */
function clear(h) {
    h.controller.editWorkflowPublicationField({ type: "edge", edge: "end" });
    for (let i = 0; i < 500; i++) {
        const modal = modalOf(h.store);
        if (!String(modal[modal.field === "vars" ? "vars" : "inputs"] ?? "").length) return;
        h.controller.editWorkflowPublicationField({ type: "backspace" });
    }
}
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

async function reviewing(initial, answers = []) {
    const h = await opened(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    return h;
}

test("the view says what P reviews; the review shows exactly the revision and hash; ctrl-p asks first, then publishes only that revision", async () => {
    const h = await opened(workflow(), [accepted("publish", 2)]);
    assert.ok(details(h.store).includes("Publication: draft revision 2 — P reviews: publish only or publish and start"), details(h.store).join("\n"));
    const view = modalOf(h.store);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    const opener = modalOf(h.store);
    assert.equal(opener.type, "workflowPublish");
    assert.deepEqual(opener.returnModal, view);
    assert.deepEqual(opener.pin, { state: "draft", revision: 2, definitionHash: hashOf(2) });
    assert.equal(statusOf(h.store), "Publish review — ctrl-p publish only · ctrl-r publish and start (each asks first) · Esc back");
    const shown = review(h.store);
    assert.equal(shown.title, "Publish review · revision 2");
    assert.deepEqual(texts(shown.lines).slice(0, 5), ["Definition: watch-v2 1.0.0", "Revision: 2", `Definition hash: ${hashOf(2)}`, "Validity: Valid",
        "Live effects: Only when its live run starts"]);
    // The review's evidence rows, as the portal's (mock M03): no named agent here, and no test of this revision (none is required).
    assert.deepEqual(texts(shown.lines).slice(5, 7), ["Agents: None: no step runs a named agent", "Tests of this revision: None run. Publishing does not require a test"]);
    assert.ok(joined(shown.lines).includes("Publishing freezes this exact revision: it no longer changes, and a new version needs a new workflow. "
        + "Publication starts no run, approves no repository write and grants no tool."));
    assert.ok(texts(shown.lines).includes("ctrl-p Publish only"));
    assert.ok(texts(shown.lines).includes("ctrl-r Publish and start"));
    assert.deepEqual([shown.fields, shown.field, shown.inputs, shown.vars, shown.changed], [true, "inputs", "{}", "", false]);
    assert.equal(shown.hint, "ctrl-p publish only · ctrl-r publish and start · Tab inputs/variables · Esc back — each asks first");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    let confirm = modalOf(h.store);
    assert.equal(confirm.type, "confirm");
    assert.equal(confirm.title, "Publish Revision 2");
    assert.equal(confirm.confirmLabel, "Publish");
    assert.equal(confirm.message, `Publish revision 2 of watch-v2 1.0.0 (definition hash ${hashOf(2).slice(0, 12)}…)? It no longer changes afterwards, `
        + "and no run starts. Publication approves no repository write and grants no tool.");
    assert.deepEqual(confirm.workflowRunCommand, { sessionId: "wf", operation: "publish", runId: null, expectedRevision: 2, definitionHash: hashOf(2) });
    assert.equal(confirm.returnModal.type, "workflowPublish");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(modalOf(h.store).type, "workflowPublish", "back to the review");
    assert.equal(statusOf(h.store), "Publish was not sent");
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    confirm = modalOf(h.store);
    assert.equal(confirm.type, "confirm");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-publish-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "publish", expected_revision: 2, definition_hash: hashOf(2) });
    assert.equal(statusOf(h.store), "Published revision 2. It no longer changes; its live run starts only when someone starts it.");
    assert.deepEqual(modalOf(h.store), view, "accepted: back to the workflow view");
    await settle();
    assert.ok(details(h.store).includes("Publication: published revision 2, no live run yet — P reviews: start live run"), details(h.store).join("\n"));
});

test("ctrl-r publishes and starts the live run with the typed inputs and initial variables, after a confirm that names them", async () => {
    const h = await reviewing(workflow(), [accepted("publish_and_start", 2, LIVE)]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": "pilotswarm", "limit": 3}');
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, '{"note": "first"}');
    const shown = review(h.store);
    assert.deepEqual([shown.field, shown.inputs, shown.vars], ["vars", '{"repo": "pilotswarm", "limit": 3}', '{"note": "first"}']);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirm = modalOf(h.store);
    assert.equal(confirm.title, "Publish and Start Revision 2");
    assert.equal(confirm.confirmLabel, "Publish and Start");
    assert.equal(confirm.message, `Publish revision 2 of watch-v2 1.0.0 (definition hash ${hashOf(2).slice(0, 12)}…) and start its live run with inputs `
        + '{"repo":"pilotswarm","limit":3} and initial variables {"note":"first"}? It no longer changes afterwards, and the live run\'s effects are real.');
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-publish_and_start-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "publish_and_start", expected_revision: 2, definition_hash: hashOf(2),
        inputs: { repo: "pilotswarm", limit: 3 }, vars: { note: "first" } });
    assert.equal(statusOf(h.store), "Published revision 2 and started its live run run-li…0001.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
    assert.ok(!details(h.store).some(line => line.startsWith("Publication:")), "a workflow with its live run offers no more publication");
});

test("what is typed is checked first: the inputs and initial variables must be JSON objects; nothing is sent and the text stays", async () => {
    const h = await reviewing(workflow());
    const errorOf = () => modalOf(h.store).error;
    clear(h);
    type(h, "[1]");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(errorOf(), 'Inputs must be a JSON object, for example {"repo": "name"}.');
    assert.equal(statusOf(h.store), errorOf());
    assert.ok(joined(review(h.store).lines).includes('Inputs must be a JSON object, for example {"repo": "name"}.'));
    type(h, " ");
    assert.equal(errorOf(), null, "typing clears the message");
    clear(h);
    type(h, "{bad");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.match(errorOf(), /^Inputs must be a JSON object: /);
    clear(h);
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, "3");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(errorOf(), 'Initial variables must be a JSON object, for example {"repo": "name"}.');
    assert.equal(modalOf(h.store).type, "workflowPublish", "no confirm");

    // Publish only takes no inputs: they are not checked, and the confirm still asks first.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(modalOf(h.store).type, "confirm");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    const kept = modalOf(h.store);
    assert.deepEqual([kept.type, kept.inputs, kept.vars], ["workflowPublish", "", "3"]);

    // The fields edit as text: the cursor, Home and End, a pasted line break as a space.
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, "{}");
    h.controller.editWorkflowPublicationField({ type: "move", chars: -1 });
    type(h, '"a":\r\n1');
    h.controller.editWorkflowPublicationField({ type: "edge", edge: "start" });
    h.controller.editWorkflowPublicationField({ type: "backspace" });
    const fields = modalOf(h.store);
    assert.deepEqual([fields.field, fields.inputs, fields.inputsCursor], ["inputs", '{"a": 1}', 0]);
    assert.deepEqual(h.sent(), []);
});

test("an action not available now is not sent and the review says why: compile errors, a viewer the portal refuses, another command being sent", async () => {
    const broken = await opened(workflow({ valid: false, diagnostics: [{ severity: "error", code: "STATE_UNKNOWN", path: "states.poll", message: "No state." }] }));
    assert.ok(details(broken.store).includes("Publication: draft revision 2 (it has errors) — P reviews: publish only or publish and start"));
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    assert.equal(modalOf(broken.store).type, "workflowPublish", "offered, so the review says why its actions are not available");
    let shown = review(broken.store);
    assert.deepEqual(shown.lines.find(line => line.text.startsWith("Validity")), { text: "Validity: 1 error: it cannot be published", color: "red" });
    const why = "Revision 2 has 1 error and cannot be published; fix them first.";
    assert.ok(texts(shown.lines).includes(`ctrl-p Publish only — not now: ${why}`));
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(broken.store), `Publish only is not available now. ${why}`);
    assert.equal(modalOf(broken.store).type, "workflowPublish");

    const viewer = { allowed: false, reason: "You may read this workflow but not command it." };
    const denied = await reviewing(workflow({ viewer }));
    await denied.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(denied.store), "Publish and start is not available now. You may read this workflow but not command it.");
    assert.equal(modalOf(denied.store).error, "Publish and start is not available now. You may read this workflow but not command it.");

    const busy = await reviewing(workflow());
    busy.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { runCommand: { operation: "pause", runId: "run-x", operationId: "op-1", args: null,
        phase: "pending", message: null, code: null } } });
    shown = review(busy.store);
    assert.equal(shown.busy, true);
    await busy.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(busy.store), "Publish only is not available now. Another command for this workflow is being sent.");
    for (const h of [broken, denied, busy]) assert.deepEqual(h.sent(), []);
});

test("the review is not offered in an agent state's subtree, for a workflow with its live run, or without person commands", async () => {
    const refusedWith = async (initial, reason) => {
        const h = await opened(initial);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
        assert.equal(modalOf(h.store).type, "workflowView");
        assert.equal(statusOf(h.store), `Publication cannot be reviewed here. ${reason}`);
        assert.ok(!details(h.store).some(line => line.startsWith("Publication:")), reason);
        assert.deepEqual(h.sent(), []);
    };
    await refusedWith(workflow({ operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" } }), `${SUBTREE} Its controlling agent is session parent-1.`);
    await refusedWith(workflow({ state: "published", liveRun: true }), "This workflow has its live run; a new live run needs a new workflow.");
    await refusedWith(workflow({ commands: false }), "This deployment takes no workflow commands from people.");
});

test("a stale revision is refused and read again: the review says it changed and sends nothing for it; ctrl-l reviews the new one, keeping the inputs", async () => {
    const h = await reviewing(workflow(), [refused(409, "REVISION_CONFLICT", "The draft is at revision 3, not 2."), accepted("publish_and_start", 3, LIVE)]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": "a"}');
    // Someone saved revision 3 meanwhile; the view still shows revision 2.
    h.serve(workflow({ revision: 3 }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.sent()[0].expected_revision, 2);
    assert.equal(statusOf(h.store), "Publish and start was refused: The draft is at revision 3, not 2.");
    await settle();
    let shown = review(h.store);
    assert.equal(modalOf(h.store).type, "workflowPublish", "the review stays");
    assert.equal(shown.changed, true);
    const change = `The workflow now shows revision 3 (definition hash ${hashOf(3).slice(0, 12)}…); this review is of revision 2, so nothing is sent for it. `
        + "ctrl-l reviews revision 3.";
    assert.ok(joined(shown.lines).includes(change), joined(shown.lines));
    assert.ok(joined(shown.lines).includes("! Publish and start was refused: The draft is at revision 3, not 2."));
    assert.ok(!texts(shown.lines).some(line => line.startsWith("ctrl-")), "no action is offered for the old revision");
    assert.equal(shown.hint, "ctrl-l review it as it is now · Esc back");
    assert.equal(modalOf(h.store).inputs, '{"repo": "a"}');

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(h.store), change);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    assert.equal(h.sent().length, 1);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "Reviewing revision 3 as it is now");
    shown = review(h.store);
    assert.equal(shown.title, "Publish review · revision 3");
    assert.ok(texts(shown.lines).includes(`Definition hash: ${hashOf(3)}`));
    assert.equal(shown.inputs, '{"repo": "a"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "This review already shows the workflow as it is now");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(modalOf(h.store).title, "Publish and Start Revision 3");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second] = h.sent();
    assert.deepEqual(without(second, "operation_id"), { operation: "publish_and_start", expected_revision: 3, definition_hash: hashOf(3), inputs: { repo: "a" } });
    assert.notEqual(second.operation_id, first.operation_id);
    assert.equal(statusOf(h.store), "Published revision 3 and started its live run run-li…0001.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("a draft published elsewhere while the review is open: nothing is sent for the draft; ctrl-l reviews the published definition, and ctrl-r starts its live run", async () => {
    const h = await reviewing(workflow(), [accepted("start", 2, LIVE)]);
    const view = modalOf(h.store).returnModal;
    h.serve(workflow({ state: "published" }));
    await h.controller.ensureWorkflowReadModel("wf", { force: true });
    const change = "The workflow was published meanwhile (revision 2); this review is of draft revision 2, so nothing is sent for it. "
        + "ctrl-l reviews the workflow as it is now.";
    assert.ok(joined(review(h.store).lines).includes(change));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(h.store), change);
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "Reviewing published revision 2 as it is now");
    const shown = review(h.store);
    assert.equal(shown.title, "Start the live run · published revision 2");
    assert.deepEqual(texts(shown.lines).slice(0, 4), ["Definition: watch-v2 1.0.0", "Published revision: 2", `Definition hash: ${hashOf(2)}`,
        "Live effects: Only when its live run starts"]);
    assert.ok(joined(shown.lines).includes("Starting runs the published revision with real effects. A workflow has one live run."));
    assert.ok(texts(shown.lines).includes("ctrl-r Start live run"));
    assert.equal(shown.hint, "ctrl-r start live run · Tab inputs/variables · Esc back — each asks first");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(h.store), "Publish only is not offered here.");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirm = modalOf(h.store);
    assert.deepEqual([confirm.title, confirm.confirmLabel], ["Start the Live Run", "Start"]);
    assert.equal(confirm.message, `Start the live run of published revision 2 of watch-v2 1.0.0 (definition hash ${hashOf(2).slice(0, 12)}…) with inputs {}? `
        + "Its effects are real, and a workflow has one live run.");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-start-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "start", definition_hash: hashOf(2), inputs: {} });
    assert.equal(statusOf(h.store), "Started the live run run-li…0001 of published revision 2.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("a refusal keeps what was typed, with the schema's problems; while a command is sent nothing else is; an answer that never came is sent again as itself", async () => {
    let lose;
    const h = await reviewing(workflow(), [
        refused(422, "WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.", [{ path: "/repo", message: "must be string" }]),
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
        accepted("publish_and_start", 2, LIVE),
    ]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": 5}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const schema = "Publish and start was refused: Workflow inputs do not match inputs.schema. /repo: must be string.";
    assert.equal(statusOf(h.store), schema);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    assert.equal(modalOf(h.store).inputs, '{"repo": 5}');
    assert.ok(joined(review(h.store).lines).includes(`! ${schema}`));

    clear(h);
    type(h, '{"repo": "five"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirming = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    let shown = review(h.store);
    assert.equal(modalOf(h.store).type, "workflowPublish", "the review shows the command being sent");
    assert.equal(shown.busy, true);
    assert.ok(texts(shown.lines).includes("ctrl-r Publishing…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(h.store), "Publish and start is not available now. This command is being sent.");
    assert.equal(h.sent().length, 2);

    lose();
    await confirming;
    const lost = "Publish and start may not have reached the workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lost);
    assert.equal(modalOf(h.store).error, null, "the review's own earlier message gives way to the notice");
    shown = review(h.store);
    assert.ok(joined(shown.lines).includes(`! ${lost}`));
    assert.ok(joined(shown.lines).includes("The same key sends the same command again once you confirm it; the server applies it once."));
    assert.equal(shown.inputs, '{"repo": "five"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second, third] = h.sent();
    assert.notEqual(second.operation_id, first.operation_id);
    assert.deepEqual(third, second, "the same command, with the same operation id");
    assert.equal(statusOf(h.store), "Published revision 2 and started its live run run-li…0001.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("Esc closes the review back to the view; nothing is sent", async () => {
    const h = await reviewing(workflow());
    const view = modalOf(h.store).returnModal;
    type(h, "x");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Closed the publication review");
    assert.deepEqual(h.sent(), []);
});

test("the review's pin, its change and its confirm text", () => {
    const draftModel = { state: "draft", name: "watch-v2", semver: "1.0.0", revision: 4, definitionHash: hashOf(4), publishedRevision: null,
        publishedDefinitionHash: null, controls: [] };
    const publishedModel = { ...draftModel, state: "published", publishedRevision: 4, publishedDefinitionHash: hashOf(4) };
    assert.equal(workflowPublicationPin(null), null);
    assert.deepEqual(workflowPublicationPin(draftModel), { state: "draft", revision: 4, definitionHash: hashOf(4) });
    assert.deepEqual(workflowPublicationPin(publishedModel), { state: "published", revision: 4, definitionHash: hashOf(4) });
    assert.equal(workflowPublicationChange(workflowPublicationPin(draftModel), draftModel), null);
    assert.equal(workflowPublicationChange(workflowPublicationPin(draftModel), null),
        "The workflow can no longer be published or started here, so nothing is sent. Esc goes back.");
    assert.match(workflowPublicationChange(null, draftModel), /^The workflow now shows revision 4 /);
    const big = workflowPublicationConfirm("publish_and_start", workflowPublicationPin(draftModel), draftModel, { inputs: { text: "x".repeat(400) } });
    const quoted = big.message.slice(big.message.indexOf("with inputs ") + "with inputs ".length, big.message.indexOf("? It no longer"));
    assert.equal(quoted.length, 160);
    assert.ok(quoted.endsWith("…"));
    assert.ok(!big.message.includes("initial variables"), "no variables, none named");
});
